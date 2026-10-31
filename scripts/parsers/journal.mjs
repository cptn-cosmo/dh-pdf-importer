/**
 * Turns the running text of a PDF into a journal entry with one page per major section.
 * Text that was imported as a stat block or table is replaced by a link placeholder.
 */
import { cleanText, formatName, renderParagraphs } from './common.mjs';

export const LINK_PLACEHOLDER = id => `<p data-dhpi-link="${id}"></p>`;

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
        page.html += renderParagraphs(buffer).html;
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
