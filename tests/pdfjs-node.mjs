// Locates a pdf.js build for running the parser outside Foundry. Set PDFJS_PATH to override.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

function candidates() {
    const list = [];
    if (process.env.PDFJS_PATH) list.push(process.env.PDFJS_PATH);
    const installs = path.join(os.homedir(), '.local/share/hochofen-v2/fvtt-installs');
    if (fs.existsSync(installs)) {
        for (const dir of fs.readdirSync(installs).sort().reverse()) {
            list.push(path.join(installs, dir, 'node_modules/@foundryvtt/pdfjs/build/pdf.mjs'));
        }
    }
    list.push(path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'));
    return list;
}

export async function loadNodePdfjs() {
    const found = candidates().find(p => fs.existsSync(p));
    if (!found) throw new Error('pdf.js not found; set PDFJS_PATH to a pdf.mjs build');
    return import(pathToFileURL(found).href);
}
