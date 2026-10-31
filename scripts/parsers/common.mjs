/**
 * Shared helpers for turning laid out lines into Daggerheart data.
 */

export const RANGES = {
    melee: 'melee',
    'very close': 'veryClose',
    close: 'close',
    far: 'far',
    'very far': 'veryFar'
};
export const RANGE_PATTERN = 'Very Close|Very Far|Melee|Close|Far';

export const ADVERSARY_TYPES = [
    'bruiser',
    'horde',
    'leader',
    'minion',
    'ranged',
    'skulk',
    'social',
    'solo',
    'standard',
    'support'
];
export const ENVIRONMENT_TYPES = ['exploration', 'social', 'traversal', 'event'];

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, all: 'all' };

/** Normalise typographic oddities produced by PDF text extraction. */
export function cleanText(text) {
    return text
        .replace(/[   ]/g, ' ')
        .replace(/­/g, '')
        .replace(/[ʼ`]/g, '’')
        .replace(/�/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export const toRange = text => RANGES[cleanText(text ?? '').toLowerCase()] ?? null;

export function parseSigned(text) {
    if (text == null) return null;
    const value = Number(String(text).replace(/[−–—]/g, '-').replace(/\s/g, ''));
    return Number.isFinite(value) ? value : null;
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/** Title-case names printed in capitals ("REGOLIENN, SORCERESS OF HELFAST SPIRE"). */
export function formatName(text) {
    const name = cleanText(text).replace(/^[■●•▪◆►›»*\s]+/u, '');
    const allCaps = !/\p{Ll}/u.test(name);
    return name
        .split(' ')
        .map((word, index) => {
            // Only re-case words printed in capitals; "Dangerous DUNGEON" -> "Dangerous Dungeon".
            // Small caps often come out as "onTenTs" or "reD": treat those words as capitals too.
            const smallCaps = /\p{Ll}\p{Lu}/u.test(word);
            if (!allCaps && !smallCaps && (/\p{Ll}/u.test(word) || word.replace(/\P{L}/gu, '').length < 2)) return word;
            const lower = word.toLowerCase();
            if (index > 0 && SMALL_WORDS.has(lower)) return lower;
            return lower.replace(/(^|[-(“"/])(\p{L})/gu, (_m, pre, letter) => pre + letter.toUpperCase());
        })
        .join(' ');
}

const escapeHtml = text =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Render formatting runs as inline HTML.
 * @param {import('../pdf/layout.mjs').Run[]} runs
 * @returns {string}
 */
export function runsToHtml(runs) {
    return runs
        .map(run => {
            let html = escapeHtml(run.text);
            const match = html.match(/^(\s*)(.*?)(\s*)$/s);
            let [, lead, body, trail] = match;
            if (!body) return html;
            if (run.italic) body = `<em>${body}</em>`;
            if (run.bold) body = `<strong>${body}</strong>`;
            return lead + body + trail;
        })
        .join('')
        .replace(/<\/strong>(\s*)<strong>/g, '$1')
        .replace(/<\/em>(\s*)<em>/g, '$1');
}

/**
 * Drop the first `offset` characters from a list of runs.
 * @param {import('../pdf/layout.mjs').Run[]} runs
 * @param {number} offset
 */
export function sliceRuns(runs, offset) {
    const result = [];
    let remaining = offset;
    for (const run of runs) {
        if (remaining >= run.text.length) {
            remaining -= run.text.length;
            continue;
        }
        result.push({ ...run, text: run.text.slice(remaining) });
        remaining = 0;
    }
    if (result.length) result[0].text = result[0].text.trimStart();
    return result.filter(r => r.text);
}

const BULLET = /^\s*(?:[•›▪■●◦\-*]|\d+\.)\s+/;

/**
 * Group lines into paragraphs and render them as HTML.
 * @param {Array<{runs: import('../pdf/layout.mjs').Run[], line: import('../pdf/layout.mjs').Line}>} entries
 * @param {object} [options]
 * @param {boolean} [options.secretQuestions]  Render GM question paragraphs as secret blocks
 * @returns {{html: string, text: string}}
 */
export function renderParagraphs(entries, { secretQuestions = false } = {}) {
    const paragraphs = [];
    let current = null;
    let prev = null;
    for (const { runs, line } of entries) {
        if (!runs.length) continue;
        const text = runs.map(r => r.text).join('');
        const bullet = BULLET.test(text);
        // A change of typeface after a finished sentence starts a new paragraph (e.g. GM questions).
        const fontChanged = prev && prev.font !== line.font && /[.!?:”"]$/.test(prev.text.trim());
        const blockChanged = prev && prev.block !== line.block;
        const heading = line.bold && !prev?.bold && text.length < 60;
        if (!current || bullet || fontChanged || blockChanged || heading || (prev?.bold && !line.bold)) {
            current = { runs: [], bullet, font: line.font };
            paragraphs.push(current);
        } else {
            // Join wrapped lines, keeping hyphenated words intact.
            const last = current.runs.at(-1);
            if (last && !/[-–—/]$/.test(last.text)) last.text += ' ';
        }
        const copy = runs.map(r => ({ ...r }));
        if (bullet) copy[0].text = copy[0].text.replace(BULLET, '');
        current.runs.push(...copy);
        prev = line;
    }

    let html = '';
    let list = false;
    const plain = [];
    for (const p of paragraphs) {
        const text = cleanText(p.runs.map(r => r.text).join(''));
        if (!text) continue;
        plain.push(text);
        const inner = runsToHtml(p.runs.map(r => ({ ...r, text: r.text.replace(/\s+/g, ' ') }))).trim();
        if (p.bullet && !list) html += '<ul>';
        if (!p.bullet && list) html += '</ul>';
        list = p.bullet;
        if (p.bullet) html += `<li>${inner}</li>`;
        else if (secretQuestions && plain.length > 1 && isQuestion(text)) {
            html += `<section class="secret" id="secret-${randomId()}"><p><em>${inner}</em></p></section>`;
        } else html += `<p>${inner}</p>`;
    }
    if (list) html += '</ul>';
    return { html, text: plain.join('\n') };
}

const isQuestion = text => text.endsWith('?') && !/[.!:]\s*$/.test(text);

/** Foundry compatible random id, independent of the `foundry` global so it can run in tests. */
export function randomId(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < length; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

/**
 * Parse a damage expression like "1d8+2", "2d12", "d6+4" or "3".
 * @returns {{formula: string, count: number|null, dice: string|null, bonus: number|null}|null}
 */
export function parseDamage(text) {
    const value = cleanText(text ?? '').replace(/\s/g, '').replace(/[−–]/g, '-');
    let match = value.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
    if (match) {
        const count = match[1] ? Number(match[1]) : null;
        const bonus = match[3] ? Number(match[3]) : null;
        return { formula: `${count ?? 1}d${match[2]}${match[3] ?? ''}`, count, dice: `d${match[2]}`, bonus };
    }
    match = value.match(/^(\d+)$/);
    if (match) return { formula: match[1], count: null, dice: null, bonus: Number(match[1]) };
    return null;
}

export const damageTypeOf = text => (/^stress/i.test(text ?? '') ? 'stress' : /^mag/i.test(text ?? '') ? 'magical' : 'physical');

/**
 * Find a resource cost at the start of a feature ("Mark a Stress", "Spend 2 Fear").
 * @param {string} text
 * @returns {{key: string, value: number}[]}
 */
export function parseCosts(text) {
    const costs = [];
    const head = text.slice(0, 120);
    const re = /\b(mark|spend)\s+(a|an|one|two|three|four|\d+)\s+(stress|fear|hope|hp|hit points?)\b/gi;
    for (const match of head.matchAll(re)) {
        // Only costs paid by the feature user, not effects inflicted on targets ("the target must mark a Stress").
        const before = head.slice(Math.max(0, match.index - 25), match.index).toLowerCase();
        if (/(must|target|they|each|pc|to)\s*$/.test(before)) continue;
        const resource = match[3].toLowerCase();
        const key = resource === 'hp' || resource.startsWith('hit') ? 'hitPoints' : resource;
        const amount = NUMBER_WORDS[match[2].toLowerCase()] ?? Number(match[2]);
        if (!Number.isFinite(amount)) continue;
        if (!costs.some(c => c.key === key)) costs.push({ key, value: amount });
    }
    return costs;
}

/**
 * Split a comma separated list while respecting parentheses.
 * @param {string} text
 * @returns {string[]}
 */
export function splitTopLevel(text, separators = ',;') {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const char of text) {
        if (char === '(' || char === '[') depth++;
        if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
        if (depth === 0 && separators.includes(char)) {
            parts.push(current);
            current = '';
        } else current += char;
    }
    parts.push(current);
    return parts.map(p => cleanText(p)).filter(Boolean);
}
