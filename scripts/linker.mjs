/**
 * Matches adversary names printed in a PDF ("Guards (Arcanist, Head)", "introduce a Zombie Pack") to
 * adversaries imported from the same PDF, already in the world, or in compendiums (the system's first).
 *
 * The matching itself is independent of Foundry so it can be tested in Node.
 */

/**
 * @typedef {object} Candidate
 * @property {string} name
 * @property {string} [uuid]       Existing document
 * @property {string} [entryId]    Entry of the current import, resolved once it has been created
 * @property {number} priority     Lower wins: 0 this import, 1 world, 2 system compendium, 3 other compendiums
 */

const STOP_WORDS = new Set(['of', 'the', 'a', 'an']);

export const normalize = name =>
    (name ?? '')
        .toLowerCase()
        .replace(/[’'`]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

/** Possible singular forms of a word: "Zombies" -> Zombie, "Harpies" -> Harpy, "Foxes" -> Fox. */
const singulars = word => {
    const forms = new Set([word]);
    if (/s$/i.test(word) && !/ss$/i.test(word)) forms.add(word.slice(0, -1));
    if (/ies$/i.test(word)) forms.add(`${word.slice(0, -3)}y`);
    if (/(?:ss|sh|ch|x)es$/i.test(word)) forms.add(word.slice(0, -2));
    return [...forms];
};

/** Singular forms of a phrase, changing only its last word. */
const singularPhrases = phrase => {
    const words = phrase.split(' ');
    return singulars(words.at(-1)).map(last => [...words.slice(0, -1), last].join(' '));
};

const singular = word => singulars(word).at(1) ?? word;

const wordKey = name =>
    normalize(name)
        .split(' ')
        .filter(w => w && !STOP_WORDS.has(w))
        .map(singular)
        .sort()
        .join(' ');

/**
 * Index candidates by exact name, by bag of words, and by the base name of multi-phase adversaries
 * ("Fallen Warlord: Realm-Breaker" is found by "Fallen Warlord").
 * @param {Candidate[]} candidates
 */
export function buildIndex(candidates) {
    const exact = new Map();
    const words = new Map();
    const phases = new Map();
    const add = (map, key, candidate) => {
        if (!key) return;
        const list = map.get(key) ?? [];
        list.push(candidate);
        map.set(key, list);
    };
    for (const candidate of candidates.toSorted((a, b) => a.priority - b.priority)) {
        add(exact, normalize(candidate.name), candidate);
        for (const form of singularPhrases(candidate.name)) add(exact, normalize(form), candidate);
        add(words, wordKey(candidate.name), candidate);
        const base = candidate.name.match(/^(.+?):\s*\S/)?.[1];
        if (base) add(phases, normalize(base), candidate);
    }
    return { exact, words, phases, candidates };
}

/** Collapse candidates with the same name to the one with the best priority. */
function best(list) {
    const byName = new Map();
    for (const c of list ?? []) {
        const key = normalize(c.name);
        if (!byName.has(key)) byName.set(key, [c]);
        else if (byName.get(key)[0].priority === c.priority) byName.get(key).push(c);
    }
    return [...byName.values()];
}

/**
 * Find adversaries for one printed name.
 * @returns {Candidate[][]}  One list per matched adversary, ordered by preference (fallbacks when an
 *                          entry of this import is not imported after all)
 */
export function matchName(index, name, group = null) {
    const clean = name.replace(/\*$/, '').trim();
    if (!clean || /^(any|all|see\b)/i.test(clean)) return [];

    const groupForms = group ? singularPhrases(group) : [];
    const prefix = group ? group.split(' ').slice(0, -1).join(' ') : '';
    const tries = [...singularPhrases(clean)];
    for (const g of groupForms) tries.push(`${clean} ${g}`, `${g} ${clean}`, `${g}: ${clean}`, `${g} of ${clean}`);
    if (prefix) tries.push(...singularPhrases(clean).map(c => `${prefix} ${c}`));
    for (const attempt of tries) {
        const hit = index.exact.get(normalize(attempt));
        if (hit) return [hit];
    }
    // Same words in a different order: "Patchwork Hulk" in "Zombies" -> "Patchwork Zombie Hulk".
    const wordTries = [clean, ...groupForms.map(g => `${clean} ${g}`)];
    if (prefix) wordTries.push(`${prefix} ${clean}`);
    for (const attempt of wordTries) {
        const hit = index.words.get(wordKey(attempt));
        if (hit) return [hit];
    }
    // Multi-phase adversaries: link every phase.
    for (const attempt of [clean, ...groupForms.map(g => `${g} ${clean}`)]) {
        const hit = index.phases.get(normalize(attempt));
        if (hit) return best(hit);
    }
    return [];
}

/**
 * Match a potential adversary group: "Guards (Arcanist, Head)" or a single name.
 * @param {{label: string, group: string|null, names: string[]}} group
 * @returns {{name: string, matches: Candidate[][]}[]}
 */
export function matchGroup(index, group) {
    return group.names.map(name => ({ name, matches: matchName(index, name, group.group) }));
}

/**
 * Names that can be linked when they appear in running text, longest first.
 * Single-word names ("Bear", "Construct") are only linked when listed in `allowed`, since they are
 * often ordinary words.
 * @param {object} index
 * @param {Set<string>} allowed   Normalised names that may be linked even if they are a single word
 */
function textNames(index, allowed) {
    const names = new Map();
    for (const c of index.candidates) {
        const key = normalize(c.name);
        if (names.has(key) || /[:()]/.test(c.name)) continue;
        if (!c.name.includes(' ') && !allowed.has(key)) continue;
        names.set(key, c.name);
    }
    return [...names.values()].sort((a, b) => b.length - a.length);
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wrap adversary names found in HTML text with links. Only text outside tags and existing links is touched,
 * and each adversary is linked once per description.
 * @param {string} html
 * @param {object} index
 * @param {object} options
 * @param {Set<string>} [options.allowed]                       See textNames
 * @param {(candidates: Candidate[], text: string) => string|null} options.link   Produce the replacement
 * @returns {string}
 */
export function linkText(html, index, { allowed = new Set(), link }) {
    if (!html) return html;
    const parts = html.split(/(<[^>]+>)/);
    const linked = new Set();
    let depth = 0;
    const names = textNames(index, allowed);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.startsWith('<')) {
            if (/^<a[\s>]/i.test(part)) depth++;
            else if (/^<\/a>/i.test(part)) depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth || !part.trim()) continue;
        const tokens = [];
        let text = part;
        for (const name of names) {
            const key = normalize(name);
            if (linked.has(key)) continue;
            // Case sensitive on purpose: proper names are capitalised, ordinary words usually are not.
            const re = new RegExp(`(?<![\\p{L}@\\[{])(${escapeRegExp(name)}(?:e?s)?)(?![\\p{L}\\]}])`, 'u');
            const match = text.match(re);
            if (!match) continue;
            const candidates = index.exact.get(key);
            const replacement = candidates && link(candidates, match[1]);
            if (!replacement) continue;
            linked.add(key);
            tokens.push(replacement);
            text = text.replace(re, `\u0000${tokens.length - 1}\u0000`);
        }
        parts[i] = text.replace(/\u0000(\d+)\u0000/g, (_m, n) => tokens[n]);
    }
    return parts.join('');
}

/* -------------------------------------------- */
/*  Foundry                                     */
/* -------------------------------------------- */

/** The system's adversary compendium. */
export const SYSTEM_PACK = 'daggerheart.adversaries';

/**
 * Gather candidates from the current import, the world and all Actor compendiums.
 * @param {object[]} entries   Parsed entries of the current PDF
 * @returns {Promise<object>}  Index
 */
export async function collectCandidates(entries) {
    const candidates = entries.filter(e => e.kind === 'adversary').map(e => ({ name: e.name, entryId: e.id, priority: 0 }));
    for (const actor of game.actors) {
        if (actor.type === 'adversary') candidates.push({ name: actor.name, uuid: actor.uuid, priority: 1 });
    }
    for (const pack of game.packs.filter(p => p.documentName === 'Actor')) {
        let index;
        try {
            index = await pack.getIndex({ fields: ['type'] });
        } catch {
            continue;
        }
        const priority = pack.collection === SYSTEM_PACK ? 2 : 3;
        for (const entry of index) {
            if (entry.type === 'adversary') candidates.push({ name: entry.name, uuid: entry.uuid, priority });
        }
    }
    return buildIndex(candidates);
}

/**
 * Pick the document to link for a match: an entry of this import once it exists, otherwise the best
 * existing document.
 * @param {Candidate[]} candidates
 * @param {Map<string, ClientDocument>} created  Entry id -> created document
 * @returns {string|null} UUID
 */
export function resolveUuid(candidates, created) {
    for (const c of candidates) {
        if (c.entryId) {
            const doc = created.get(c.entryId);
            if (doc) return doc.uuid;
        } else if (c.uuid) return c.uuid;
    }
    return null;
}
