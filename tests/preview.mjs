// Dev helper: render the review screen for a PDF to a standalone HTML file using stubbed Foundry globals.
// node tests/preview.mjs file.pdf out.html
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { loadNodePdfjs } from './pdfjs-node.mjs';

const fvtt = fs.readdirSync(path.join(os.homedir(), '.local/share/hochofen-v2/fvtt-installs')).sort().at(-1);
const require = createRequire(path.join(os.homedir(), '.local/share/hochofen-v2/fvtt-installs', fvtt, 'package.json'));
const Handlebars = require('handlebars');

const moduleLang = JSON.parse(fs.readFileSync('lang/en.json'));
const systemLang = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Projects/daggerheart/lang/en.json')));
const lookup = key => key.split('.').reduce((o, p) => o?.[p], moduleLang) ?? key.split('.').reduce((o, p) => o?.[p], systemLang) ?? key;
const format = (key, data) => String(lookup(key)).replace(/\{(\w+)\}/g, (_m, k) => data[k] ?? '');

class ApplicationV2 {
    async _prepareContext() { return {}; }
}
globalThis.foundry = {
    applications: { api: { ApplicationV2, HandlebarsApplicationMixin: Base => class extends Base {} } },
    utils: { randomID: () => Math.random().toString(36).slice(2, 18) }
};
globalThis.game = {
    i18n: { localize: lookup, format },
    actors: [],
    packs: [
        { documentName: 'Actor', locked: false, collection: 'world.monsters', title: 'Monsters', metadata: { packageName: 'world' }, getIndex: async () => [] },
        {
            documentName: 'Actor',
            locked: true,
            collection: 'daggerheart.adversaries',
            title: 'Adversaries',
            metadata: { packageName: 'daggerheart' },
            getIndex: async () => {
                const dir = path.join(os.homedir(), 'Projects/daggerheart/src/packs/adversaries');
                return fs.readdirSync(dir).filter(f => f.startsWith('adversary_')).map(f => ({
                    name: JSON.parse(fs.readFileSync(path.join(dir, f))).name,
                    type: 'adversary',
                    uuid: `Compendium.daggerheart.adversaries.Actor.${f.slice(-21, -5)}`
                }));
            }
        }
    ],
    settings: { get: (_m, key) => (key === 'importOptions' ? { folders: { mode: 'tierType', separateKinds: true } } : ['Example Supplement']) }
};
globalThis.CONFIG = {
    DH: {
        ACTOR: {
            adversaryTypes: Object.fromEntries(['bruiser', 'horde', 'leader', 'minion', 'ranged', 'skulk', 'social', 'solo', 'standard', 'support'].map(t => [t, { label: `DAGGERHEART.CONFIG.AdversaryType.${t}.label` }])),
            environmentTypes: Object.fromEntries(['exploration', 'social', 'traversal', 'event'].map(t => [t, { label: `DAGGERHEART.CONFIG.EnvironmentType.${t}.label` }]))
        },
        GENERAL: { attributionSources: { daggerheart: { label: 'Daggerheart', values: [{ label: 'Daggerheart SRD' }] } } }
    }
};

const { extractPdf } = await import('../scripts/pdf/extract.mjs');
const { applyNodeOcr } = await import('./ocr-node.mjs');
const { parseDocument } = await import('../scripts/parsers/index.mjs');
const { default: PdfImporter } = await import('../scripts/apps/pdf-importer.mjs');
const { collectCandidates } = await import('../scripts/linker.mjs');

const file = process.argv[2];
const app = new PdfImporter();
app.extracted = await extractPdf(await loadNodePdfjs(), new Uint8Array(fs.readFileSync(file)));
if (process.argv.includes('--ocr')) applyNodeOcr(file, app.extracted);
if (process.argv.includes('--recover')) {
    const { recoverGlyphs } = await import('../scripts/pdf/glyphs.mjs');
    const { ocrRegionsNode } = await import('./ocr-node.mjs');
    app.glyphsRecovered = (await recoverGlyphs(app.extracted.pages, async regions => ocrRegionsNode(file, regions))).resolved;
}
app.result = parseDocument(app.extracted, { fileName: path.basename(file) });
for (const e of app.result.entries) e.selected = true;
if (app.result.entries[1]) app.result.entries[1].selected = false;
app.attribution = { ...app.result.attribution };
app.linkIndex = await collectCandidates(app.result.entries);
app.fileName = path.basename(file);
app.stage = 'review';
app.ocrSelection = app.result.emptyPages.join(', ');
const context = await app._prepareContext({});

Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('or', (...args) => args.slice(0, -1).some(Boolean));
Handlebars.registerHelper('localize', (key, options) => (Object.keys(options.hash).length ? format(key, options.hash) : lookup(key)));
const html = Handlebars.compile(fs.readFileSync('templates/importer.hbs', 'utf8'))(context);
const css = fs.readFileSync('styles/importer.css', 'utf8');
fs.writeFileSync(process.argv[3], `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>body{margin:0;background:#0b0a13;color:#efe6d8;color-scheme:dark;font-family:sans-serif}
.window{width:980px;height:900px;margin:0}.window-content{height:100%}
button,input,select{background:#ffffff10;color:inherit;border:1px solid #7a7488;border-radius:4px;font:inherit}
fieldset{border:1px solid #7a7488} details summary{list-style:revert}
${css}</style></head><body><div class="application dh-pdf-importer window"><div class="window-content">${html}</div></div></body></html>`);
console.log('wrote', process.argv[3], context.groups.map(g => `${g.kind}:${g.count}`).join(' '));
