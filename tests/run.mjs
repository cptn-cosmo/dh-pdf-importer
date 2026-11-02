// Regression test over sample PDFs.  node tests/run.mjs [directory]
// Expected entry counts per file; files that are missing are skipped.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadNodePdfjs } from './pdfjs-node.mjs';
import { extractPdf } from '../scripts/pdf/extract.mjs';
import { parseDocument } from '../scripts/parsers/index.mjs';
import { buildDocument } from '../scripts/builders.mjs';
import { applyNodeOcr, ocrRegionsNode } from './ocr-node.mjs';
import { recoverGlyphs } from '../scripts/pdf/glyphs.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const root = process.argv[2] ?? path.join(os.homedir(), 'Documents/Daggerheart/Supplements');
const EXPECTED = {
    'adventures/Death_at_Helfast_Spire_v1_0.pdf': { adversary: 9, journal: 1, attacks: 8 },
    'adversaries/Underwood - Menagerie of Mayhem #1.pdf': { adversary: 34, journal: 1, attacks: 34 },
    'campaign frames/Bastion_of_Hope_-_Pages.pdf': { weapon: 16, armor: 4, journal: 1, secondary: 8 },
    'campaign frames/Bastion_of_Hope_-_Spreads.pdf': { weapon: 16, armor: 4, journal: 1, secondary: 8 },
    'environments/Atlas_of_Adventure_Vol_1.pdf': { environment: 29, journal: 1 },
    'other/Bastion_of_Hope_-_Item_cards.pdf': { noText: 1 },
    // Files in the project's SRC folder (relative to the repository root)
    '@SRC/Quickstart-Adventure-5-20-2025.pdf': { adversary: 4, journal: 1, attacks: 4 },
    // Set in Questa Sans with lining figures, which the PDF records as private-use code points; resolved
    // from the built-in Questa table, so no entry should miss characters
    "@SRC/Ettin's Adversaries_ Fangs & Felons PG14.pdf": { adversary: 3, journal: 1, attacks: 3, missingGlyphs: 0 },
    // The page number in an unnamed Type 3 font is left over and recovered by OCR of sample lines
    "@SRC/Ettin's Adversaries_ Fangs & Felons PG14.pdf::recover": { recover: true, adversary: 3, attacks: 3, missingGlyphs: 0, unresolved: 0 },
    '@SRC/DH_Adv_The_Wish_Thief_V2_Adventure_Only.pdf': { adversary: 4, environment: 2, journal: 1, attacks: 4 },
    // Image-only PDFs, read with OCR (needs pdftoppm and the tesseract CLI)
    '@SRC/Pistolheart_Vol_1_scanned page.pdf': { ocr: true, environment: 2 },
    '@SRC/The Dying Spire - Adventure and Characters.pdf': { ocr: true, adversary: 5, environment: 1, attacks: 5 }
};

const hasTesseract = (() => {
    try {
        execFileSync('tesseract', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

const pdfjs = await loadNodePdfjs();
let failures = 0;
for (const [file, { ocr, recover, ...expected }] of Object.entries(EXPECTED)) {
    const name = file.replace(/::.*$/, '');
    const full = name.startsWith('@') ? path.join(repo, name.slice(1)) : path.join(root, name);
    if (!fs.existsSync(full) || ((ocr || recover) && !hasTesseract)) {
        console.log(`SKIP ${file}${(ocr || recover) && !hasTesseract ? ' (no tesseract)' : ''}`);
        continue;
    }
    const extracted = await extractPdf(pdfjs, new Uint8Array(fs.readFileSync(full)));
    if (ocr) applyNodeOcr(full, extracted);
    let unresolved = 0;
    if (recover) unresolved = (await recoverGlyphs(extracted.pages, async regions => ocrRegionsNode(full, regions))).remaining;
    const result = parseDocument(extracted, { fileName: path.basename(name) });
    const actual = { noText: result.warnings.includes('noText') ? 1 : 0, unresolved };
    for (const e of result.entries) {
        actual[e.kind] = (actual[e.kind] ?? 0) + 1;
        if (e.attack) actual.attacks = (actual.attacks ?? 0) + 1;
        if (e.secondary) actual.secondary = (actual.secondary ?? 0) + 1;
        if (e.warnings?.some(w => w.includes('[?]'))) actual.missingGlyphs = (actual.missingGlyphs ?? 0) + 1;
        buildDocument(e, { attribution: result.attribution });
    }
    const wrong = Object.entries(expected).filter(([k, v]) => (actual[k] ?? 0) !== v);
    if (wrong.length) failures++;
    console.log(`${wrong.length ? 'FAIL' : 'ok  '} ${file}${wrong.map(([k, v]) => ` ${k}: expected ${v}, got ${actual[k] ?? 0}`).join(',')}`);
}
process.exit(failures ? 1 : 0);
