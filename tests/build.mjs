// Dev helper: parse a PDF and build Foundry document data for every entry.  node tests/build.mjs file.pdf [entryName]
import fs from 'node:fs';
import { loadNodePdfjs } from './pdfjs-node.mjs';
import { extractPdf } from '../scripts/pdf/extract.mjs';
import { parseDocument } from '../scripts/parsers/index.mjs';
import { buildDocument } from '../scripts/builders.mjs';

const pdfjs = await loadNodePdfjs();
const file = process.argv[2];
const result = parseDocument(await extractPdf(pdfjs, new Uint8Array(fs.readFileSync(file))), { fileName: file.split('/').at(-1) });
const counts = {};
for (const entry of result.entries) {
    const doc = buildDocument(entry, { attribution: result.attribution, resolveAdversaries: g => [], resolveLink: id => `@UUID[x.${id}]` });
    counts[`${doc.documentName}:${doc.data.type ?? 'journal'}`] = (counts[`${doc.documentName}:${doc.data.type ?? 'journal'}`] ?? 0) + 1;
    if (process.argv[3] && entry.name === process.argv[3]) console.log(JSON.stringify(doc, null, 2));
}
console.log(file.split('/').at(-1), JSON.stringify(counts));
