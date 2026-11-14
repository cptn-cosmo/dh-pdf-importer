// Regression test over sample PDFs.  node tests/run.mjs [directory]
// Expected entry counts per file; files that are missing are skipped.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadNodePdfjs } from './pdfjs-node.mjs';
import { extractPdf } from '../scripts/pdf/extract.mjs';
import { parseDocument } from '../scripts/parsers/index.mjs';
import { buildDocument } from '../scripts/builders.mjs';
import { applyNodeImageOcr, applyNodeOcr, ocrRegionsNode } from './ocr-node.mjs';
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
    '@SRC/The Dying Spire - Adventure and Characters.pdf': { ocr: true, adversary: 5, environment: 1, attacks: 5 },
    // Text layer for most pages, but the adversary stat blocks are pictures: nothing without image OCR
    // Character options in the SRD layout; The New Unknown's own domains and card types
    '@SRC/PlaytestV03_Fist.pdf': { adversary: 0, journal: 1, class: 4, subclass: 5, ancestry: 7, community: 3, domainCard: 35 },
    // An adventure preview: no stat blocks, but a quick-stats table of core adversaries for the journal
    '@SRC/Daggerheart_Core_Book_-_Full_Art_Cards_-_9-09-25.pdf': { adversary: 0, journal: 1, tables: 1 },
    'adventures/Death_at_Helfast_Spire_v1_0.pdf::tables': { tables: 2 },
    // A scan with an invisible OCR text layer (OCRmyPDF): read as OCR text
    '@SRC/Hollow_Rider_Dh1e.pdf': { adversary: 1, attacks: 1, withHp: 1, ocrEntries: 1, journal: 1 },
    // HP and Stress are printed as circles drawn as vector shapes
    '@SRC/Spa Day - Cavern Crawl - Tier 2.pdf': { adversary: 3, environment: 1, journal: 1, withHp: 3, withStress: 3 },
    // HP/Stress tick boxes printed in a larger font between the stats and the features, and the horde size
    // in the name heading ("SCRAWNY GNOLLS (1/HP)")
    '@SRC/EE_HeartbeatGnolls_StatBlocksOnly_v1.pdf': { adversary: 16, environment: 3, journal: 1, attacks: 16, withFeatures: 16, hordeDamage: 1 },
    '@SRC/PlaytestV03_Fist.pdf::images': { images: true, adversary: 8, attacks: 8, ocrEntries: 8 }
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
for (const [file, { ocr, recover, images, ...expected }] of Object.entries(EXPECTED)) {
    const name = file.replace(/::.*$/, '');
    const full = name.startsWith('@') ? path.join(repo, name.slice(1)) : path.join(root, name);
    const needsOcr = ocr || recover || images;
    if (!fs.existsSync(full) || (needsOcr && !hasTesseract)) {
        console.log(`SKIP ${file}${needsOcr && !hasTesseract ? ' (no tesseract)' : ''}`);
        continue;
    }
    const extracted = await extractPdf(pdfjs, new Uint8Array(fs.readFileSync(full)));
    if (ocr) applyNodeOcr(full, extracted);
    if (images) await applyNodeImageOcr(full, extracted, pdfjs);
    let unresolved = 0;
    if (recover) unresolved = (await recoverGlyphs(extracted.pages, async regions => ocrRegionsNode(full, regions))).remaining;
    const result = parseDocument(extracted, { fileName: path.basename(name) });
    const actual = { noText: result.warnings.includes('noText') ? 1 : 0, unresolved };
    for (const e of result.entries) {
        actual[e.kind] = (actual[e.kind] ?? 0) + 1;
        if (e.attack) actual.attacks = (actual.attacks ?? 0) + 1;
        if (e.kind === 'adversary' && e.hp) actual.withHp = (actual.withHp ?? 0) + 1;
        if (e.kind === 'adversary' && e.stress) actual.withStress = (actual.withStress ?? 0) + 1;
        if (e.kind === 'adversary' && e.features.length) actual.withFeatures = (actual.withFeatures ?? 0) + 1;
        if (e.hordeDamage) actual.hordeDamage = (actual.hordeDamage ?? 0) + 1;
        if (e.secondary) actual.secondary = (actual.secondary ?? 0) + 1;
        if (e.ocr && e.kind !== 'journal') actual.ocrEntries = (actual.ocrEntries ?? 0) + 1;
        if (e.kind === 'journal') actual.tables = e.pages.reduce((n, p) => n + (p.html.match(/<table>/g) ?? []).length, 0);
        if (e.warnings?.some(w => w.includes('[?]'))) actual.missingGlyphs = (actual.missingGlyphs ?? 0) + 1;
        buildDocument(e, { attribution: result.attribution });
    }
    const wrong = Object.entries(expected).filter(([k, v]) => (actual[k] ?? 0) !== v);
    if (wrong.length) failures++;
    console.log(`${wrong.length ? 'FAIL' : 'ok  '} ${file}${wrong.map(([k, v]) => ` ${k}: expected ${v}, got ${actual[k] ?? 0}`).join(',')}`);
}
process.exit(failures ? 1 : 0);
