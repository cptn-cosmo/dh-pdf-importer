/**
 * Optical character recognition for pages that only contain images (scans, browser "print to PDF" of
 * an image). Pages are rendered with pdf.js and read with tesseract.js; the recognised words become the
 * same positioned text items that extractPdf produces, so the rest of the parser works unchanged.
 *
 * tesseract.js is loaded from a CDN on first use, together with its WebAssembly core and the English
 * language data (roughly 15 MB, cached by the browser afterwards).
 */

export const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js';

/** Render scale relative to PDF units (72 dpi): 3 gives about 216 dpi, which tesseract reads well. */
const RENDER_SCALE = 3;
const MAX_CANVAS_SIDE = 5000;

/**
 * Correct misreadings that matter for game data: in dice the digit 1 is often read as "i", "l" or "|"
 * ("2di2" for 2d12), and 0 as "o" ("1d1o").
 */
export function fixOcrText(text) {
    return text
        .replace(/(\d)d[il|I]([0-2])/g, '$1d1$2')
        .replace(/(\d)d([1-9])[oO]\b/g, '$1d$20')
        .replace(/(\d)d[il|I]\b/g, '$1d1');
}

/**
 * Parse tesseract's TSV output into lines of words.
 * Columns: level page block par line word left top width height conf text
 * @param {string} tsv
 * @returns {{bbox: {x0: number, y0: number, x1: number, y1: number}, words: {text: string, conf: number, bbox: object}[]}[]}
 */
export function parseTsv(tsv) {
    const lines = new Map();
    for (const row of tsv.split('\n').slice(1)) {
        const cols = row.split('\t');
        if (cols.length < 12) continue;
        const [level, , block, par, line, , left, top, width, height, conf] = cols.map(Number);
        const key = `${block}.${par}.${line}`;
        const bbox = { x0: left, y0: top, x1: left + width, y1: top + height };
        if (level === 4) lines.set(key, { bbox, words: [] });
        else if (level === 5) {
            const text = fixOcrText(cols.slice(11).join('\t').trim());
            if (text) lines.get(key)?.words.push({ text, conf, bbox });
        }
    }
    return [...lines.values()].filter(l => l.words.length);
}

/**
 * Group similar line heights so text of one style gets one font size; OCR boxes vary by a pixel or two
 * per line, while the parser compares sizes to tell headings from body text.
 * @param {number[]} heights
 * @returns {(height: number) => number}
 */
function sizeClusters(heights) {
    const sorted = [...heights].sort((a, b) => a - b);
    const clusters = [];
    for (const h of sorted) {
        const last = clusters.at(-1);
        if (last && h <= last.min * 1.18) last.values.push(h);
        else clusters.push({ min: h, values: [h] });
    }
    for (const c of clusters) c.size = c.values[Math.floor(c.values.length / 2)];
    return h => clusters.find(c => h >= c.min && h <= c.min * 1.18)?.size ?? h;
}

/**
 * Convert recognised lines (in pixels) to text items (in PDF units).
 * @param {ReturnType<typeof parseTsv>} lines
 * @param {number} scale        Pixels per PDF unit
 * @returns {import('./extract.mjs').TextItem[]}
 */
export function ocrLinesToItems(lines, scale) {
    // Line boxes include ascenders and descenders; the cap-to-descender height is about 1.2 em.
    const heights = lines.map(l => (l.bbox.y1 - l.bbox.y0) / scale / 1.2);
    const sizeOf = sizeClusters(heights);
    // Words of a line become phrases: OCR words are known to be separate, so they are joined with spaces
    // here instead of leaving it to gap measurements, and fewer items keep the column detection stable.
    const phrases = [];
    lines.forEach((line, index) => {
        const size = Math.max(4, Math.round(sizeOf(heights[index]) * 10) / 10);
        // Baseline: the line box bottom minus the descender depth.
        const baseline = line.bbox.y1 / scale - size * 0.22;
        let current = null;
        for (const word of line.words) {
            if (word.conf >= 0 && word.conf < 20 && !/\w/.test(word.text)) continue;
            const x0 = word.bbox.x0 / scale;
            const x1 = word.bbox.x1 / scale;
            if (current && x0 - current.right < size * 2) {
                current.str += ` ${word.text}`;
                current.right = x1;
            } else {
                current = { str: word.text, x: x0, right: x1, y: baseline, size };
                phrases.push(current);
            }
        }
    });

    return joinPhrases(phrases);
}

/**
 * Join recognised words or phrases that share a baseline and nearly touch into single items. Tesseract
 * sometimes splits one printed line into several when the spacing is wide, and OCR text layers (such as
 * OCRmyPDF's) place every word separately, which would make word gaps look like column gutters.
 * @param {{str: string, x: number, right?: number, w?: number, y: number, size: number}[]} phrases
 * @returns {import('./extract.mjs').TextItem[]}
 */
export function joinPhrases(phrases) {
    const sorted = phrases.map(p => ({ ...p, right: p.right ?? p.x + p.w })).sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    for (const phrase of sorted) {
        const near = merged.find(
            m =>
                Math.abs(m.y - phrase.y) < Math.min(m.size, phrase.size) * 0.4 &&
                Math.abs(m.size - phrase.size) <= Math.max(m.size, phrase.size) * 0.2 &&
                phrase.x >= m.right - 0.5 &&
                phrase.x - m.right < phrase.size * 2.5
        );
        if (near) {
            near.str += ` ${phrase.str}`;
            near.right = Math.max(near.right, phrase.right);
        } else merged.push({ ...phrase });
    }
    return merged.map(p => ({
        str: p.str,
        x: p.x,
        y: p.y,
        w: p.right - p.x,
        size: p.size,
        font: '',
        bold: false,
        italic: false,
        ocr: true
    }));
}

let tesseractPromise = null;

/** Load tesseract.js from the CDN. */
export function loadTesseract() {
    tesseractPromise ??= import(TESSERACT_URL)
        .then(module => module.default ?? module)
        .catch(error => {
            tesseractPromise = null;
            throw error;
        });
    return tesseractPromise;
}

/**
 * Recognise text on the given pages of a PDF (browser only).
 * @param {object} pdfjs                   The pdf.js library
 * @param {ArrayBuffer|Uint8Array} data    Raw PDF bytes (copied, the caller keeps its buffer)
 * @param {number[]} pageNumbers           1-based pages to recognise
 * @param {object} [options]
 * @param {(stage: 'loading'|'page', done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<Map<number, import('./extract.mjs').TextItem[]>>}
 */
export async function ocrPages(pdfjs, data, pageNumbers, { onProgress } = {}) {
    onProgress?.('loading', 0, pageNumbers.length);
    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker('eng');
    const bytes = new Uint8Array(data).slice();
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise;
    const results = new Map();
    try {
        for (const [done, number] of pageNumbers.entries()) {
            onProgress?.('page', done, pageNumbers.length);
            const page = await doc.getPage(number);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(RENDER_SCALE, MAX_CANVAS_SIDE / Math.max(base.width, base.height));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: context, viewport }).promise;
            const { data: result } = await worker.recognize(canvas, {}, { text: false, tsv: true });
            results.set(number, ocrLinesToItems(parseTsv(result.tsv ?? ''), scale));
            page.cleanup();
            canvas.width = canvas.height = 0;
        }
        onProgress?.('page', pageNumbers.length, pageNumbers.length);
    } finally {
        await worker.terminate();
        await doc.destroy();
    }
    return results;
}

/** Scale for the small line snippets used to recover glyphs (about 288 dpi). */
const REGION_SCALE = 4;

/**
 * Recognise small regions of pages, one line of text each (browser only). Used to learn glyphs that
 * have no text mapping (see glyphs.mjs).
 * @param {object} pdfjs
 * @param {ArrayBuffer|Uint8Array} data
 * @param {{page: number, x: number, y: number, w: number, h: number}[]} regions   In PDF units
 * @param {object} [options]
 * @param {(stage: 'loading'|'region', done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<string[]>}
 */
export async function ocrRegions(pdfjs, data, regions, { onProgress } = {}) {
    onProgress?.('loading', 0, regions.length);
    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker('eng');
    // Single text line, as the regions are cropped to one printed line.
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM?.SINGLE_LINE ?? '7' });
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data).slice(), isEvalSupported: false, verbosity: 0 }).promise;
    const texts = new Array(regions.length).fill('');
    try {
        const byPage = new Map();
        regions.forEach((r, i) => byPage.set(r.page, [...(byPage.get(r.page) ?? []), { ...r, i }]));
        let done = 0;
        for (const [number, list] of byPage) {
            const page = await doc.getPage(number);
            const viewport = page.getViewport({ scale: REGION_SCALE });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: context, viewport }).promise;
            for (const region of list) {
                onProgress?.('region', done++, regions.length);
                // Crop with a white border: tesseract reads text touching the image edge poorly.
                const border = 16;
                const crop = document.createElement('canvas');
                const sw = Math.max(1, Math.round(region.w * REGION_SCALE));
                const sh = Math.max(1, Math.round(region.h * REGION_SCALE));
                crop.width = sw + border * 2;
                crop.height = sh + border * 2;
                const c = crop.getContext('2d');
                c.fillStyle = '#fff';
                c.fillRect(0, 0, crop.width, crop.height);
                c.drawImage(canvas, Math.round(region.x * REGION_SCALE), Math.round(region.y * REGION_SCALE), sw, sh, border, border, sw, sh);
                const { data: result } = await worker.recognize(crop);
                texts[region.i] = result.text?.trim() ?? '';
            }
            page.cleanup();
            canvas.width = canvas.height = 0;
        }
        onProgress?.('region', regions.length, regions.length);
    } finally {
        await worker.terminate();
        await doc.destroy();
    }
    return texts;
}

/**
 * Recognise text inside images on pages that have a text layer, such as stat blocks pasted in as
 * pictures (browser only). Background images with text printed over them, small images and artwork
 * without readable text are skipped (see images.mjs).
 * @param {object} pdfjs
 * @param {ArrayBuffer|Uint8Array} data
 * @param {import('./extract.mjs').PageText[]} pages   Extracted pages, to know where text already is
 * @param {object} [options]
 * @param {(stage: 'loading'|'scan'|'region', done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<Map<number, {items: object[], regions: object[]}>>}  Recognised text by page
 */
export async function ocrImageRegions(pdfjs, data, pages, { onProgress } = {}) {
    const { findImageRegions, isMeaningfulText, regionsToRecognise, withoutDuplicates } = await import('./images.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data).slice(), isEvalSupported: false, verbosity: 0 }).promise;
    const results = new Map();
    let worker = null;
    try {
        // Finding images needs each page's operator list, which is the slow part on image-heavy PDFs.
        const candidates = [];
        const withText = pages.filter(p => p.items.some(i => i.str.trim() && !i.ocr));
        for (const [done, page] of withText.entries()) {
            onProgress?.('scan', done, withText.length);
            const regions = regionsToRecognise(page, await findImageRegions(pdfjs, await doc.getPage(page.number)));
            if (regions.length) candidates.push({ number: page.number, regions });
        }
        const total = candidates.reduce((n, c) => n + c.regions.length, 0);
        if (!total) return results;

        onProgress?.('loading', 0, total);
        const Tesseract = await loadTesseract();
        worker = await Tesseract.createWorker('eng');
        let done = 0;
        for (const { number, regions } of candidates) {
            const page = await doc.getPage(number);
            const viewport = page.getViewport({ scale: RENDER_SCALE });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: context, viewport }).promise;
            for (const region of regions) {
                onProgress?.('region', done++, total);
                const crop = document.createElement('canvas');
                crop.width = Math.max(1, Math.round(region.w * RENDER_SCALE));
                crop.height = Math.max(1, Math.round(region.h * RENDER_SCALE));
                crop.getContext('2d').drawImage(canvas, Math.round(region.x * RENDER_SCALE), Math.round(region.y * RENDER_SCALE), crop.width, crop.height, 0, 0, crop.width, crop.height);
                const { data: result } = await worker.recognize(crop, {}, { text: false, tsv: true });
                const pageText = pages.find(p => p.number === number);
                const items = withoutDuplicates(
                    pageText,
                    ocrLinesToItems(parseTsv(result.tsv ?? ''), RENDER_SCALE).map(i => ({ ...i, x: i.x + region.x, y: i.y + region.y }))
                );
                if (!isMeaningfulText(items)) continue;
                const entry = results.get(number) ?? { items: [], regions: [] };
                entry.items.push(...items);
                entry.regions.push(region);
                results.set(number, entry);
            }
            page.cleanup();
            canvas.width = canvas.height = 0;
        }
        onProgress?.('region', total, total);
    } finally {
        await worker?.terminate();
        await doc.destroy();
    }
    return results;
}
