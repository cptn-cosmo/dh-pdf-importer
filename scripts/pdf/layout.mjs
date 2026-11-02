/**
 * Turns positioned text items into lines in reading order.
 *
 * Pages are segmented with a recursive XY-cut: regions are split at the widest vertical gutter
 * (columns) or, failing that, at the widest horizontal gap (paragraphs, stat blocks). Leaves are then
 * assembled into lines. Each line keeps its formatting runs so parsers can produce rich HTML.
 */

/**
 * @typedef {object} Run
 * @property {string} text
 * @property {boolean} bold
 * @property {boolean} italic
 */

/**
 * @typedef {object} Line
 * @property {string} text
 * @property {Run[]} runs
 * @property {number} page
 * @property {number} x
 * @property {number} y
 * @property {number} right
 * @property {number} size       Dominant font size
 * @property {string} font       Dominant font name
 * @property {boolean} italic    The whole line is italic
 * @property {boolean} bold      The whole line is bold
 * @property {number} block      Id of the layout region the line belongs to
 */

const median = values => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Find gaps in a set of 1D intervals.
 * @param {Array<[number, number]>} intervals
 * @returns {Array<{start: number, end: number, size: number}>}
 */
function findGaps(intervals) {
    const sorted = intervals.toSorted((a, b) => a[0] - b[0]);
    const gaps = [];
    let reach = sorted[0]?.[1] ?? 0;
    for (const [start, end] of sorted.slice(1)) {
        if (start > reach) gaps.push({ start: reach, end: start, size: start - reach });
        reach = Math.max(reach, end);
    }
    return gaps;
}

const itemTop = item => item.y - item.size * 0.8;
const itemBottom = item => item.y + item.size * 0.25;

/**
 * Split a region at its widest vertical gutter.
 * @returns {object[][]|null}  [left, right] or null when the region is a single column
 */
function splitColumns(items, bodySize) {
    const solid = items.filter(i => i.str.trim());
    if (solid.length < 2) return null;
    // Only split regions spanning several lines, otherwise wide word spacing in a single line
    // (or a table row) would be torn apart.
    const height = Math.max(...solid.map(itemBottom)) - Math.min(...solid.map(itemTop));
    if (height <= bodySize * 2.6) return null;
    const gaps = findGaps(solid.map(i => [i.x, i.x + i.w])).filter(g => g.size >= Math.max(3, bodySize * 0.4));
    if (!gaps.length) return null;
    const gap = gaps.reduce((a, b) => (b.size > a.size ? b : a));
    const cut = (gap.start + gap.end) / 2;
    const left = items.filter(i => i.x + i.w / 2 < cut);
    const right = items.filter(i => i.x + i.w / 2 >= cut);
    return left.length && right.length ? [left, right] : null;
}

/**
 * Recursively split a region of items into reading-ordered leaves.
 * @param {object[]} items
 * @param {number} bodySize
 * @returns {object[][]}
 */
function xyCut(items, bodySize) {
    if (items.length < 2) return [items];

    const columns = splitColumns(items, bodySize);
    if (columns) return columns.flatMap(part => xyCut(part, bodySize));

    // A heading spanning both columns with no whitespace below it blocks the gutter: peel it off first.
    const solid = items.filter(i => i.str.trim()).toSorted((a, b) => itemTop(a) - itemTop(b));
    for (let k = 1; k <= Math.min(3, solid.length - 2); k++) {
        const head = new Set(solid.slice(0, k));
        const rest = items.filter(i => !head.has(i));
        const split = splitColumns(rest, bodySize);
        if (split) return [...xyCut([...head], bodySize), ...split.flatMap(part => xyCut(part, bodySize))];
    }

    const gaps = findGaps(items.map(i => [itemTop(i), itemBottom(i)])).filter(g => g.size >= bodySize * 0.35);
    if (gaps.length) {
        const gap = gaps.reduce((a, b) => (b.size > a.size ? b : a));
        const cut = (gap.start + gap.end) / 2;
        const above = items.filter(i => i.y < cut);
        const below = items.filter(i => i.y >= cut);
        if (above.length && below.length) return [...xyCut(above, bodySize), ...xyCut(below, bodySize)];
    }
    return [items];
}

/**
 * Merge consecutive runs that share formatting.
 * @param {Run[]} runs
 * @returns {Run[]}
 */
function mergeRuns(runs) {
    const merged = [];
    for (const run of runs) {
        const last = merged.at(-1);
        if (last && last.bold === run.bold && last.italic === run.italic) last.text += run.text;
        else merged.push({ ...run });
    }
    return merged;
}

/**
 * Assemble the items of a leaf region into lines.
 * @param {object[]} items
 * @param {number} page
 * @param {number} block
 * @returns {Line[]}
 */
function buildLines(items, page, block) {
    const sorted = items.toSorted((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const item of sorted) {
        const row = rows.at(-1);
        if (row && Math.abs(item.y - row.y) < Math.min(item.size, row.size) * 0.5) {
            row.items.push(item);
            row.size = Math.max(row.size, item.size);
        } else rows.push({ y: item.y, size: item.size, items: [item] });
    }

    const lines = [];
    for (const row of rows) {
        const parts = row.items.toSorted((a, b) => a.x - b.x);
        const runs = [];
        let prev = null;
        for (const item of parts) {
            let text = item.str;
            if (prev) {
                const gap = item.x - (prev.x + prev.w);
                const prevText = runs.at(-1)?.text ?? '';
                // Letter-spaced titles are set as individual glyphs: require a wider gap between short fragments.
                const short = prev.str.trim().length <= 2 || item.str.trim().length <= 2;
                const threshold = item.size * (short ? 0.33 : 0.12);
                if (gap > threshold && !/\s$/.test(prevText) && !/^\s/.test(text)) text = ` ${text}`;
            }
            runs.push({ text, bold: item.bold, italic: item.italic, weight: item.str.trim().length });
            prev = item;
        }
        // Normalise whitespace while keeping run boundaries.
        let normalized = mergeRuns(runs.map(r => ({ text: r.text.replace(/\s+/g, ' '), bold: r.bold, italic: r.italic })));
        if (normalized.length) {
            normalized[0].text = normalized[0].text.trimStart();
            normalized.at(-1).text = normalized.at(-1).text.trimEnd();
        }
        normalized = normalized.filter(r => r.text);
        const text = normalized.map(r => r.text).join('');
        if (!text.trim()) continue;

        const solid = parts.filter(p => p.str.trim());
        const sizes = new Map();
        const fonts = new Map();
        for (const p of solid) {
            const size = Math.round(p.size * 10) / 10;
            sizes.set(size, (sizes.get(size) ?? 0) + p.str.length);
            fonts.set(p.font, (fonts.get(p.font) ?? 0) + p.str.length);
        }
        const top = key => [...key.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        const visible = normalized.filter(r => r.text.trim());
        lines.push({
            text,
            runs: normalized,
            page,
            block,
            x: Math.min(...solid.map(p => p.x)),
            right: Math.max(...solid.map(p => p.x + p.w)),
            y: row.y,
            size: top(sizes),
            font: top(fonts),
            italic: visible.every(r => r.italic),
            bold: visible.every(r => r.bold),
            // Recognised by OCR: sizes are estimates and there is no font information.
            ocr: solid.some(p => p.ocr)
        });
    }
    return lines;
}

const repeatKey = text => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/**
 * Lay out the extracted pages into one stream of lines in reading order.
 * Running headers, footers, watermarks and page numbers are removed.
 * @param {import('./extract.mjs').PageText[]} pages
 * @returns {{lines: Line[], bodySize: number}}
 */
export function layoutDocument(pages) {
    const bodySize = median(pages.flatMap(p => p.items.filter(i => i.str.trim()).map(i => Math.round(i.size)))) || 10;

    let block = 0;
    const pageLines = pages.map(page => {
        const leaves = xyCut(page.items, bodySize);
        return leaves.flatMap(leaf => buildLines(leaf, page.number, block++));
    });

    // Text repeated on many pages (running titles, watermarks, page numbers) is noise.
    const counts = new Map();
    for (const lines of pageLines) {
        for (const key of new Set(lines.map(l => repeatKey(l.text)))) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const textPages = pageLines.filter(l => l.length).length;
    const pageOffset = detectPageOffset(pageLines, pages);
    const threshold = Math.max(3, Math.ceil(textPages * 0.3));
    const lines = [];
    pageLines.forEach((list, index) => {
        const page = pages[index];
        for (const line of list) {
            const key = repeatKey(line.text);
            const edge = line.y < page.height * 0.09 || line.y > page.height * 0.91;
            if (/^#$/.test(key) && edge) continue;
            if (counts.get(key) >= threshold && key.length < 100 && !/^features$/.test(key) && (edge || counts.get(key) >= textPages * 0.9)) continue;
            lines.push(line);
        }
    });
    return { lines, bodySize, pageOffset };
}

/**
 * Printed page numbers often differ from PDF page indices (covers, front matter). Find the most common
 * difference between a number printed at the top or bottom edge of a page and the page's index.
 * @returns {number}
 */
function detectPageOffset(pageLines, pages) {
    const votes = new Map();
    pageLines.forEach((list, index) => {
        const page = pages[index];
        const deltas = new Set();
        for (const line of list) {
            if (line.y > page.height * 0.12 && line.y < page.height * 0.88) continue;
            const match = line.text.trim().match(/^(\d{1,3})\b(?!\s*\/)|\b(\d{1,3})$/);
            if (!match || line.text.length > 40) continue;
            deltas.add(Number(match[1] ?? match[2]) - page.number);
        }
        for (const delta of deltas) votes.set(delta, (votes.get(delta) ?? 0) + 1);
    });
    let best = 0;
    let count = 0;
    for (const [delta, n] of votes) {
        if (n > count) [best, count] = [delta, n];
    }
    return count >= Math.max(3, pages.length * 0.25) ? best : 0;
}
