/**
 * Recovery of characters a PDF draws but has no text for.
 *
 * Some fonts have no Unicode mapping for a few glyphs (often an alternate set of digits). pdf.js then
 * reports private-use code points, which extractPdf shows as MISSING_GLYPH. Each such code always stands
 * for the same glyph within a font, so recognising a few rendered samples is enough to learn what it is:
 * the OCR text of a snippet is aligned with the known text around the missing glyphs ("they take ?d?
 * physical" against "they take 2d4 physical"), and the result is applied to every occurrence.
 */

export const MISSING_GLYPH = '[?]';
export const PRIVATE_USE = /[-]/g;

const glyphKey = (font, char) => `${font}:${char.codePointAt(0).toString(16)}`;

/** The visible text of a raw string, with unknown glyphs replaced from `map` or marked. */
export function resolveGlyphs(raw, font, map = new Map()) {
    return raw.replace(/[-]/g, char => map.get(glyphKey(font, char)) ?? '\u0000').replace(/\u0000+/g, MISSING_GLYPH);
}

/**
 * Items containing unknown glyphs, grouped by glyph.
 * @param {import('./extract.mjs').PageText[]} pages
 * @returns {{keys: Set<string>, items: {page: number, item: object}[]}}
 */
export function collectMissingGlyphs(pages) {
    const keys = new Set();
    const items = [];
    for (const page of pages) {
        for (const item of page.items) {
            if (!item.raw) continue;
            const codes = item.raw.match(PRIVATE_USE);
            if (!codes) continue;
            for (const c of codes) keys.add(glyphKey(item.fontId, c));
            items.push({ page: page.number, item });
        }
    }
    return { keys, items };
}

/**
 * The printed line an item belongs to: neighbouring items on the same baseline, as segments that
 * remember their font so each unknown glyph can be attributed to it.
 * @returns {{segments: {text: string, font: string}[], x: number, y: number, w: number, size: number}}
 */
export function lineAround(page, item) {
    const sameLine = page.items
        .filter(i => i.str && Math.abs(i.y - item.y) < Math.min(i.size, item.size) * 0.35)
        .sort((a, b) => a.x - b.x);
    // Walk outwards from the item while the gaps are word-sized.
    let start = sameLine.indexOf(item);
    let end = start;
    const close = (a, b) => b.x - (a.x + a.w) < Math.max(a.size, b.size) * 1.5;
    while (start > 0 && close(sameLine[start - 1], sameLine[start])) start--;
    while (end < sameLine.length - 1 && close(sameLine[end], sameLine[end + 1])) end++;
    const parts = sameLine.slice(start, end + 1);
    const segments = [];
    parts.forEach((p, i) => {
        if (i && p.x - (parts[i - 1].x + parts[i - 1].w) > p.size * 0.15) segments.push({ text: ' ', font: '' });
        segments.push({ text: p.raw ?? p.str, font: p.fontId ?? '' });
    });
    const x = parts[0].x;
    const right = Math.max(...parts.map(p => p.x + p.w));
    return { segments, x, y: item.y, w: right - x, size: Math.max(...parts.map(p => p.size)) };
}

/** The page region of a line, in PDF units: tight vertically so neighbouring lines stay out. */
export function lineRegion(line) {
    const padX = line.size * 0.4;
    return { x: line.x - padX, y: line.y - line.size * 0.95, w: line.w + padX * 2, h: line.size * 1.3 };
}

/**
 * Choose lines to recognise: a few per unknown glyph, preferring lines with more known text.
 * @param {import('./extract.mjs').PageText[]} pages
 * @param {{page: number, item: object}[]} items   From collectMissingGlyphs
 * @param {number} [perGlyph]
 */
export function pickSamples(pages, items, perGlyph = 3) {
    const byNumber = new Map(pages.map(p => [p.number, p]));
    const seen = new Set();
    const lines = [];
    for (const { page, item } of items) {
        const line = lineAround(byNumber.get(page), item);
        const id = `${page}:${Math.round(line.x)}:${Math.round(line.y)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        lines.push({ page, ...line });
    }
    lines.sort((a, b) => contextLength(b.segments) - contextLength(a.segments));
    const counts = new Map();
    return lines.filter(line => {
        const keys = unknownGlyphs(line.segments).map(g => glyphKey(g.font, g.char));
        if (!keys.some(k => (counts.get(k) ?? 0) < perGlyph)) return false;
        for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
        return true;
    });
}

const contextLength = segments => segments.map(s => s.text.replace(PRIVATE_USE, '')).join('').trim().length;

/** Unknown glyphs of a line, in order. */
const unknownGlyphs = segments =>
    segments.flatMap(s => [...(s.text.match(PRIVATE_USE) ?? [])].map(char => ({ char, font: s.font })));

const WILDCARD = '\u0001';

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build a pattern from raw text: literal parts must match, each unknown glyph captures one character. */
function patternFor(raw) {
    let source = '';
    for (const char of raw) {
        if (/[\uE000-\uF8FF]/.test(char)) source += '([0-9A-Za-z+\\-%/])';
        else if (char === WILDCARD) source += '\\S';
        else if (/\s/.test(char)) source += '\\s*';
        else source += `${escapeRegExp(char)}\\s*`;
    }
    return new RegExp(source.replace(/(\\s\*)+/g, '\\s*'), 'i');
}

/**
 * Learn unknown glyphs from the OCR text of a line.
 * @param {{text: string, font: string}[]} segments   The line's raw text by font
 * @param {string} ocrText                            What OCR read for the line
 * @returns {{font: string, char: string, value: string}[]}
 */
export function learnGlyphs(segments, ocrText) {
    const text = ocrText.replace(/\s+/g, ' ').trim();
    const unknown = unknownGlyphs(segments);
    const raw = segments.map(s => s.text).join('');
    if (!unknown.length || !text) return [];

    // The whole line first, then a little context around each run of glyphs, which survives misreads
    // elsewhere in the line.
    const whole = text.match(patternFor(raw.trim()));
    if (whole) return unknown.map((g, i) => ({ ...g, value: whole[i + 1] }));

    const learned = [];
    let index = 0;
    for (const match of raw.matchAll(/[\uE000-\uF8FF]+/g)) {
        const glyphs = unknown.slice(index, index + match[0].length);
        index += match[0].length;
        // Other unknown glyphs in the context match any character without being captured.
        const wildcard = part => part.replace(PRIVATE_USE, WILDCARD);
        const before = wildcard(raw.slice(Math.max(0, match.index - 8), match.index).replace(/^\S*\s/, ''));
        const after = wildcard(raw.slice(match.index + match[0].length, match.index + match[0].length + 8).replace(/\s\S*$/, ''));
        if (!before.replaceAll(WILDCARD, '').trim() && !after.replaceAll(WILDCARD, '').trim()) continue;
        const local = text.match(patternFor(`${before}${match[0]}${after}`));
        if (local) glyphs.forEach((g, i) => learned.push({ ...g, value: local[i + 1] }));
    }
    return learned;
}

/**
 * Combine what was learned from several samples: each glyph gets the value most samples agree on.
 * @param {{font: string, char: string, value: string}[]} votes
 * @returns {Map<string, string>}  glyph key -> character
 */
export function decideGlyphs(votes) {
    const tally = new Map();
    for (const { font, char, value } of votes) {
        const key = glyphKey(font, char);
        const counts = tally.get(key) ?? new Map();
        // OCR confuses these in isolation; digits are by far the most common unmapped glyphs.
        const normalized = { O: '0', o: '0', l: '1', I: '1', i: '1', S: '5', B: '8', Z: '2' }[value] ?? value;
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
        tally.set(key, counts);
    }
    const map = new Map();
    for (const [key, counts] of tally) {
        const [value] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        map.set(key, value);
    }
    return map;
}

/**
 * Rewrite the text of all items using learned glyphs.
 * @returns {number} Number of unknown glyphs that are now known
 */
export function applyGlyphMap(pages, map) {
    let resolved = 0;
    for (const page of pages) {
        for (const item of page.items) {
            if (!item.raw) continue;
            for (const char of item.raw.match(PRIVATE_USE) ?? []) if (map.has(glyphKey(item.fontId, char))) resolved++;
            item.str = resolveGlyphs(item.raw, item.fontId, map);
        }
    }
    return resolved;
}

/**
 * Recover unknown glyphs by recognising a few sample regions.
 * @param {import('./extract.mjs').PageText[]} pages   Extracted pages; their items are updated in place
 * @param {(regions: {page: number, x: number, y: number, w: number, h: number}[]) => Promise<string[]>} recognise
 * @returns {Promise<{glyphs: number, learned: number, resolved: number, remaining: number}>}
 */
export async function recoverGlyphs(pages, recognise) {
    const { keys, items } = collectMissingGlyphs(pages);
    if (!keys.size) return { glyphs: 0, learned: 0, resolved: 0, remaining: 0 };
    const samples = pickSamples(pages, items);
    const texts = await recognise(samples.map(s => ({ page: s.page, ...lineRegion(s) })));
    const votes = samples.flatMap((s, i) => learnGlyphs(s.segments, texts[i] ?? ''));
    const map = decideGlyphs(votes);
    const resolved = applyGlyphMap(pages, map);
    const remaining = collectMissingGlyphs(pages).items.filter(({ item }) => item.str.includes(MISSING_GLYPH)).length;
    return { glyphs: keys.size, learned: map.size, resolved, remaining };
}
