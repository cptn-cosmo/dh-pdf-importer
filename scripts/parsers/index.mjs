/**
 * Entry point turning extracted PDF pages into importable entries.
 */
import { layoutDocument } from '../pdf/layout.mjs';
import { guessAttribution } from './attribution.mjs';
import { parseEquipment } from './equipment.mjs';
import { parseJournal } from './journal.mjs';
import { parseStatBlocks } from './statblocks.mjs';

/**
 * @param {{pages: import('../pdf/extract.mjs').PageText[], info: object}} extracted
 * @param {object} [options]
 * @param {string} [options.fileName]
 */
export function parseDocument(extracted, { fileName = '' } = {}) {
    const { lines, bodySize, pageOffset } = layoutDocument(extracted.pages);
    const warnings = [];
    if (!lines.length) warnings.push('noText');
    const emptyPages = extracted.pages.filter(p => !p.items.some(i => i.str.trim())).map(p => p.number);

    const entries = [...parseStatBlocks(lines), ...parseEquipment(extracted.pages)];
    entries.sort((a, b) => a.page - b.page);
    entries.forEach((entry, index) => (entry.id = `entry-${index}`));

    const attribution = guessAttribution(extracted.info, fileName, lines, pageOffset);
    const journal = parseJournal(lines, bodySize, entries, attribution.source || 'Imported PDF');
    if (journal) {
        journal.id = 'journal';
        entries.push(journal);
    }

    return {
        entries,
        warnings,
        emptyPages,
        attribution,
        lines,
        bodySize
    };
}
