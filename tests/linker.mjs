// Checks adversary name matching against the system compendium (and optionally adversaries from other PDFs).
// node tests/linker.mjs environments.pdf [adversaries.pdf ...]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadNodePdfjs } from './pdfjs-node.mjs';
import { extractPdf } from '../scripts/pdf/extract.mjs';
import { parseDocument } from '../scripts/parsers/index.mjs';
import { buildIndex, linkText, matchGroup } from '../scripts/linker.mjs';

const pdfjs = await loadNodePdfjs();
const parse = async file => parseDocument(await extractPdf(pdfjs, new Uint8Array(fs.readFileSync(file))), { fileName: path.basename(file) });
const packDir = path.join(os.homedir(), 'Projects/daggerheart/src/packs/adversaries');
const candidates = fs
    .readdirSync(packDir)
    .filter(f => f.startsWith('adversary_'))
    .map(f => ({ name: JSON.parse(fs.readFileSync(path.join(packDir, f))).name, uuid: `Compendium.daggerheart.adversaries.Actor.${f}`, priority: 2 }));
for (const file of process.argv.slice(3)) {
    for (const e of (await parse(file)).entries) if (e.kind === 'adversary') candidates.push({ name: e.name, uuid: `World.${e.name}`, priority: 1 });
}
const index = buildIndex(candidates);
const result = await parse(process.argv[2]);
let matched = 0;
let total = 0;
const missing = new Set();
for (const env of result.entries.filter(e => e.kind === 'environment')) {
    const allowed = new Set();
    for (const group of env.potentialAdversaries) {
        for (const { name, matches } of matchGroup(index, group)) {
            if (/^(any|see)/i.test(name)) continue;
            total++;
            if (matches.length) {
                matched++;
                for (const m of matches) allowed.add(m[0].name.toLowerCase());
                if (process.env.VERBOSE) console.log(`  ${group.label} :: ${name} -> ${matches.map(m => m[0].name).join(' + ')}`);
            } else missing.add(group.group ? `${group.group} (${name})` : name);
        }
    }
    for (const f of env.features) {
        const html = linkText(f.description, index, { allowed: new Set([...allowed].map(n => n.replace(/[^\p{L}\p{N}]+/gu, ' '))), link: (c, text) => `[[${text}→${c[0].name}]]` });
        for (const m of html.matchAll(/\[\[[^\]]+\]\]/g)) if (process.env.VERBOSE || process.env.TEXT) console.log(`  ${env.name} / ${f.name}: ${m[0]}`);
    }
}
console.log(`potential adversaries matched: ${matched}/${total}`);
console.log(`unmatched: ${[...missing].join(', ')}`);
