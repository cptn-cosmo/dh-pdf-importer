/**
 * Turns the running text of a PDF into a journal entry with one page per major section.
 * Text that was imported as a stat block or table is replaced by a link placeholder.
 */
import { cleanText, formatName, renderParagraphs } from './common.mjs';

export const LINK_PLACEHOLDER = id => `<p data-dhpi-link="${id}"></p>`;

const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Arrange short lines into a grid if they form a table: at least 3 rows and 3 columns, mostly filled.
 * Tables are read column by column in layout order, so the grid is rebuilt from the positions. Lines
 * that are alone on their row (text above or below the table) stay paragraphs.
 * @returns {{html: string, before: object[], after: object[]}|null}
 */
function tableHtml(entries) {
    const size = Math.max(...entries.map(e => e.line.size));
    const rows = [];
    for (const entry of entries.toSorted((a, b) => a.line.y - b.line.y)) {
        const row = rows.find(r => Math.abs(r.y - entry.line.y) < size * 0.5);
        if (row) row.cells.push(entry);
        else rows.push({ y: entry.line.y, cells: [entry] });
    }
    const grid = rows.filter(r => r.cells.length >= 2);
    if (grid.length < 3) return null;
    const top = grid[0].y;
    const bottom = grid.at(-1).y;
    // Single lines inside the grid's rows would make it ragged; only allow them above or below it.
    if (rows.some(r => r.cells.length < 2 && r.y > top && r.y < bottom)) return null;

    const columns = [];
    for (const { line } of grid.flatMap(r => r.cells).toSorted((a, b) => a.line.x - b.line.x)) {
        if (!columns.some(x => Math.abs(x - line.x) < size * 1.5)) columns.push(line.x);
    }
    const filled = grid.reduce((n, r) => n + r.cells.length, 0);
    if (columns.length < 3 || filled < grid.length * columns.length * 0.7) return null;

    const columnOf = line => columns.reduce((best, x, i) => (Math.abs(x - line.x) < Math.abs(columns[best] - line.x) ? i : best), 0);
    const cell = (tag, entry) => `<${tag}>${entry ? escapeHtml(cleanText(entry.line.text)) : ''}</${tag}>`;
    const html = grid.map((row, r) => {
        const cells = columns.map((_x, c) => row.cells.find(e => columnOf(e.line) === c));
        // A header row is set in capitals or bold.
        const header = r === 0 && cells.every(e => !e || e.line.bold || !/\p{Ll}/u.test(e.line.text));
        return `<tr>${cells.map(e => cell(header ? 'th' : 'td', e)).join('')}</tr>`;
    });
    const loose = rows.filter(r => r.cells.length < 2).flatMap(r => r.cells);
    return {
        html: `<table>${html.join('')}</table>`,
        before: entries.filter(e => loose.includes(e) && e.line.y < top),
        after: entries.filter(e => loose.includes(e) && e.line.y > bottom)
    };
}

/**
 * Render buffered lines as paragraphs, turning runs of short lines that form a grid into tables.
 * @param {{runs: object[], line: object}[]} entries
 */
function renderWithTables(entries) {
    let html = '';
    let text = [];
    let run = [];
    const short = e => cleanText(e.line.text).length <= 40;
    const closeRun = () => {
        const table = run.length >= 9 ? tableHtml(run) : null;
        if (table) {
            html += renderParagraphs([...text, ...table.before]).html + table.html;
            text = [...table.after];
        } else text.push(...run);
        run = [];
    };
    for (const entry of entries) {
        if (short(entry) && (!run.length || run[0].line.page === entry.line.page)) run.push(entry);
        else {
            closeRun();
            text.push(entry);
        }
    }
    closeRun();
    return html + renderParagraphs(text).html;
}

/**
 * @param {import('../pdf/layout.mjs').Line[]} lines
 * @param {number} bodySize
 * @param {object[]} entries      Parsed entries, used to skip and link their source text
 * @param {string} title
 */
export function parseJournal(lines, bodySize, entries, title) {
    const consumed = new Map();
    for (const entry of entries) {
        for (const line of entry.sourceLines ?? []) consumed.set(line, entry);
    }
    const regions = entries.filter(e => e.region);
    const inRegion = line =>
        regions.find(e => e.region.page === line.page && line.y >= e.region.top && line.y <= e.region.bottom);

    const pageBreakSize = bodySize * 1.45;
    const subheadingSize = bodySize * 1.15;
    const pages = [];
    let page = null;
    let buffer = [];
    const linked = new Set();

    const flush = () => {
        if (!buffer.length) return;
        page ??= { name: title, html: '', firstPage: buffer[0].line?.page ?? 1 };
        if (!pages.includes(page)) pages.push(page);
        page.html += renderWithTables(buffer);
        buffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const entry = consumed.get(line) ?? inRegion(line);
        if (entry) {
            flush();
            page ??= { name: title, html: '', firstPage: line.page };
            if (!pages.includes(page)) pages.push(page);
            // Tables produce several entries (one per tier); link each once.
            const group = entries.filter(e => e === entry || (e.region && e.region === entry.region));
            for (const e of group) {
                if (linked.has(e)) continue;
                linked.add(e);
                page.html += LINK_PLACEHOLDER(e.id);
            }
            continue;
        }

        const text = cleanText(line.text);
        if (line.size >= pageBreakSize && text.length < 80 && /\p{L}/u.test(text)) {
            // Collect a heading that wraps over several lines.
            const parts = [text.replace(/^[■●•▪◆►›»]\s*/u, '')];
            while (lines[i + 1] && Math.abs(lines[i + 1].size - line.size) < 0.5 && lines[i + 1].page === line.page && !consumed.has(lines[i + 1])) {
                parts.push(cleanText(lines[++i].text));
                if (parts.length >= 3) break;
            }
            flush();
            const name = formatName(parts.join(' '));
            // Keep tiny sections (decorative headings) together with what follows.
            if (page && page.html.replace(/<[^>]+>/g, '').length < 40 && !page.html.includes('data-dhpi-link')) {
                page.name = page.name === title ? name : `${page.name} ${name}`;
            } else {
                page = { name, html: '', firstPage: line.page };
                pages.push(page);
            }
            continue;
        }
        if (line.size >= subheadingSize && text.length < 80 && !/[.,;]$/.test(text)) {
            flush();
            page ??= { name: title, html: '', firstPage: line.page };
            if (!pages.includes(page)) pages.push(page);
            page.html += `<h3>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h3>`;
            continue;
        }
        buffer.push({ runs: line.runs, line });
    }
    flush();

    const kept = pages.filter(p => p.html.replace(/<[^>]+>/g, '').trim() || p.html.includes('data-dhpi-link'));
    if (!kept.length) return null;
    return {
        kind: 'journal',
        name: title,
        page: kept[0].firstPage,
        pages: kept.map(p => ({ name: p.name.slice(0, 120), html: p.html, page: p.firstPage })),
        warnings: []
    };
}
