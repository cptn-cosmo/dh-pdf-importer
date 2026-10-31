import { extractPdf, loadFoundryPdfjs } from '../pdf/extract.mjs';
import { parseDocument } from '../parsers/index.mjs';
import { attributionFor } from '../builders.mjs';
import { FOLDER_MODES, documentNameFor, importEntries } from '../importer.mjs';
import { SYSTEM_PACK, collectCandidates, linkText, matchGroup, normalize } from '../linker.mjs';
import { MODULE_ID, allAttributionSources, getImportOptions, setImportOptions } from '../settings.mjs';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

const KINDS = ['adversary', 'environment', 'weapon', 'armor', 'journal'];

const signed = value => (value == null ? '' : value >= 0 ? `+${value}` : `${value}`);

/**
 * Lets a GM pick a PDF, review everything that was recognised in it and import a selection.
 */
export default class PdfImporter extends HandlebarsApplicationMixin(ApplicationV2) {
    /** @type {'select'|'loading'|'review'|'importing'} */
    stage = 'select';

    /** @type {{label: string, value: number, total: number}} */
    progress = { label: '', value: 0, total: 1 };

    /** @type {object|null} Parse result */
    result = null;

    fileName = '';

    /** @type {{source: string, artist: string, pageOffset: number}} */
    attribution = { source: '', artist: '', pageOffset: 0 };

    /** Entry kind -> "world" or a compendium collection id. */
    destinations = Object.fromEntries(KINDS.map(kind => [kind, 'world']));

    folders = { mode: 'source', separateKinds: true };

    constructor(options) {
        super(options);
        const saved = getImportOptions();
        Object.assign(this.destinations, saved.destinations);
        Object.assign(this.folders, saved.folders);
        if (!FOLDER_MODES.includes(this.folders.mode)) this.folders.mode = 'source';
    }

    filter = 'all';

    search = '';

    static DEFAULT_OPTIONS = {
        id: 'dh-pdf-importer',
        tag: 'div',
        classes: ['dh-pdf-importer'],
        window: { title: 'DHPI.Title', icon: 'fa-solid fa-file-pdf', resizable: true },
        position: { width: 980, height: 760 },
        actions: {
            chooseLocal: PdfImporter.#onChooseLocal,
            browseServer: PdfImporter.#onBrowseServer,
            selectAll: PdfImporter.#onSelectAll,
            selectNone: PdfImporter.#onSelectNone,
            setFilter: PdfImporter.#onSetFilter,
            toggleGroup: PdfImporter.#onToggleGroup,
            back: PdfImporter.#onBack,
            import: PdfImporter.#onImport
        }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/importer.hbs`, scrollable: ['.dhpi-results'] }
    };

    /* -------------------------------------------- */
    /*  Rendering                                   */
    /* -------------------------------------------- */

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.stage = this.stage;
        context.progress = {
            ...this.progress,
            percent: Math.round((this.progress.value / Math.max(1, this.progress.total)) * 100)
        };
        if (this.stage !== 'review') return context;

        const entries = this.result.entries;
        context.fileName = this.fileName;
        context.attribution = this.attribution;
        context.sources = allAttributionSources();
        context.filter = this.filter;
        context.search = this.search;
        context.warnings = this.#documentWarnings();
        context.total = entries.length;
        context.selectedCount = entries.filter(e => e.selected).length;

        context.filters = [
            { key: 'all', label: game.i18n.localize('DHPI.Filter.all'), count: entries.length, active: this.filter === 'all' },
            ...KINDS.map(kind => ({
                key: kind,
                label: game.i18n.localize(`DHPI.Kind.${kind}.plural`),
                count: entries.filter(e => e.kind === kind).length,
                active: this.filter === kind
            })).filter(f => f.count)
        ];

        context.groups = KINDS.map(kind => {
            const list = entries.filter(e => e.kind === kind);
            return {
                kind,
                label: game.i18n.localize(`DHPI.Kind.${kind}.plural`),
                icon: this.#iconFor(kind),
                hidden: this.filter !== 'all' && this.filter !== kind,
                selected: list.filter(e => e.selected).length,
                count: list.length,
                entries: list.map(entry => this.#prepareEntry(entry))
            };
        }).filter(g => g.count);

        // One destination per kind present in the PDF; compendiums that no longer exist fall back to the world.
        context.destinations = KINDS.filter(kind => entries.some(e => e.kind === kind)).map(kind => {
            const documentName = documentNameFor(kind);
            const packs = game.packs.filter(p => p.documentName === documentName && !p.locked);
            if (this.destinations[kind] !== 'world' && !packs.some(p => p.collection === this.destinations[kind])) {
                this.destinations[kind] = 'world';
            }
            return {
                kind,
                icon: this.#iconFor(kind),
                label: game.i18n.localize(`DHPI.Kind.${kind}.plural`),
                value: this.destinations[kind],
                options: [
                    { value: 'world', label: game.i18n.localize('DHPI.Destination.world') },
                    ...packs.map(p => ({ value: p.collection, label: `${p.title} (${p.metadata.packageName})` }))
                ]
            };
        });
        context.folders = {
            ...this.folders,
            modes: FOLDER_MODES.map(mode => ({ value: mode, label: game.i18n.localize(`DHPI.Folders.mode.${mode}`) }))
        };
        context.folderExample = this.#folderExample();
        return context;
    }

    /**
     * Preview of the links an environment will get: matched potential adversaries and names in feature text.
     */
    #environmentLinks(entry) {
        const index = this.linkIndex;
        const origin = candidate => {
            if (candidate.entryId) return game.i18n.localize('DHPI.Links.thisPdf');
            if (candidate.priority === 1) return game.i18n.localize('DHPI.Links.world');
            if (candidate.priority === 2) return game.i18n.localize('DHPI.Links.system');
            return candidate.uuid?.split('.').slice(1, 3).join('.') ?? '';
        };
        const allowed = new Set();
        let matched = 0;
        let total = 0;
        const groups = entry.potentialAdversaries.map(group => {
            const names = (index ? matchGroup(index, group) : group.names.map(name => ({ name, matches: [] }))).map(({ name, matches }) => {
                const generic = /^(any|all|see\b)/i.test(name);
                if (!generic) total++;
                if (matches.length) matched++;
                for (const m of matches) allowed.add(normalize(m[0].name));
                return {
                    name,
                    generic,
                    links: matches.map(m => ({ name: m[0].name, origin: origin(m[0]) }))
                };
            });
            return { label: group.group ?? '', names };
        });
        return {
            groups,
            summary: index ? game.i18n.format('DHPI.Links.summary', { matched, total }) : '',
            linkFeature: html =>
                index
                    ? linkText(html, index, {
                          allowed,
                          link: (candidates, text) =>
                              `<span class="dhpi-link" data-tooltip="${candidates[0].name} · ${origin(candidates[0])}"><i class="fa-solid fa-link" inert></i> ${text}</span>`
                      })
                    : html
        };
    }

    /** A sample folder path shown under the folder options. */
    #folderExample() {
        const { mode, separateKinds } = this.folders;
        if (mode === 'none') return game.i18n.localize('DHPI.Folders.noFolders');
        const sample = this.result.entries.find(e => e.kind !== 'journal') ?? this.result.entries[0];
        const parts = [this.attribution.source || game.i18n.localize('DHPI.DefaultFolder')];
        if (sample && sample.kind !== 'journal') {
            if (separateKinds) parts.push(game.i18n.localize(`DHPI.Kind.${sample.kind}.plural`));
            if (mode === 'tier' || mode === 'tierType') parts.push(game.i18n.format('DHPI.TierLabel', { tier: sample.tier }));
            if ((mode === 'type' || mode === 'tierType') && sample.kind !== 'armor') {
                parts.push(sample.kind === 'weapon'
                    ? game.i18n.localize(sample.secondary ? 'DHPI.SecondaryWeapon' : 'DHPI.PrimaryWeapon')
                    : game.i18n.localize((sample.kind === 'adversary' ? CONFIG.DH.ACTOR.adversaryTypes : CONFIG.DH.ACTOR.environmentTypes)[sample.type]?.label ?? sample.type));
            }
        }
        return parts.join(' › ');
    }

    #iconFor(kind) {
        return {
            adversary: 'fa-solid fa-dragon',
            environment: 'fa-solid fa-mountain-sun',
            weapon: 'fa-solid fa-khanda',
            armor: 'fa-solid fa-shield-halved',
            journal: 'fa-solid fa-book-open'
        }[kind];
    }

    #documentWarnings() {
        const warnings = [];
        if (this.result.warnings.includes('noText')) warnings.push(game.i18n.localize('DHPI.Warning.noText'));
        else if (this.result.emptyPages.length) {
            warnings.push(game.i18n.format('DHPI.Warning.emptyPages', { pages: this.result.emptyPages.join(', ') }));
        }
        if (!this.result.entries.length && !this.result.warnings.includes('noText')) {
            warnings.push(game.i18n.localize('DHPI.Warning.nothingFound'));
        }
        return warnings;
    }

    /** Presentation data for a single preview card. */
    #prepareEntry(entry) {
        const attribution = attributionFor(this.attribution, entry.page);
        const base = {
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            selected: entry.selected,
            page: attribution.page,
            warnings: entry.warnings ?? [],
            searchText: `${entry.name} ${entry.kind} ${entry.type ?? ''}`.toLowerCase()
        };
        const rangeLabel = range => (range ? game.i18n.localize(`DAGGERHEART.CONFIG.Range.${range}.name`) : '');
        const features = entry.features?.map(f => ({
            name: f.name,
            form: game.i18n.localize(`DAGGERHEART.CONFIG.FeatureForm.${f.form}`),
            formKey: f.form,
            description: f.description,
            costs: f.costs.map(c => `${c.value} ${game.i18n.localize(`DHPI.Resource.${c.key}`)}`).join(', ')
        }));

        switch (entry.kind) {
            case 'adversary': {
                const type = CONFIG.DH.ACTOR.adversaryTypes[entry.type];
                const attack = entry.attack;
                return {
                    ...base,
                    subtitle: `${game.i18n.format('DHPI.TierLabel', { tier: entry.tier })} ${type ? game.i18n.localize(type.label) : entry.type}${entry.hordeHP ? ` (${entry.hordeHP}/HP)` : ''}`,
                    description: entry.description,
                    motives: entry.motives,
                    stats: [
                        { label: game.i18n.localize('DAGGERHEART.GENERAL.difficulty'), value: entry.difficulty ?? '—' },
                        {
                            label: game.i18n.localize('DHPI.Thresholds'),
                            value: `${entry.thresholds.major ?? '—'} / ${entry.thresholds.severe ?? '—'}`
                        },
                        { label: game.i18n.localize('DHPI.HP'), value: entry.hp ?? '—' },
                        { label: game.i18n.localize('DHPI.Stress'), value: entry.stress ?? '—' }
                    ],
                    attack: attack
                        ? `${signed(attack.bonus)} · ${attack.name} · ${rangeLabel(attack.range)} · ${attack.damage?.formula ?? '?'} ${game.i18n.localize(`DHPI.DamageType.${attack.damageType}`)}`
                        : null,
                    experiences: entry.experiences.map(e => `${e.name} ${signed(e.value)}`).join(', '),
                    hordeDamage: entry.hordeDamage,
                    features
                };
            }
            case 'environment': {
                const type = CONFIG.DH.ACTOR.environmentTypes[entry.type];
                const links = this.#environmentLinks(entry);
                return {
                    ...base,
                    subtitle: `${game.i18n.format('DHPI.TierLabel', { tier: entry.tier })} ${type ? game.i18n.localize(type.label) : entry.typeText}`,
                    description: entry.description,
                    impulses: entry.impulses,
                    stats: [{ label: game.i18n.localize('DAGGERHEART.GENERAL.difficulty'), value: entry.difficulty ?? game.i18n.localize('DHPI.Special') }],
                    adversaryGroups: links.groups,
                    linkSummary: links.summary,
                    features: features.map((f, i) => ({ ...f, description: links.linkFeature(entry.features[i].description) }))
                };
            }
            case 'weapon':
                return {
                    ...base,
                    name: entry.variantLabel ? `${entry.name} (${entry.variantLabel})` : entry.name,
                    subtitle: `${game.i18n.format('DHPI.TierLabel', { tier: entry.tier })} ${game.i18n.localize(entry.secondary ? 'DHPI.SecondaryWeapon' : 'DHPI.PrimaryWeapon')}`,
                    secondary: entry.secondary,
                    stats: [
                        { label: game.i18n.localize('DHPI.Trait'), value: entry.trait ? game.i18n.localize(`DAGGERHEART.CONFIG.Traits.${entry.trait}.name`) : '—' },
                        { label: game.i18n.localize('DHPI.Range'), value: rangeLabel(entry.range) || '—' },
                        { label: game.i18n.localize('DHPI.Damage'), value: `${entry.damage?.formula ?? '?'} ${game.i18n.localize(`DHPI.DamageType.${entry.damageType}`)}` },
                        { label: game.i18n.localize('DHPI.Burden'), value: game.i18n.localize(`DAGGERHEART.CONFIG.Burden.${entry.burden}`) }
                    ],
                    description: entry.description
                };
            case 'armor':
                return {
                    ...base,
                    name: entry.variantLabel ? `${entry.name} (${entry.variantLabel})` : entry.name,
                    subtitle: game.i18n.format('DHPI.TierLabel', { tier: entry.tier }),
                    stats: [
                        { label: game.i18n.localize('DHPI.Thresholds'), value: `${entry.thresholds.major} / ${entry.thresholds.severe}` },
                        { label: game.i18n.localize('DHPI.ArmorScore'), value: entry.score }
                    ],
                    description: entry.description
                };
            case 'journal':
                return {
                    ...base,
                    subtitle: game.i18n.format('DHPI.JournalPages', { count: entry.pages.length }),
                    pages: entry.pages.map(p => ({ name: p.name, page: attributionFor(this.attribution, p.page).page }))
                };
        }
        return base;
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        // Drag & drop of a PDF onto the drop zone.
        const drop = html.querySelector('.dhpi-dropzone');
        if (drop) {
            drop.addEventListener('dragover', event => {
                event.preventDefault();
                drop.classList.add('dragging');
            });
            drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
            drop.addEventListener('drop', event => {
                event.preventDefault();
                drop.classList.remove('dragging');
                const file = [...(event.dataTransfer?.files ?? [])].find(f => /\.pdf$/i.test(f.name));
                if (file) this.#loadFile(file);
                else ui.notifications.warn('DHPI.Warning.notPdf', { localize: true });
            });
        }
        html.querySelector('input[type=file]')?.addEventListener('change', event => {
            const file = event.target.files?.[0];
            if (file) this.#loadFile(file);
        });

        if (this.stage !== 'review') return;

        // Selection and edits update state in place so the scroll position and open details survive.
        for (const box of html.querySelectorAll('input[data-select]')) {
            box.addEventListener('change', event => {
                const entry = this.#entry(event.target.dataset.select);
                entry.selected = event.target.checked;
                event.target.closest('.dhpi-card').classList.toggle('deselected', !entry.selected);
                this.#refreshCounts();
            });
        }
        for (const input of html.querySelectorAll('input[data-rename]')) {
            input.addEventListener('change', event => {
                const entry = this.#entry(event.target.dataset.rename);
                const value = event.target.value.trim();
                if (value) entry.name = value.replace(/\s*\((Tier \d)\)$/, '');
            });
        }
        for (const box of html.querySelectorAll('input[data-secondary]')) {
            box.addEventListener('change', event => {
                const entry = this.#entry(event.target.dataset.secondary);
                entry.secondary = event.target.checked;
                const subtitle = event.target.closest('.dhpi-card').querySelector('.dhpi-subtitle');
                subtitle.textContent = `${game.i18n.format('DHPI.TierLabel', { tier: entry.tier })} ${game.i18n.localize(entry.secondary ? 'DHPI.SecondaryWeapon' : 'DHPI.PrimaryWeapon')}`;
            });
        }
        for (const input of html.querySelectorAll('[data-attribution]')) {
            input.addEventListener('change', event => {
                const key = event.target.dataset.attribution;
                this.attribution[key] = key === 'pageOffset' ? Number(event.target.value) || 0 : event.target.value;
                if (key !== 'artist') this.render();
            });
        }
        for (const select of html.querySelectorAll('select[data-destination]')) {
            select.addEventListener('change', event => (this.destinations[event.target.dataset.destination] = event.target.value));
        }
        html.querySelector('select[name=folderMode]')?.addEventListener('change', event => {
            this.folders.mode = event.target.value;
            this.render();
        });
        html.querySelector('input[name=separateKinds]')?.addEventListener('change', event => {
            this.folders.separateKinds = event.target.checked;
            this.render();
        });
        const search = html.querySelector('input[name=search]');
        search?.addEventListener('input', event => {
            this.search = event.target.value;
            this.#applySearch();
        });
        this.#applySearch();
    }

    #entry(id) {
        return this.result.entries.find(e => e.id === id);
    }

    #applySearch() {
        const query = this.search.trim().toLowerCase();
        for (const card of this.element.querySelectorAll('.dhpi-card')) {
            card.classList.toggle('filtered', !!query && !card.dataset.search.includes(query));
        }
    }

    #refreshCounts() {
        const entries = this.result.entries;
        const selected = entries.filter(e => e.selected).length;
        const button = this.element.querySelector('[data-action=import]');
        if (button) {
            button.disabled = !selected;
            button.querySelector('span').textContent = game.i18n.format('DHPI.ImportSelected', { count: selected });
        }
        for (const group of this.element.querySelectorAll('.dhpi-group')) {
            const list = entries.filter(e => e.kind === group.dataset.kind);
            group.querySelector('.dhpi-group-count').textContent = `${list.filter(e => e.selected).length} / ${list.length}`;
            group.querySelector('[data-action=toggleGroup]').checked = list.every(e => e.selected);
        }
    }

    /** Entries matching the current filter and search. */
    #visibleEntries() {
        const query = this.search.trim().toLowerCase();
        return this.result.entries.filter(e => {
            if (this.filter !== 'all' && e.kind !== this.filter) return false;
            return !query || `${e.name} ${e.kind} ${e.type ?? ''}`.toLowerCase().includes(query);
        });
    }

    /* -------------------------------------------- */
    /*  Loading                                     */
    /* -------------------------------------------- */

    /** @param {File} file */
    async #loadFile(file) {
        await this.#load(file.name, await file.arrayBuffer());
    }

    async #load(fileName, buffer) {
        this.fileName = fileName;
        this.stage = 'loading';
        this.progress = { label: game.i18n.localize('DHPI.Progress.reading'), value: 0, total: 1 };
        await this.render();
        try {
            const pdfjs = await loadFoundryPdfjs();
            const extracted = await extractPdf(pdfjs, buffer, {
                onProgress: (value, total) => this.#setProgress(game.i18n.format('DHPI.Progress.page', { value, total }), value, total)
            });
            this.result = parseDocument(extracted, { fileName });
            this.#setProgress(game.i18n.localize('DHPI.Progress.matching'), 1, 1);
            this.linkIndex = this.result.entries.some(e => e.kind === 'environment')
                ? await collectCandidates(this.result.entries)
                : null;
            for (const entry of this.result.entries) entry.selected = true;
            this.attribution = { ...this.result.attribution };
            this.filter = 'all';
            this.search = '';
            this.stage = 'review';
        } catch (error) {
            console.error(`${MODULE_ID} |`, error);
            ui.notifications.error(game.i18n.format('DHPI.Error.read', { message: error.message }));
            this.stage = 'select';
        }
        await this.render();
    }

    #setProgress(label, value, total) {
        this.progress = { label, value, total };
        const bar = this.element?.querySelector('.dhpi-progress');
        if (!bar) return;
        bar.querySelector('.dhpi-progress-label').textContent = label;
        bar.querySelector('.dhpi-progress-fill').style.width = `${Math.round((value / Math.max(1, total)) * 100)}%`;
    }

    /* -------------------------------------------- */
    /*  Actions                                     */
    /* -------------------------------------------- */

    static #onChooseLocal() {
        this.element.querySelector('input[type=file]')?.click();
    }

    static async #onBrowseServer() {
        const FilePicker = foundry.applications.apps.FilePicker.implementation;
        const picker = new FilePicker({
            type: 'any',
            callback: async path => {
                if (!/\.pdf$/i.test(path)) return ui.notifications.warn('DHPI.Warning.notPdf', { localize: true });
                const url = /^https?:/i.test(path) ? path : foundry.utils.getRoute(path);
                const response = await fetch(url);
                if (!response.ok) return ui.notifications.error(game.i18n.format('DHPI.Error.read', { message: response.statusText }));
                await this.#load(decodeURIComponent(path.split('/').at(-1)), await response.arrayBuffer());
            }
        });
        picker.browse();
    }

    static #onSelectAll() {
        for (const entry of this.#visibleEntries()) entry.selected = true;
        this.render();
    }

    static #onSelectNone() {
        for (const entry of this.#visibleEntries()) entry.selected = false;
        this.render();
    }

    static #onSetFilter(_event, target) {
        this.filter = target.dataset.filter;
        this.render();
    }

    static #onToggleGroup(_event, target) {
        const kind = target.closest('.dhpi-group').dataset.kind;
        for (const entry of this.result.entries.filter(e => e.kind === kind)) entry.selected = target.checked;
        this.render();
    }

    static #onBack() {
        this.stage = 'select';
        this.result = null;
        this.render();
    }

    static async #onImport() {
        const selected = this.result.entries.filter(e => e.selected);
        if (!selected.length) return;
        await setImportOptions({ destinations: this.destinations, folders: this.folders });
        this.stage = 'importing';
        this.progress = { label: game.i18n.localize('DHPI.Progress.importing'), value: 0, total: selected.length };
        await this.render();

        const { created, failed } = await importEntries(selected, {
            attribution: this.attribution,
            destinations: this.destinations,
            folders: this.folders,
            onProgress: (value, total) => this.#setProgress(game.i18n.format('DHPI.Progress.importItem', { value, total }), value, total)
        });

        if (failed.length) {
            ui.notifications.warn(
                game.i18n.format('DHPI.Result.partial', {
                    created: created.length,
                    failed: failed.length,
                    names: failed.map(f => f.entry.name).join(', ')
                })
            );
            // Keep only what failed selected so the user can retry.
            const failedIds = new Set(failed.map(f => f.entry.id));
            for (const entry of this.result.entries) entry.selected = failedIds.has(entry.id);
            this.stage = 'review';
            return this.render();
        }
        ui.notifications.info(game.i18n.format('DHPI.Result.success', { count: created.length }));
        this.close();
    }
}
