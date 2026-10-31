/**
 * Creates documents from reviewed entries.
 */
import { buildDocument } from './builders.mjs';
import { collectCandidates, linkText, matchGroup, normalize, resolveUuid } from './linker.mjs';
import { MODULE_ID, getPdfFolder, registerAttributionSource } from './settings.mjs';

const DOCUMENT_FOR_KIND = {
    adversary: 'Actor',
    environment: 'Actor',
    weapon: 'Item',
    armor: 'Item',
    journal: 'JournalEntry'
};

/** Import order: adversaries first so environments can link them, the journal last so it can link everything. */
const ORDER = ['adversary', 'weapon', 'armor', 'environment', 'journal'];

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

    for (const [done, entry] of sorted.entries()) {
        try {
            const links = entry.kind === 'environment' ? environmentLinks(entry, index, createdById) : {};
            const { documentName, data } = buildDocument(entry, {
                attribution,
                pdfSrc,
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
            const doc = await CONFIG[documentName].documentClass.create(data, pack ? { pack } : {});
            created.push(doc);
            createdById.set(entry.id, doc);
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
