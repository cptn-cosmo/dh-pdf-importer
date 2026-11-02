// Recover glyphs without a text mapping by OCR of a few sample lines, then show the affected text.
// node tests/glyphs.mjs file.pdf
import fs from 'node:fs';
import { loadNodePdfjs } from './pdfjs-node.mjs';
import { extractPdf } from '../scripts/pdf/extract.mjs';
import { collectMissingGlyphs, lineRegion, pickSamples, recoverGlyphs } from '../scripts/pdf/glyphs.mjs';
import { ocrRegionsNode } from './ocr-node.mjs';

const file = process.argv[2];
const extracted = await extractPdf(await loadNodePdfjs(), new Uint8Array(fs.readFileSync(file)));
const { items } = collectMissingGlyphs(extracted.pages);
const samples = pickSamples(extracted.pages, items);
const texts = ocrRegionsNode(file, samples.map(s => ({ page: s.page, ...lineRegion(s) })));
samples.forEach((s, i) => console.log(`sample ${JSON.stringify(s.segments.map(x => x.text).join('').replace(/[\uE000-\uF8FF]/g, '?'))}\n   OCR ${JSON.stringify(texts[i])}`));
const stats = await recoverGlyphs(extracted.pages, async regions => ocrRegionsNode(file, regions));
console.log(stats);
for (const { item } of items) console.log(`  ${JSON.stringify(item.str)}`);
