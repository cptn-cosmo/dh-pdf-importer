/**
 * Low level PDF text extraction built on top of pdf.js.
 *
 * The pdf.js library is injected so the same code runs inside Foundry (which ships pdf.js at
 * `/scripts/pdfjs/build/pdf.mjs`) and inside Node for the parser test-suite.
 */

/**
 * @typedef {object} TextItem
 * @property {string} str      The text of this run
 * @property {number} x        Left edge in page units
 * @property {number} y        Baseline, measured from the top of the page
 * @property {number} w        Width
 * @property {number} size     Font size
 * @property {string} font     Font (PostScript) name, if known
 * @property {boolean} bold
 * @property {boolean} italic
 */

/**
 * @typedef {object} PageText
 * @property {number} number        1-based page number
 * @property {number} width
 * @property {number} height
 * @property {TextItem[]} items
 */

let pdfjsPromise = null;

import { MISSING_GLYPH, PRIVATE_USE, applyKnownGlyphs, resolveGlyphs } from './glyphs.mjs';
import { joinPhrases } from './ocr.mjs';

export { MISSING_GLYPH };

/** "HP" or "Stress" labels with neither a number nor tick-box characters after them. */
function pipLabels(items) {
    return items.filter(item => {
        if (!/^\s*(?:HP|Stress)\s*:?\s*$/i.test(item.str)) return false;
        const next = items
            .filter(i => i !== item && i.str.trim() && Math.abs(i.y - item.y) < item.size * 0.4 && i.x >= item.x + item.w - 1)
            .sort((a, b) => a.x - b.x)[0];
        // A value directly after the label means there is nothing to count.
        return !next || next.x - (item.x + item.w) > item.size * 0.3 || /^\s*\|/.test(next.str);
    });
}

const needsDrawnPips = items => pipLabels(items).length > 0;

/**
 * Turn small round or square shapes drawn on the row of an HP/Stress label into "○" items, so that tick
 * boxes drawn as vector graphics can be counted like printed ones.
 * @returns {Promise<TextItem[]>}
 */
async function drawnPips(pdfjs, page, items) {
    const labels = pipLabels(items);
    const { OPS, Util } = pdfjs;
    const [vx0, , , vy1] = page.view;
    let ops;
    try {
        ops = await page.getOperatorList();
    } catch {
        return [];
    }
    const paint = new Set([OPS.fill, OPS.eoFill, OPS.stroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const shapes = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
        else if (fn === OPS.constructPath && paint.has(ops.fnArray[i + 1])) {
            const bounds = pathBounds(OPS, args);
            if (!bounds) continue;
            const [minX, maxX, minY, maxY] = bounds;
            const corners = [[minX, minY], [maxX, maxY], [minX, maxY], [maxX, minY]].map(p => Util.applyTransform(p, ctm));
            const xs = corners.map(c => c[0]);
            const ys = corners.map(c => c[1]);
            shapes.push({ x: Math.min(...xs) - vx0, top: vy1 - Math.max(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
        }
    }
    const pips = [];
    for (const label of labels) {
        // The row ends at the next label or separator ("HP ○ ○ ○ | Stress ○ ○").
        const stop = items
            .filter(i => i !== label && i.str.trim() && Math.abs(i.y - label.y) < label.size * 0.4 && i.x > label.x + label.w)
            .sort((a, b) => a.x - b.x)[0];
        const limit = stop ? stop.x : label.x + label.size * 40;
        for (const s of shapes) {
            const size = Math.max(s.w, s.h);
            const roundish = size > label.size * 0.4 && size < label.size * 1.6 && Math.abs(s.w - s.h) < size * 0.35;
            const middle = s.top + s.h / 2;
            const onRow = Math.abs(middle - (label.y - label.size * 0.35)) < label.size * 0.6;
            if (roundish && onRow && s.x > label.x + label.w - 1 && s.x < limit) {
                pips.push({ str: '○', x: s.x, y: label.y, w: s.w, size: label.size, font: '', bold: false, italic: false, drawn: true });
            }
        }
    }
    return pips;
}

/**
 * Bounds of a constructPath operation as [minX, maxX, minY, maxY], from its own coordinates: the bounds
 * pdf.js reports leave out curves, so circles come out with no size.
 */
function pathBounds(OPS, [subOps, coords]) {
    const size = { [OPS.moveTo]: 2, [OPS.lineTo]: 2, [OPS.curveTo]: 6, [OPS.curveTo2]: 4, [OPS.curveTo3]: 4, [OPS.rectangle]: 4 };
    const xs = [];
    const ys = [];
    let j = 0;
    for (const op of subOps ?? []) {
        const n = size[op] ?? 0;
        const values = coords.slice(j, j + n);
        j += n;
        if (op === OPS.rectangle) {
            const [x, y, w, h] = values;
            xs.push(x, x + w);
            ys.push(y, y + h);
        } else {
            for (let k = 0; k < values.length; k += 2) {
                xs.push(values[k]);
                ys.push(values[k + 1]);
            }
        }
    }
    return xs.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : null;
}

/**
 * Type 3 fonts often report a font size of around 1 because their glyphs are scaled by the font matrix.
 * Give such items the size of the text next to them on the same line.
 * @param {object[]} items
 */
function fixTinySizes(items) {
    const normal = items.filter(i => i.size >= 3 && i.str.trim());
    for (const item of items) {
        if (item.size >= 3) continue;
        const neighbour = normal
            .filter(n => Math.abs(n.y - item.y) < 8)
            .sort((a, b) => Math.abs(a.x - item.x) - Math.abs(b.x - item.x))[0];
        item.size = neighbour?.size ?? (normal[0]?.size || 10);
    }
}

/**
 * Load the copy of pdf.js bundled with Foundry VTT.
 * @returns {Promise<object>}
 */
export function loadFoundryPdfjs() {
    pdfjsPromise ??= (async () => {
        // getRoute strips trailing slashes, so resolve each file on its own.
        const lib = await import(foundry.utils.getRoute('scripts/pdfjs/build/pdf.mjs'));
        lib.GlobalWorkerOptions.workerSrc = foundry.utils.getRoute('scripts/pdfjs/build/pdf.worker.mjs');
        return lib;
    })();
    return pdfjsPromise;
}

/**
 * Extract positioned text from every page of a PDF.
 * @param {object} pdfjs                     The pdf.js library
 * @param {Uint8Array|ArrayBuffer} data      Raw PDF bytes
 * @param {object} [options]
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{pages: PageText[], info: object}>}
 */
export async function extractPdf(pdfjs, data, { onProgress } = {}) {
    const bytes = data instanceof Uint8Array && data.constructor === Uint8Array ? data : new Uint8Array(data);
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise;
    const meta = await doc.getMetadata().catch(() => null);
    const pages = [];
    const fontNames = new Map();

    for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const [x0, y0, x1, y1] = page.view;
        const content = await page.getTextContent();

        // Font names are only transferred to the main thread while building an operator list, which is
        // expensive on image heavy pages. Font ids are document wide, so only do it when a page introduces
        // a font we have not resolved yet.
        const unknown = content.items.some(i => i.fontName && !fontNames.has(i.fontName));
        if (unknown) {
            try {
                await page.getOperatorList();
            } catch {
                /* formatting detection is best effort */
            }
            for (const item of content.items) {
                if (!item.fontName || fontNames.has(item.fontName)) continue;
                let name = '';
                try {
                    if (page.commonObjs.has(item.fontName)) name = page.commonObjs.get(item.fontName)?.name ?? '';
                } catch {
                    /* ignore */
                }
                fontNames.set(item.fontName, name);
            }
        }

        const items = [];
        for (const item of content.items) {
            if (!item.str) continue;
            const [a, b, c, d, e, f] = item.transform;
            // Skip rotated text, which is almost always decorative. A horizontal skew (c without b) is a
            // synthetic italic and is kept.
            if (Math.abs(b) > Math.abs(a) * 0.1 || Math.abs(d) < Math.abs(c)) continue;
            const skewed = Math.abs(c) > Math.abs(d) * 0.1;
            const size = Math.abs(d) || Math.abs(a) || item.height;
            if (!size) continue;
            const font = fontNames.get(item.fontName) ?? '';
            // Glyphs without a Unicode mapping come out as private-use code points. Keep the raw text and
            // the font so they can be recovered later (see glyphs.mjs); show them as MISSING_GLYPH meanwhile.
            const missing = PRIVATE_USE.test(item.str);
            PRIVATE_USE.lastIndex = 0;
            items.push({
                str: missing ? resolveGlyphs(item.str, item.fontName) : item.str,
                ...(missing ? { raw: item.str, fontId: item.fontName } : {}),
                x: e - x0,
                y: y1 - f,
                w: item.width,
                size,
                font,
                bold: /bold|black|heavy|semibold|demi/i.test(font),
                italic: skewed || /italic|oblique|[-,]it$/i.test(font)
            });
        }
        fixTinySizes(items);
        // Invisible text added by OCR tools (Tesseract's "GlyphLessFont", e.g. from OCRmyPDF) is OCR text:
        // flag it, and join its separately placed words into phrases.
        const layer = items.filter(i => /GlyphLessFont/i.test(i.font));
        if (layer.length) {
            const others = items.filter(i => !/GlyphLessFont/i.test(i.font));
            items.length = 0;
            items.push(...others, ...joinPhrases(layer.filter(i => i.str.trim())));
        }
        // HP and Stress may be printed as empty boxes drawn as shapes rather than characters.
        if (needsDrawnPips(items)) items.push(...(await drawnPips(pdfjs, page, items)));
        // Fonts known to keep alternate digits in the private-use area are resolved right away.
        applyKnownGlyphs([{ items }]);
        pages.push({ number: n, width: x1 - x0, height: y1 - y0, items });
        page.cleanup();
        onProgress?.(n, doc.numPages);
    }

    const info = { title: meta?.info?.Title ?? '', numPages: doc.numPages };
    await doc.destroy();
    return { pages, info };
}
