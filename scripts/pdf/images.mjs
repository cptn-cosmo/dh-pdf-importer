/**
 * Finds pictures of text inside pages that otherwise have a text layer, such as stat blocks pasted into
 * a PDF as images. Those regions can then be read with OCR and merged into the page's text.
 */

/** Ignore images smaller than this (in PDF units), they are icons or decoration. */
const MIN_WIDTH = 120;
const MIN_HEIGHT = 80;

/**
 * Bounding boxes of the images drawn on a page, in page units measured from the top left.
 * Requires the page's operator list, which decodes the page's images (slow on image-heavy PDFs).
 * @param {object} pdfjs   The pdf.js library (for OPS and Util)
 * @param {object} page    A pdf.js page
 * @returns {Promise<{x: number, y: number, w: number, h: number}[]>}
 */
export async function findImageRegions(pdfjs, page) {
    const { OPS, Util } = pdfjs;
    const [vx0, , , vy1] = page.view;
    const ops = await page.getOperatorList();
    const paint = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat]);
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const regions = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === OPS.transform) ctm = Util.transform(ctm, ops.argsArray[i]);
        else if (paint.has(fn)) {
            // Images are drawn into the unit square of the current transformation.
            const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(p => Util.applyTransform(p, ctm));
            const xs = corners.map(c => c[0]);
            const ys = corners.map(c => c[1]);
            const x0 = Math.min(...xs) - vx0;
            const x1 = Math.max(...xs) - vx0;
            const top = vy1 - Math.max(...ys);
            const bottom = vy1 - Math.min(...ys);
            if (x1 - x0 >= MIN_WIDTH && bottom - top >= MIN_HEIGHT) regions.push({ x: x0, y: top, w: x1 - x0, h: bottom - top });
        }
    }
    return regions;
}

/**
 * Of the image regions of a page, those worth reading: on the page, not mostly a duplicate of another
 * region, and without the page's own text printed on top (background artwork behind real text).
 * @param {{width: number, height: number, items: object[]}} page   Extracted page
 * @param {{x: number, y: number, w: number, h: number}[]} regions
 */
export function regionsToRecognise(page, regions) {
    const clip = r => {
        const x = Math.max(0, r.x);
        const y = Math.max(0, r.y);
        return { x, y, w: Math.min(page.width, r.x + r.w) - x, h: Math.min(page.height, r.y + r.h) - y };
    };
    const text = page.items.filter(i => i.str.trim() && !i.ocr);
    const chosen = [];
    for (const region of regions.map(clip)) {
        if (region.w < MIN_WIDTH || region.h < MIN_HEIGHT) continue;
        // A whole page background is handled by full page OCR of image-only pages.
        if (region.w * region.h > page.width * page.height * 0.85) continue;
        // Text printed over the image means it is a background; reading it would duplicate that text.
        const overlapping = text.filter(i => overlap(itemBox(i), region) > 0);
        if (overlapping.length >= 2) continue;
        if (chosen.some(c => overlap(c, region) > 0.8 * region.w * region.h)) continue;
        chosen.push(region);
    }
    return chosen;
}

/** The box of a text item, from its baseline and font size. */
const itemBox = i => ({ x: i.x, y: i.y - i.size * 0.8, w: i.w, h: i.size * 1.05 });

/**
 * Recognised items that don't duplicate text the page already has: words OCR read from an image that
 * has real text printed over part of it are dropped.
 * @param {{items: object[]}} page
 * @param {object[]} items   Recognised items in page coordinates
 */
export function withoutDuplicates(page, items) {
    const text = page.items.filter(i => i.str.trim() && !i.ocr).map(itemBox);
    return items.filter(item => {
        const box = itemBox(item);
        return !text.some(t => overlap(t, box) > box.w * box.h * 0.2);
    });
}

function overlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Keep recognised text only if it looks like real text, not noise found in artwork.
 * @param {object[]} items   OCR items of one region
 */
export function isMeaningfulText(items) {
    const words = items.flatMap(i => i.str.split(/\s+/)).filter(w => /[A-Za-z]{3,}/.test(w));
    return words.length >= 8;
}
