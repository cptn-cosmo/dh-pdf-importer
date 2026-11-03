/**
 * Entry point turning extracted PDF pages into importable entries.
 */
import { layoutDocument } from '../pdf/layout.mjs';
import { guessAttribution } from './attribution.mjs';
import { parseEquipment } from './equipment.mjs';
import { parseJournal } from './journal.mjs';
import { parseOptions } from './options.mjs';
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

    const entries = [...parseStatBlocks(lines), ...parseEquipment(extracted.pages), ...parseOptions(lines, bodySize)];
    entries.sort((a, b) => a.page - b.page);
    // Text recognised by OCR may contain misread words; let the review screen flag those entries.
    // Whole pages recognised with OCR, and pages with text recognised inside images.
    const ocrPages = new Set(
        extracted.pages.filter(p => p.ocr || p.ocrRegions?.length || p.items.some(i => i.ocr)).map(p => p.number)
    );
    for (const entry of entries) {
        const fromOcr = entry.sourceLines ? entry.sourceLines.some(l => l.ocr) : ocrPages.has(entry.page);
        if (fromOcr) entry.ocr = true;
    }
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
        ocrPages: [...ocrPages],
        attribution,
        lines,
        bodySize
    };
}
