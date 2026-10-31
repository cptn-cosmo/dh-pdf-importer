// Regression test over sample PDFs.  node tests/run.mjs [directory]
// Expected entry counts per file; files that are missing are skipped.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadNodePdfjs } from './pdfjs-node.mjs';
import { extractPdf } from '../scripts/pdf/extract.mjs';
import { parseDocument } from '../scripts/parsers/index.mjs';
import { buildDocument } from '../scripts/builders.mjs';

const root = process.argv[2] ?? path.join(os.homedir(), 'Documents/Daggerheart/Supplements');
const EXPECTED = {
    'adventures/Death_at_Helfast_Spire_v1_0.pdf': { adversary: 9, journal: 1, attacks: 8 },
    'adversaries/Underwood - Menagerie of Mayhem #1.pdf': { adversary: 34, journal: 1, attacks: 34 },
    'campaign frames/Bastion_of_Hope_-_Pages.pdf': { weapon: 16, armor: 4, journal: 1, secondary: 8 },
    'campaign frames/Bastion_of_Hope_-_Spreads.pdf': { weapon: 16, armor: 4, journal: 1, secondary: 8 },
    'environments/Atlas_of_Adventure_Vol_1.pdf': { environment: 29, journal: 1 },
    'other/Bastion_of_Hope_-_Item_cards.pdf': { noText: 1 }
};

const pdfjs = await loadNodePdfjs();
let failures = 0;
for (const [file, expected] of Object.entries(EXPECTED)) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
        console.log(`SKIP ${file}`);
        continue;
    }
    const result = parseDocument(await extractPdf(pdfjs, new Uint8Array(fs.readFileSync(full))), { fileName: path.basename(file) });
    const actual = { noText: result.warnings.includes('noText') ? 1 : 0 };
    for (const e of result.entries) {
        actual[e.kind] = (actual[e.kind] ?? 0) + 1;
        if (e.attack) actual.attacks = (actual.attacks ?? 0) + 1;
        if (e.secondary) actual.secondary = (actual.secondary ?? 0) + 1;
        buildDocument(e, { attribution: result.attribution });
    }
    const wrong = Object.entries(expected).filter(([k, v]) => (actual[k] ?? 0) !== v);
    if (wrong.length) failures++;
    console.log(`${wrong.length ? 'FAIL' : 'ok  '} ${file}${wrong.map(([k, v]) => ` ${k}: expected ${v}, got ${actual[k] ?? 0}`).join(',')}`);
}
process.exit(failures ? 1 : 0);
