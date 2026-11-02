// Dev helper: run the full parser over a PDF and print a summary.  node tests/parse.mjs file.pdf [--json]
import fs from 'node:fs';
import { loadNodePdfjs } from './pdfjs-node.mjs';
import { extractPdf } from '../scripts/pdf/extract.mjs';
import { applyNodeOcr } from './ocr-node.mjs';
import { parseDocument } from '../scripts/parsers/index.mjs';

const pdfjs = await loadNodePdfjs();
const file = process.argv[2];
const extracted = await extractPdf(pdfjs, new Uint8Array(fs.readFileSync(file)));
if (process.argv.includes('--ocr')) applyNodeOcr(file, extracted);
const result = parseDocument(extracted, { fileName: file.split('/').at(-1) });

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
} else {
    for (const w of result.warnings) console.log("WARNING", w);
    console.log("ATTRIBUTION", JSON.stringify(result.attribution), "empty pages", result.emptyPages.join(","));
    for (const e of result.entries) {
        const stats =
            e.kind === 'adversary'
                ? `T${e.tier} ${e.type} D${e.difficulty} Th${e.thresholds.major}/${e.thresholds.severe} HP${e.hp} St${e.stress} ` +
                  `ATK ${e.attack ? `${e.attack.bonus} ${e.attack.name} ${e.attack.range} ${e.attack.damage?.formula} ${e.attack.damageType}` : '-'} ` +
                  `EXP[${e.experiences.map(x => `${x.name} ${x.value}`).join(', ')}]` +
                  (e.hordeHP ? ` horde ${e.hordeHP}/HP ${e.hordeDamage}` : '') +
                  `\n     motives: ${e.motives}\n     desc: ${e.description}` + (e.notes ? `\n     notes: ${e.notes}` : '')
                : e.kind === 'environment'
                  ? `T${e.tier} ${e.type} D${e.difficulty}\n     impulses: ${e.impulses}\n     desc: ${e.description}\n     adversaries: ${e.potentialAdversaries.map(a => a.group ? `${a.group}[${a.names.join('|')}]` : a.names[0]).join(', ')}`
                  : e.kind === 'journal'
                    ? `${e.pages.length} pages: ${e.pages.map(p => p.name).join(' / ')}`
                    : e.kind === "weapon" ? `${e.variantLabel} T${e.tier} ${e.secondary ? "secondary" : "primary"} ${e.trait} ${e.range} ${e.damage?.formula} ${e.damageType} ${e.burden} :: ${e.description}`
                    : `${e.variantLabel} T${e.tier} ${e.thresholds.major}/${e.thresholds.severe} score ${e.score} :: ${e.description}`;
        console.log(`[p${e.page ?? '-'}] ${e.kind.toUpperCase()} ${e.name}  ${stats}`);
        for (const f of e.features ?? []) {
            console.log(`     * ${f.name} (${f.form})${f.costs.length ? ' cost ' + f.costs.map(c => c.value + ' ' + c.key).join('+') : ''}: ${f.description.slice(0, process.env.FULL ? 5000 : 140)}`);
        }
        for (const w of e.warnings ?? []) console.log('     ! ' + w);
    }
}
