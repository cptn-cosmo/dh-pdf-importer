// OCR for the Node test scripts: renders pages with pdftoppm and reads them with the tesseract CLI,
// then converts the TSV with the same code the module uses in the browser.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ocrLinesToItems, parseTsv } from '../scripts/pdf/ocr.mjs';

const SCALE = 3; // 216 dpi, as in the browser
const REGION_SCALE = 4; // 288 dpi for the small snippets used to recover glyphs
const CACHE = process.env.DHPI_OCR_CACHE ?? path.join(os.tmpdir(), 'dhpi-ocr-cache');

/**
 * Replace the items of pages without text by OCR results.
 * @param {string} file
 * @param {{pages: object[]}} extracted
 */
export function applyNodeOcr(file, extracted) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhpi-ocr-'));
    try {
        for (const page of extracted.pages) {
            if (page.items.some(i => i.str.trim())) continue;
            const prefix = path.join(dir, `p${page.number}`);
            // OCR is slow; cache the TSV per file, modification time and page.
            const stat = fs.statSync(file);
            const cacheFile = path.join(CACHE, `${path.basename(file).replace(/\W+/g, '_')}-${stat.size}-${stat.mtimeMs}-p${page.number}.tsv`);
            let tsv;
            if (fs.existsSync(cacheFile)) tsv = fs.readFileSync(cacheFile, 'utf8');
            else {
                execFileSync('pdftoppm', ['-r', String(72 * SCALE), '-f', String(page.number), '-l', String(page.number), '-png', '-singlefile', file, prefix]);
                tsv = execFileSync('tesseract', [`${prefix}.png`, '-', 'tsv'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString();
                fs.mkdirSync(CACHE, { recursive: true });
                fs.writeFileSync(cacheFile, tsv);
            }
            page.items = ocrLinesToItems(parseTsv(tsv), SCALE);
            page.ocr = true;
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return extracted;
}

/**
 * Recognise small page regions (in PDF units) with the tesseract CLI, one line each.
 * @param {string} file
 * @param {{page: number, x: number, y: number, w: number, h: number}[]} regions
 * @returns {string[]}
 */
export function ocrRegionsNode(file, regions) {
    const dpi = 72 * REGION_SCALE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhpi-glyph-'));
    try {
        return regions.map((r, i) => {
            const prefix = path.join(dir, `r${i}`);
            const px = v => String(Math.max(0, Math.round(v * REGION_SCALE)));
            execFileSync('pdftoppm', ['-r', String(dpi), '-f', String(r.page), '-l', String(r.page), '-x', px(r.x), '-y', px(r.y), '-W', px(r.w), '-H', px(r.h), '-png', '-singlefile', file, prefix], { stdio: 'ignore' });
            return execFileSync('tesseract', [`${prefix}.png`, '-', '--psm', '7'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
