/**
 * Detects weapon and armor tables ("Name | Trait | Range | Damage | Burden | Feature",
 * "Name | Base Thresholds | Armor Score | Feature") and turns their rows into items.
 *
 * Tables are parsed from positioned text rather than reading-order lines, because table columns
 * would otherwise be read one after another.
 */
import { RANGE_PATTERN, cleanText, damageTypeOf, formatName, parseDamage, toRange } from './common.mjs';

const TRAITS = ['agility', 'strength', 'finesse', 'instinct', 'presence', 'knowledge', 'spellcast'];
const FEATURE_START = /^([A-Z][\w’' -]{0,30}?)\s*(?::|\((?=[^)]*\)))/;

/** Group a page's items into rows by baseline. */
function toRows(items) {
    const rows = [];
    for (const item of items.filter(i => i.str.trim()).toSorted((a, b) => a.y - b.y || a.x - b.x)) {
        const row = rows.at(-1);
        if (row && Math.abs(item.y - row.items.at(-1).y) <= Math.max(1.5, item.size * 0.35)) row.items.push(item);
        else rows.push({ y: item.y, size: item.size, items: [item] });
    }
    for (const row of rows) row.items.sort((a, b) => a.x - b.x);
    return rows;
}

/** Merge items into words: small caps headers are split into fragments of different sizes. */
function toWords(items) {
    const words = [];
    for (const item of items) {
        const last = words.at(-1);
        if (last && item.x - last.right < Math.max(1.5, item.size * 0.25)) {
            last.text += item.str;
            last.right = item.x + item.w;
        } else words.push({ text: item.str, x: item.x, right: item.x + item.w });
    }
    return words.map(w => ({ ...w, key: w.text.toLowerCase().replace(/[^a-z]/g, '') }));
}

const WEAPON_COLUMNS = ['name', 'trait', 'range', 'damage', 'burden', 'feature'];

/**
 * Identify a table header row and the left edge of each column.
 * @returns {{kind: 'weapon'|'armor', columns: {key: string, x: number}[]}|null}
 */
function matchHeader(rows, index) {
    const words = toWords(rows[index].items);
    const keys = words.map(w => w.key);
    if (WEAPON_COLUMNS.every(k => keys.includes(k))) {
        return { kind: 'weapon', rows: 1, columns: WEAPON_COLUMNS.map(key => ({ key, x: words.find(w => w.key === key).x })) };
    }
    // Armor headers often wrap: "Base / Thresholds", "Armor / Score".
    if (keys.includes('name') && keys.includes('feature')) {
        const next = rows[index + 1] && rows[index + 1].y - rows[index].y < rows[index].size * 2 ? toWords(rows[index + 1].items) : [];
        const all = [...words, ...next];
        const find = (...names) => all.find(w => names.includes(w.key));
        const thresholds = find('basethresholds', 'thresholds', 'base');
        const score = find('armorscore', 'armor', 'score');
        if (thresholds && score) {
            const columns = [
                { key: 'name', x: find('name').x },
                { key: 'thresholds', x: Math.min(thresholds.x, find('base')?.x ?? Infinity) },
                { key: 'score', x: Math.min(score.x, find('armor')?.x ?? Infinity) },
                { key: 'feature', x: find('feature').x }
            ].sort((a, b) => a.x - b.x);
            return { kind: 'armor', rows: next.length && next.some(w => ['thresholds', 'score'].includes(w.key)) ? 2 : 1, columns };
        }
    }
    return null;
}

/** Split a row into cells according to column edges. */
function toCells(row, columns) {
    const cells = Object.fromEntries(columns.map(c => [c.key, '']));
    for (const item of row.items) {
        let column = columns[0];
        for (const c of columns) if (item.x >= c.x - 3) column = c;
        cells[column.key] = cleanText(`${cells[column.key]} ${item.str}`);
    }
    return cells;
}

/** Find a heading such as "Secondary Weapons" or "Tier 2 Armor" just above a table. */
function tableTitle(rows, headerIndex, floor) {
    const header = rows[headerIndex];
    for (let i = headerIndex - 1; i > floor && header.y - rows[i].y < 150; i--) {
        const text = cleanText(rows[i].items.map(it => it.str).join(' '));
        if (/weapon|armor|armour/i.test(text) && text.length < 60) return text;
    }
    return '';
}

/**
 * Parse one table into records with tier variants and features.
 */
function parseTable(rows, start, header, pageNumber) {
    const columns = header.columns;
    const left = columns[0].x - 6;
    const records = [];
    let record = null;
    let lastFeatureOwner = null;
    let end = start;

    let prev = rows[start - 1];
    const baseSize = Math.min(...prev.items.filter(it => it.x >= left).map(it => it.size));
    for (let i = start; i < rows.length; i++) {
        // Text left of the table (e.g. the facing page of a spread) is not part of it.
        const items = rows[i].items.filter(it => it.x >= left);
        if (!items.length) continue;
        const row = { ...rows[i], items, size: Math.max(...items.map(it => it.size)) };
        if (row.y - prev.y > Math.max(prev.size, row.size) * 5) break;
        if (row.size > baseSize * 1.6) break;
        prev = row;
        if (matchHeader(rows, i)) break;
        end = i;
        const cells = toCells(row, columns);
        const valueCell = header.kind === 'weapon' ? cells.damage : cells.thresholds;
        const isVariant = header.kind === 'weapon' ? /d\d+/.test(valueCell) : /\d+\s*\/\s*\d+/.test(valueCell);

        if (cells.name && (isVariant || !record)) {
            record = { name: cells.name, variants: [], features: [], page: pageNumber };
            records.push(record);
        } else if (cells.name && record) {
            record.name = `${record.name} ${cells.name}`;
        }
        if (!record) continue;

        if (isVariant) {
            const tier = Number(valueCell.match(/Tier\s*(\d)/i)?.[1] ?? 0) || null;
            record.variants.push({ tier, row: i, cells });
        }
        if (cells.feature) {
            const startsFeature = FEATURE_START.test(cells.feature) || !record.features.length;
            const owner = record.variants.at(-1)?.row ?? i;
            if (startsFeature || lastFeatureOwner?.record !== record) {
                lastFeatureOwner = { record, feature: { text: cells.feature, row: owner } };
                record.features.push(lastFeatureOwner.feature);
            } else lastFeatureOwner.feature.text = `${lastFeatureOwner.feature.text} ${cells.feature}`;
        }
    }
    return { records, end };
}

/** Feature text for a variant: its own feature, or the one shared by all tiers. */
function featureFor(record, variant) {
    if (record.features.length <= 1) return record.features[0]?.text ?? '';
    const own = record.features.filter(f => f.row <= variant.row).at(-1);
    return own?.text ?? record.features[0].text;
}

const featureHtml = text => {
    if (!text) return '';
    const match = text.match(FEATURE_START);
    if (!match) return `<p>${text}</p>`;
    const name = match[1].trim();
    const rest = text.slice(match[0].length - (match[0].endsWith('(') ? 1 : 0)).replace(/^\s*:?\s*/, '');
    return /^\(/.test(rest) ? `<p><strong>${name}</strong> ${rest}</p>` : `<p><strong>${name}:</strong> ${rest}</p>`;
};

function buildWeapons(table, title) {
    const secondary = /secondary/i.test(title);
    const titleTier = Number(title.match(/Tier\s*(\d)/i)?.[1] ?? 0) || null;
    const items = [];
    for (const record of table.records) {
        for (const variant of record.variants) {
            const { cells } = variant;
            const damageText = cells.damage.replace(/Tier\s*\d\s*:?/i, '').trim();
            const damageMatch = damageText.match(/^([\dd+\-−\s]+?)\s*(phy\w*|mag\w*)?$/i);
            const damage = parseDamage(damageMatch?.[1] ?? damageText);
            const trait = TRAITS.find(t => cells.trait.toLowerCase().includes(t)) ?? null;
            const tier = variant.tier ?? titleTier ?? 1;
            const feature = featureFor(record, variant);
            items.push({
                kind: 'weapon',
                name: formatName(record.name),
                variantLabel: record.variants.length > 1 ? `Tier ${tier}` : '',
                page: record.page,
                tier,
                secondary,
                trait,
                range: toRange(cells.range.match(new RegExp(RANGE_PATTERN, 'i'))?.[0]),
                damage,
                damageType: damageTypeOf(damageMatch?.[2] ?? 'phy'),
                burden: /two/i.test(cells.burden) ? 'twoHanded' : 'oneHanded',
                featureText: feature,
                description: featureHtml(feature),
                warnings: damage ? [] : ['Damage could not be read']
            });
        }
    }
    return items;
}

function buildArmor(table, title) {
    const titleTier = Number(title.match(/Tier\s*(\d)/i)?.[1] ?? 0) || null;
    const items = [];
    for (const record of table.records) {
        for (const variant of record.variants) {
            const { cells } = variant;
            const thresholds = cells.thresholds.match(/(\d+)\s*\/\s*(\d+)/);
            const tier = variant.tier ?? titleTier ?? 1;
            const feature = featureFor(record, variant);
            items.push({
                kind: 'armor',
                name: formatName(record.name),
                variantLabel: record.variants.length > 1 ? `Tier ${tier}` : '',
                page: record.page,
                tier,
                thresholds: { major: Number(thresholds[1]), severe: Number(thresholds[2]) },
                score: Number(cells.score.match(/\d+/)?.[0] ?? 0),
                featureText: feature,
                description: featureHtml(feature),
                warnings: cells.score ? [] : ['Armor score not found']
            });
        }
    }
    return items;
}

/**
 * Find weapon and armor tables on every page.
 * @param {import('../pdf/extract.mjs').PageText[]} pages
 */
export function parseEquipment(pages) {
    const results = [];
    for (const page of pages) {
        const rows = toRows(page.items);
        let floor = -1;
        let previousKind = null;
        for (let i = 0; i < rows.length; i++) {
            const header = matchHeader(rows, i);
            if (!header) continue;
            const title = tableTitle(rows, i, floor);
            const table = parseTable(rows, i + header.rows, header, page.number);
            // Without a readable title, a second weapon table directly after the first lists secondary weapons.
            const inferred = !title && header.kind === 'weapon' && previousKind === 'weapon' ? 'Secondary Weapons' : title;
            const items = header.kind === 'weapon' ? buildWeapons(table, inferred) : buildArmor(table, inferred);
            const region = { page: page.number, top: rows[i].y - rows[i].size, bottom: rows[table.end].y + 2 };
            for (const item of items) Object.defineProperty(item, 'region', { value: region, enumerable: false });
            results.push(...items);
            previousKind = header.kind;
            i = Math.max(i, table.end);
            floor = i;
        }
    }
    return results;
}
