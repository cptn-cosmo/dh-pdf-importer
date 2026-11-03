/**
 * Creates documents from reviewed entries.
 */
import { buildDocument, domainSlug } from './builders.mjs';
import { collectCandidates, linkText, matchGroup, normalize, resolveUuid } from './linker.mjs';
import { MODULE_ID, getPdfFolder, registerAttributionSource } from './settings.mjs';

const DOCUMENT_FOR_KIND = {
    adversary: 'Actor',
    environment: 'Actor',
    weapon: 'Item',
    armor: 'Item',
    ancestry: 'Item',
    community: 'Item',
    class: 'Item',
    subclass: 'Item',
    domainCard: 'Item',
    journal: 'JournalEntry'
};

/**
 * Import order: adversaries first so environments can link them, classes before their subclasses, and
 * the journal last so it can link everything.
 */
const ORDER = ['adversary', 'weapon', 'armor', 'ancestry', 'community', 'class', 'subclass', 'domainCard', 'environment', 'journal'];

export const documentNameFor = kind => DOCUMENT_FOR_KIND[kind];

export const FOLDER_MODES = ['none', 'source', 'tier', 'type', 'tierType'];

/** Label of the "type" folder level for an entry. */
function typeFolderName(entry) {
    switch (entry.kind) {
        case 'adversary': {
            const type = CONFIG.DH.ACTOR.allAdversaryTypes?.()[entry.type] ?? CONFIG.DH.ACTOR.adversaryTypes[entry.type];
            return type ? game.i18n.localize(type.label) : entry.type;
        }
        case 'environment': {
            const type = CONFIG.DH.ACTOR.environmentTypes[entry.type];
            return type ? game.i18n.localize(type.label) : entry.type;
        }
        case 'weapon':
            return game.i18n.localize(entry.secondary ? 'DHPI.SecondaryWeapon' : 'DHPI.PrimaryWeapon');
        case 'subclass':
            return entry.className;
        case 'domainCard':
            return entry.domain;
        default:
            return null;
    }
}

/**
 * The folder names an entry should be placed in, outermost first.
 * @param {object} entry
 * @param {{mode: string, separateKinds: boolean, source: string}} options
 * @returns {string[]}
 */
export function folderPath(entry, { mode, separateKinds, source }) {
    if (mode === 'none') return [];
    const path = [source];
    if (entry.kind === 'journal') return path;
    if (separateKinds) path.push(game.i18n.localize(`DHPI.Kind.${entry.kind}.plural`));
    const tier = entry.tier ? game.i18n.format('DHPI.TierLabel', { tier: entry.tier }) : null;
    const type = typeFolderName(entry);
    if (mode === 'tier' || mode === 'tierType') path.push(tier);
    if (mode === 'type' || mode === 'tierType') path.push(type);
    // Foundry allows at most CONST.FOLDER_MAX_DEPTH levels of folders.
    return path.filter(Boolean).slice(0, CONST.FOLDER_MAX_DEPTH ?? 4);
}

/**
 * Find or create a chain of nested folders in the world or a compendium.
 * @param {string} documentName
 * @param {string|null} pack       Compendium collection id, or null for the world
 * @param {string[]} names
 * @param {Map<string, Folder>} cache
 * @returns {Promise<Folder|null>}
 */
async function getFolderChain(documentName, pack, names, cache) {
    let parent = null;
    for (const [depth, name] of names.entries()) {
        const key = `${pack ?? 'world'}|${documentName}|${names.slice(0, depth + 1).join('/')}`;
        let folder = cache.get(key);
        if (!folder) {
            const collection = pack ? game.packs.get(pack).folders : game.folders;
            folder = collection.find(f => f.type === documentName && f.name === name && (f.folder?.id ?? null) === (parent?.id ?? null));
            folder ??= await CONFIG.Folder.documentClass.create(
                { name, type: documentName, folder: parent?.id ?? null, sorting: 'a' },
                pack ? { pack } : {}
            );
            cache.set(key, folder);
        }
        parent = folder;
    }
    return parent;
}

/* -------------------------------------------- */
/*  Domains and classes                         */
/* -------------------------------------------- */

/** Domain names used by the entries (class domains and domain cards). */
export function domainsUsed(entries) {
    const names = new Map();
    for (const e of entries) {
        for (const d of e.kind === 'class' ? e.domains : e.kind === 'domainCard' ? [e.domain] : []) {
            names.set(d.toLowerCase(), d);
        }
    }
    return [...names.values()];
}

/** The system's domains (built in and homebrew), by lowercase id and label. */
function knownDomains() {
    const known = new Map();
    for (const [id, domain] of Object.entries(CONFIG.DH.DOMAIN.allDomains())) {
        known.set(id.toLowerCase(), id);
        known.set(game.i18n.localize(domain.label).toLowerCase(), id);
    }
    return known;
}

/**
 * Domains that are neither built into the system nor set up as homebrew domains.
 * @param {string[]} names
 */
export function missingDomains(names) {
    const known = knownDomains();
    return names.filter(n => !known.has(n.toLowerCase()) && !known.has(domainSlug(n)));
}

/**
 * Add domains to the system's homebrew settings, as its Homebrew menu does.
 * @param {string[]} names
 */
async function createDomains(names) {
    if (!names.length) return;
    const key = CONFIG.DH.SETTINGS.gameSettings.Homebrew;
    // Work on a copy like the system's Homebrew menu does; the system's onChange then refreshes its config.
    const homebrew = game.settings.get(CONFIG.DH.id, key).toObject();
    for (const label of names) {
        const id = domainSlug(label);
        homebrew.domains[id] = { id, label, src: 'icons/svg/portal.svg' };
    }
    await game.settings.set(CONFIG.DH.id, key, homebrew);
}

/** Map domain names to ids, after creating the missing ones. */
async function domainResolver(entries) {
    const names = domainsUsed(entries);
    if (!names.length) return null;
    await createDomains(missingDomains(names));
    const known = knownDomains();
    return label => known.get(label.toLowerCase()) ?? known.get(domainSlug(label)) ?? domainSlug(label);
}

/**
 * Find classes by name for linking subclasses: classes of this import first, then the world, then compendiums.
 * @param {Map<string, ClientDocument>} createdByName   Classes created in this import, by lowercase name
 */
async function classResolver(createdByName) {
    const existing = new Map();
    for (const item of game.items) if (item.type === 'class') existing.set(item.name.toLowerCase(), item.uuid);
    for (const pack of game.packs.filter(p => p.documentName === 'Item')) {
        try {
            for (const entry of await pack.getIndex({ fields: ['type'] })) {
                if (entry.type === 'class' && !existing.has(entry.name.toLowerCase())) existing.set(entry.name.toLowerCase(), entry.uuid);
            }
        } catch {
            /* unreadable compendium */
        }
    }
    return name => createdByName.get(name?.toLowerCase())?.uuid ?? existing.get(name?.toLowerCase()) ?? null;
}

/**
 * Link an environment's potential adversaries and the adversaries named in its feature text.
 * @param {object} index                         Candidate index from collectCandidates
 * @param {Map<string, ClientDocument>} created  Documents created so far, by entry id
 */
function environmentLinks(entry, index, created) {
    const allowed = new Set();
    const resolveAdversaries = group => {
        const uuids = [];
        for (const { matches } of matchGroup(index, group)) {
            for (const candidates of matches) {
                const uuid = resolveUuid(candidates, created);
                if (!uuid || uuids.includes(uuid)) continue;
                uuids.push(uuid);
                allowed.add(normalize(candidates[0].name));
            }
        }
        return uuids;
    };
    // Resolve the list first: names listed there may be linked in the text even if they are a single word.
    const groups = new Map(entry.potentialAdversaries.map(group => [group, resolveAdversaries(group)]));
    return {
        resolveAdversaries: group => groups.get(group) ?? [],
        linkFeature: html =>
            linkText(html, index, {
                allowed,
                link: (candidates, text) => {
                    const uuid = resolveUuid(candidates, created);
                    return uuid ? `@UUID[${uuid}]{${text}}` : null;
                }
            })
    };
}

/**
 * Import the selected entries.
 * @param {object[]} entries                 Entries chosen by the user
 * @param {object} options
 * @param {{source: string, artist: string, pageOffset: number}} options.attribution
 * @param {Record<string, string>} options.destinations   Entry kind -> "world" or a compendium collection id
 * @param {{mode: string, separateKinds: boolean}} options.folders  Folder organisation
 * @param {string} [options.pdfSrc]          Path of the PDF, for a journal that embeds it
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{created: ClientDocument[], failed: {entry: object, error: Error}[]}>}
 */
export async function importEntries(entries, { attribution, destinations, folders: folderOptions, pdfSrc, onProgress }) {
    const sorted = entries.toSorted((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    const created = [];
    const createdById = new Map();
    const failed = [];
    const folderCache = new Map();
    const source = attribution.source?.trim() || game.i18n.localize('DHPI.DefaultFolder');
    const index = sorted.some(e => e.kind === 'environment') ? await collectCandidates(sorted) : null;
    const resolveDomain = await domainResolver(sorted);
    const classesByName = new Map();
    const resolveClass = sorted.some(e => e.kind === 'subclass') ? await classResolver(classesByName) : null;

    for (const [done, entry] of sorted.entries()) {
        try {
            const links = entry.kind === 'environment' ? environmentLinks(entry, index, createdById) : {};
            const { documentName, data, features, linkFeatures } = buildDocument(entry, {
                attribution,
                pdfSrc,
                resolveDomain,
                resolveClass,
                ...links,
                resolveLink: id => {
                    const doc = createdById.get(id);
                    return doc ? `@UUID[${doc.uuid}]{${doc.name}}` : null;
                }
            });

            const destination = destinations[entry.kind] ?? 'world';
            const pack = destination === 'world' ? null : destination;
            const path = folderPath(entry, { ...folderOptions, source });
            const folder = await getFolderChain(documentName, pack, path, folderCache);
            if (folder) data.folder = folder.id;
            const cls = CONFIG[documentName].documentClass;

            // Options link to their features by UUID, so the feature Items are created first.
            let featureDocs = [];
            if (features?.length) {
                const featurePath = [...path, game.i18n.localize('DHPI.FeaturesFolder')].slice(-(CONST.FOLDER_MAX_DEPTH ?? 4));
                const featureFolder = path.length ? await getFolderChain('Item', pack, featurePath, folderCache) : null;
                const featureData = features.map(f => ({ ...f.data, ...(featureFolder ? { folder: featureFolder.id } : {}) }));
                featureDocs = await cls.createDocuments(featureData, pack ? { pack } : {});
                const linked = featureDocs.map((doc, i) => ({ link: features[i].link, uuid: doc.uuid }));
                foundry.utils.mergeObject(data, foundry.utils.expandObject(linkFeatures(linked)));
            }
            let doc;
            try {
                doc = await cls.create(data, pack ? { pack } : {});
            } catch (error) {
                // Don't leave orphaned features behind.
                if (featureDocs.length) await cls.deleteDocuments(featureDocs.map(d => d.id), pack ? { pack } : {});
                throw error;
            }
            created.push(doc);
            createdById.set(entry.id, doc);
            if (entry.kind === 'class') classesByName.set(entry.name.toLowerCase(), doc);
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to import ${entry.name}`, error);
            failed.push({ entry, error });
        }
        onProgress?.(done + 1, sorted.length);
    }

    if (created.length && attribution.source?.trim()) await registerAttributionSource(attribution.source.trim());
    return { created, failed };
}

/**
 * Upload a PDF chosen from the user's computer into the folder set in the module settings so a journal page can show it.
 * @param {File} file
 * @returns {Promise<string>} Path of the uploaded file
 */
export async function uploadPdf(file) {
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    const directory = getPdfFolder();
    // Create every missing level, since the server only creates one directory at a time.
    const parts = directory.split('/');
    for (const depth of parts.keys()) {
        const path = parts.slice(0, depth + 1).join('/');
        try {
            await FilePicker.browse('data', path);
        } catch {
            await FilePicker.createDirectory('data', path);
        }
    }
    const response = await FilePicker.upload('data', directory, file, {}, { notify: false });
    if (!response?.path) throw new Error(game.i18n.localize('DHPI.Error.upload'));
    return response.path;
}
