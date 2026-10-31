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
            // Skip rotated text, which is almost always decorative.
            if (Math.abs(b) > Math.abs(a) * 0.1 || Math.abs(c) > Math.abs(d) * 0.1) continue;
            const size = Math.hypot(c, d) || Math.abs(a) || item.height;
            if (!size) continue;
            const font = fontNames.get(item.fontName) ?? '';
            items.push({
                str: item.str,
                x: e - x0,
                y: y1 - f,
                w: item.width,
                size,
                font,
                bold: /bold|black|heavy|semibold|demi/i.test(font),
                italic: /italic|oblique|[-,]it$/i.test(font)
            });
        }
        pages.push({ number: n, width: x1 - x0, height: y1 - y0, items });
        page.cleanup();
        onProgress?.(n, doc.numPages);
    }

    const info = { title: meta?.info?.Title ?? '', numPages: doc.numPages };
    await doc.destroy();
    return { pages, info };
}
