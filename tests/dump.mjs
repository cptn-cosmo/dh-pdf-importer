// Dev helper: print the laid out lines of a PDF.  node tests/dump.mjs file.pdf [page]
import fs from 'node:fs';
import { loadNodePdfjs } from './pdfjs-node.mjs';
import { extractPdf } from '../scripts/pdf/extract.mjs';
import { layoutDocument } from '../scripts/pdf/layout.mjs';

const pdfjs = await loadNodePdfjs();
const { pages } = await extractPdf(pdfjs, new Uint8Array(fs.readFileSync(process.argv[2])));
const { lines, bodySize } = layoutDocument(pages);
const only = process.argv[3] ? Number(process.argv[3]) : null;
console.log('body size', bodySize);
let block = -1;
for (const l of lines) {
    if (only && l.page !== only) continue;
    if (l.block !== block) console.log(`---- p${l.page} b${l.block}`);
    block = l.block;
    const flags = `${l.bold ? 'B' : ' '}${l.italic ? 'I' : ' '}`;
    console.log(`${String(Math.round(l.size)).padStart(2)} ${flags} ${String(Math.round(l.x)).padStart(3)} ${process.env.FONTS ? l.font.padEnd(28) : ""}| ${l.text}`);
}
