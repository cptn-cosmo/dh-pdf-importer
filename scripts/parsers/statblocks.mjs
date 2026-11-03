/**
 * Detects adversary and environment stat blocks.
 *
 * Supported layouts:
 *  - the official style:  "Difficulty: 14 | Thresholds: 8/15 | HP: 8 | Stress: 3" / "ATK: +3 | Claws: Very Close | 1d12+2 phy"
 *  - the compact style:   "Diff 13, Th 7/13, HP 6, Stress 3" / "Chipped Blade Melee +2, 1d8+2 phy"
 */
import {
    ADVERSARY_TYPES,
    ENVIRONMENT_TYPES,
    RANGE_PATTERN,
    cleanText,
    damageTypeOf,
    formatName,
    parseCosts,
    parseDamage,
    parseSigned,
    renderParagraphs,
    sliceRuns,
    splitTopLevel,
    toRange
} from './common.mjs';
import { MISSING_GLYPH } from '../pdf/extract.mjs';

const TIER_LINE = /^Tier\s*([1-4])\s*([A-Za-z][A-Za-z/ ]*?)\s*(?:\(\s*(\d+)\s*\/\s*HP\s*\))?\s*$/i;
const FEATURE_START =
    /^(?<name>[A-Z0-9“"'‘(][^:]{0,80}?)\s*[-–—:]\s*(?<form>Passive|Action|Reaction|Evolution)\s*[:.]\s*/;
const STAT_LINE = /^(?:D?ifficulty|Diff)\b\s*:?\s*(?:\d+|Special)/i;

/** Tick boxes printed instead of numbers: "HP: O O O", "Stress: ☐ ☐". */
const PIP = '[O○◯●◉□☐■▢⬜❍0o]';
const RANGE = `(?:${RANGE_PATTERN})`;
const DAMAGE = '[\\dd+\\-−–\\s]+?\\s*\\(?(?:phy\\w*|mag\\w*|kin\\w*|ene\\w*|stress)\\)?';

/**
 * Lines holding adversary statistics. They may be printed in a side column, so in reading order they
 * can appear anywhere in the block (even after the FEATURES heading); they are recognised by strict
 * patterns rather than position.
 */
const ADVERSARY_STAT_LINES = [
    STAT_LINE,
    /^(?:Thresholds?|Th)\b\s*:?\s*(?:\d|None)/i,
    /^Major\b\s*:?\s*\d+/i,
    new RegExp(`^(?:HP|Stress)\\s*:?\\s*(?:\\d|${PIP}(?:\\s*${PIP})*\\s*(?:$|\\||(?:HP|Stress)\\b))`, 'i'),
    /^(?:ATK|Attack Modifier)\s*:?\s*[+\-−–]?\s*\d/i,
    /^(?:Experiences?|Exp)\b\s*:?\s*[^\n]*?[+\-−–]\s*\d/i,
    // Bite - Melee - 1d6+3 phy / Dagger: Melee - 1d8+5 phy
    new RegExp(`^[^:|]{1,40}?\\s*[-:–]\\s*${RANGE}\\s*[-–|]\\s*${DAMAGE}`, 'i'),
    // Chipped Blade Melee +2, 1d8+2 phy
    new RegExp(`^[^:|]{1,40}?\\s${RANGE}\\s*[+\\-−–]\\s*\\d+\\s*,\\s*${DAMAGE}`, 'i')
];
export const isAdversaryStatLine = text => ADVERSARY_STAT_LINES.some(re => re.test(cleanText(text)));

/** Replace tick boxes by their count: "HP: O O O" -> "HP: 3". */
function countPips(text) {
    return text.replace(
        new RegExp(`\\b(HP|Stress)\\s*:?\\s*((?:${PIP}\\s*){1,30})(?=$|\\||\\n|(?:HP|Stress)\\b)`, 'gi'),
        // Keep a separator: "HP ○○ Stress ○" -> "HP: 2 Stress: 1".
        (_m, label, pips) => `${label}: ${pips.replace(/\s/g, '').length} `
    );
}
const FEATURES_HEADING = /^features?$/i;

/**
 * Is a line the start of a feature? Feature names may wrap onto a second line.
 * @returns {{name: string, form: string, lines: number, offset: number}|null}
 */
export function matchFeatureStart(lines, index) {
    const line = lines[index];
    if (!line || FEATURES_HEADING.test(line.text.trim())) return null;
    const attempt = (text, count) => {
        const match = text.match(FEATURE_START);
        if (!match) return null;
        const name = cleanText(match.groups.name);
        if (name.split(' ').length > 12 || /[.!?]\s+\S/.test(name.replace(/\([^)]*\)/g, ''))) return null;
        return { name, form: match.groups.form.toLowerCase(), lines: count, offset: match[0].length };
    };
    const single = attempt(line.text, 1);
    if (single) return single;
    // Only join when the header visibly wraps onto the next line(s): it ends with the dash ("… This! –" /
    // "Action: …"), the next line starts with the form, or a parenthesis is still open
    // ("Metamorphosis (Phase" / "Change) -" / "Passive: …").
    const wraps = (a, b) =>
        /[-–—]\s*$/.test(a.text) ||
        /^(?:Passive|Action|Reaction|Evolution)\s*[:.]/.test(b.text) ||
        (a.text.split('(').length > a.text.split(')').length && /^[^(]*\)/.test(b.text));
    let text = line.text;
    for (let count = 2; count <= 3; count++) {
        const previous = lines[index + count - 2];
        const next = lines[index + count - 1];
        if (!next || next.page !== line.page || previous.text.length >= 80 || !wraps(previous, next)) break;
        const consumed = text.length + 1;
        text = `${text} ${next.text}`;
        const joined = attempt(text, count);
        // The form keyword must be on the last joined line, so the header really spans these lines.
        if (joined && joined.offset > consumed) {
            joined.offset -= consumed;
            return joined;
        }
    }
    return null;
}

/**
 * Split the feature section of a stat block into features.
 * @param {import('../pdf/layout.mjs').Line[]} lines
 * @param {object} options
 */
export function parseFeatures(lines, { secretQuestions = false } = {}) {
    const features = [];
    const preamble = [];
    let current = null;
    for (let i = 0; i < lines.length; i++) {
        const start = matchFeatureStart(lines, i);
        if (start) {
            current = { name: start.name, form: start.form, entries: [] };
            features.push(current);
            const firstLine = lines[i + start.lines - 1];
            current.entries.push({ runs: sliceRuns(firstLine.runs, start.offset), line: firstLine });
            i += start.lines - 1;
            continue;
        }
        if (FEATURES_HEADING.test(lines[i].text.trim())) continue;
        (current?.entries ?? preamble).push({ runs: lines[i].runs, line: lines[i] });
    }

    return {
        preamble: renderParagraphs(preamble),
        features: features.map(f => {
            const { html, text } = renderParagraphs(f.entries, { secretQuestions });
            return { name: f.name, form: f.form, description: html, text, costs: parseCosts(text) };
        })
    };
}

/** Warn about text the PDF's fonts could not provide (see MISSING_GLYPH). */
function missingGlyphWarnings(features, statText) {
    const affected = features.filter(f => f.text.includes(MISSING_GLYPH) || f.name.includes(MISSING_GLYPH)).map(f => f.name);
    if (statText.includes(MISSING_GLYPH)) affected.unshift('Stats');
    return affected.length ? [`Some characters could not be read and are shown as ${MISSING_GLYPH}: ${affected.join(', ')}`] : [];
}

/** Build a name from heading lines, joining a phase title with a colon. */
function joinName(lines) {
    const title = lines.filter(l => l.isTitle);
    const rest = lines.filter(l => !l.isTitle);
    const name = formatName(rest.map(l => l.text).join(' '));
    const full = title.length ? `${formatName(title.map(l => l.text).join(' '))}: ${name}` : name;
    // "Thistlefolk Ambusher (Reference)": the stat block shared by several identical adversaries.
    return full.replace(/\s*\(Reference\)\s*$/i, '').replace(/^\p{Ll}/u, c => c.toUpperCase());
}

/** Collect the lines making up the name heading above a tier line. */
function findName(lines, tierIndex, floor) {
    const tier = lines[tierIndex];
    const parts = [];
    for (let i = tierIndex - 1; i >= floor && parts.length < 3; i--) {
        const line = lines[i];
        if (line.page !== tier.page) break;
        const larger = line.size > tier.size * 1.05;
        const caps = !/[a-z]/.test(line.text) && /[A-Z]/.test(line.text);
        if (!larger && !caps) break;
        const below = parts[0] ?? tier;
        const aligned = line.x < tier.right && line.right > tier.x;
        // A heading never mixes recognised text with the PDF's own text (an image of a stat block next
        // to commentary). OCR sizes are estimates, so allow a larger gap between OCR lines.
        if (!!line.ocr !== !!below.ocr) break;
        const maxGap = Math.max(line.size, below.size) * (line.ocr ? 3.2 : 2.2);
        if (!aligned || below.y - line.y > maxGap) break;
        // A larger line above the name is a title for a multi-phase adversary ("YOUNG THORN DRAGON" / "Laughing Lasher").
        const title = parts.length && line.size > parts[0].size + 1;
        if (parts.length && !title && Math.abs(line.size - parts[0].size) > 1) break;
        if (parts.length && !title && caps !== !/[a-z]/.test(parts[0].text)) break;
        if (title) line.isTitle = true;
        if (FEATURES_HEADING.test(line.text) || STAT_LINE.test(line.text)) break;
        // Running headers and footers carry a page number: "PISTOLHEART - ENVIRONMENTS 9".
        if (/^\d{1,3}\b|\b\d{1,3}$/.test(line.text.trim()) && /\p{L}{3}/u.test(line.text)) break;
        parts.unshift(line);
    }
    return parts;
}

/**
 * Find every stat block in a document.
 * @param {import('../pdf/layout.mjs').Line[]} lines
 * @returns {object[]}
 */
export function findStatBlocks(lines) {
    const anchors = [];
    lines.forEach((line, index) => {
        const match = line.text.match(TIER_LINE);
        if (!match) return;
        const words = match[2].toLowerCase().split(/[\s/]+/);
        if (!words.some(w => ADVERSARY_TYPES.includes(w) || ENVIRONMENT_TYPES.includes(w))) return;
        anchors.push({ index, match });
    });

    const blocks = [];
    anchors.forEach((anchor, n) => {
        const floor = n ? anchors[n - 1].index + 1 : 0;
        const nameLines = findName(lines, anchor.index, floor);
        if (!nameLines.length) return;
        const nextAnchor = anchors[n + 1];
        const hardEnd = nextAnchor ? nextAnchor.index - findName(lines, nextAnchor.index, anchor.index + 1).length : lines.length;

        // The block's body font size is that of the line describing it.
        const bodyLines = lines.slice(anchor.index + 1, Math.min(hardEnd, anchor.index + 12));
        const statLine = bodyLines.find(l => isAdversaryStatLine(l.text) || /^Impulses?:/i.test(l.text));
        const bodySize = statLine?.size ?? bodyLines[0]?.size ?? lines[anchor.index].size;

        const body = [];
        const blockLeft = lines[anchor.index].x;
        for (let i = anchor.index + 1; i < hardEnd; i++) {
            const line = lines[i];
            const prev = body.at(-1) ?? lines[anchor.index];
            // Text starting well left of the block's column (a footer, a centred link) is not part of it.
            if (line.page === prev.page && line.x < blockLeft - bodySize * 2) break;
            // Trackers for individual copies of the adversary follow some stat blocks: "Goathog #1 HP: O O O".
            if (/^\S.{0,40}#\s?\d+\b/.test(line.text) && !matchFeatureStart(lines, i)) break;
            const heading = FEATURES_HEADING.test(line.text.trim());
            // OCR sizes are estimates from line boxes, so allow more variation.
            // Larger text (headings, captions, prose) ends the block; slightly smaller text is often body
            // text the author shrank to fit, so it may differ more.
            const offSize = line => {
                const tolerance = line.ocr ? 0.5 : line.size < bodySize ? 0.18 : 0.12;
                return Math.abs(line.size - bodySize) > bodySize * tolerance;
            };
            if (!heading && offSize(line) && !isAdversaryStatLine(line.text)) {
                // Short decorative captions can sit between columns of a stat block; skip them when a
                // feature of the same block follows on the same page.
                let next = i;
                while (next < hardEnd && next - i < 3 && offSize(lines[next]) && lines[next].text.length < 40) next++;
                const resumes = next > i && next < hardEnd && !offSize(lines[next]) && lines[next].page === line.page;
                if (resumes && matchFeatureStart(lines, next)) {
                    i = next - 1;
                    continue;
                }
                break;
            }
            if (line.page !== prev.page && !matchFeatureStart(lines, i)) break;
            body.push(line);
        }
        blocks.push({
            name: joinName(nameLines),
            page: lines[anchor.index].page,
            tier: Number(anchor.match[1]),
            typeText: anchor.match[2],
            hordeHP: anchor.match[3] ? Number(anchor.match[3]) : null,
            body,
            sourceLines: [...nameLines, lines[anchor.index], ...body]
        });
    });
    return blocks;
}

/** Split lines before the first stat line into description and motives/impulses. */
function splitIntro(intro, labelRe) {
    const result = splitIntroLines(intro, labelRe);
    // Some layouts label the flavour text: "Description: A wild half-mountain goat…"
    const first = result.description[0];
    const label = first?.text.match(/^Description\s*:\s*/i);
    if (label) result.description = [{ ...first, text: first.text.slice(label[0].length), runs: sliceRuns(first.runs, label[0].length) }, ...result.description.slice(1)];
    return result;
}

function splitIntroLines(intro, labelRe) {
    const labelIndex = intro.findIndex(l => labelRe.test(l.text));
    if (labelIndex >= 0) {
        const label = cleanText(
            intro
                .slice(labelIndex)
                .map(l => l.text)
                .join(' ')
        ).replace(labelRe, '');
        return { description: intro.slice(0, labelIndex), label: label.trim() };
    }
    // Compact layouts omit the label: the description is set in italics, the motives are not.
    const italic = intro.filter(l => l.italic);
    if (italic.length && italic.length < intro.length) {
        return {
            description: italic,
            label: cleanText(
                intro
                    .filter(l => !l.italic)
                    .map(l => l.text)
                    .join(' ')
            )
        };
    }
    if (intro.length > 1) {
        return { description: intro.slice(0, -1), label: cleanText(intro.at(-1).text) };
    }
    return { description: intro, label: '' };
}

const linesToHtml = lines => renderParagraphs(lines.map(line => ({ runs: line.runs, line })));

function parseAttack(text) {
    const range = `(${RANGE_PATTERN})`;
    // ATK: +3 | Claws: Very Close | 1d12+2 phy
    let match = text.match(
        new RegExp(`ATK\\s*:?\\s*([+\\-−–]?\\s*\\d+)\\s*\\|\\s*(.+?)\\s*:?\\s*${range}\\s*\\|\\s*([\\dd+\\-−\\s]+?)\\s*\\(?(phy\\w*|mag\\w*|kin\\w*|ene\\w*|stress)`, 'i')
    );
    if (match) return { bonus: parseSigned(match[1]), name: cleanText(match[2]), range: toRange(match[3]), damage: parseDamage(match[4]), damageType: damageTypeOf(match[5]) };
    // Chipped Blade Melee +2, 1d8+2 phy
    match = text.match(
        new RegExp(`(?:^|\\n)([^\\n]+?)\\s+${range}\\s*([+\\-−–]\\s*\\d+)\\s*,\\s*([\\dd+\\-−\\s]+?)\\s*\\(?(phy\\w*|mag\\w*|kin\\w*|ene\\w*|stress)`, 'i')
    );
    if (match) return { bonus: parseSigned(match[3]), name: cleanText(match[1]), range: toRange(match[2]), damage: parseDamage(match[4]), damageType: damageTypeOf(match[5]) };
    // Bite - Melee - 1d6+3 phy  /  Dagger: Melee - 1d8+5 (phy), with the bonus on its own line ("ATK: +1",
    // "Attack Modifier: +1")
    match = text.match(
        new RegExp(`(?:^|\\n)([^\\n:|]+?)\\s*[-:–]\\s*${range}\\s*[-–|]\\s*([\\dd+\\-−\\s]+?)\\s*\\(?(phy\\w*|mag\\w*|kin\\w*|ene\\w*|stress)`, 'i')
    );
    if (match) {
        const bonus = text.match(/(?:^|\n)(?:ATK|Attack Modifier)\s*:?\s*([+\-−–]?\s*\d+)/i);
        return { bonus: bonus ? parseSigned(bonus[1]) : 0, name: cleanText(match[1]), range: toRange(match[2]), damage: parseDamage(match[3]), damageType: damageTypeOf(match[4]) };
    }
    return null;
}

function parseExperiences(text) {
    const match = text.match(/(?:^|\n)(?:Experiences?|Exp)\b\s*:?\s*([^\n]+)/i);
    if (!match) return [];
    return splitTopLevel(match[1])
        .map(part => part.match(/^(.+?)\s*([+\-−–]\s*\d+)$/))
        .filter(Boolean)
        .map(m => ({ name: cleanText(m[1]), value: parseSigned(m[2]) }));
}

function thresholds(text) {
    const value = v => (v && /\d/.test(v) ? Number(v) : null);
    const match = text.match(/\b(?:Thresholds?|Th)\b\s*:?\s*(\d+|None)(?:\s*\/\s*(\d+|None))?/i);
    if (match) return { major: value(match[1]), severe: value(match[2]) };
    // Major 4 | Severe 8
    const major = text.match(/\bMajor\b\s*:?\s*(\d+|None)/i);
    const severe = text.match(/\bSevere\b\s*:?\s*(\d+|None)/i);
    return { major: value(major?.[1]), severe: value(severe?.[1]) };
}

/**
 * Interpret an adversary stat block.
 * @param {object} block
 */
export function parseAdversary(block) {
    const lines = block.body;
    const isStat = line => isAdversaryStatLine(line.text);
    if (!lines.some(l => STAT_LINE.test(l.text))) return null;
    const firstStat = lines.findIndex(isStat);
    const { description, label: motives } = splitIntro(lines.slice(0, firstStat), /^Motives?\s*(?:&|and)\s*Tactics?\s*:\s*/i);

    const statText = countPips(
        lines
            .filter(isStat)
            .map(l => cleanText(l.text))
            .join('\n')
    );
    // Everything else after the stats is notes ("Note: ...") followed by the features.
    const rest = lines.slice(firstStat).filter(l => !isStat(l));

    const hp = statText.match(/\bHP\b\s*:?\s*(\d+)/i);
    const stress = statText.match(/\bStress\b\s*:?\s*(\d+)/i);
    const difficulty = statText.match(/\b(?:D?ifficulty|Diff)\b\s*:?\s*(\d+)/i);
    const { preamble, features } = parseFeatures(rest);

    const words = block.typeText.toLowerCase().split(/[\s/]+/);
    const type = words.find(w => ADVERSARY_TYPES.includes(w)) ?? 'standard';
    const horde = features.find(f => /^Horde\b/i.test(f.name));
    const hordeDamage = horde?.name.match(/\(([^)]+)\)/)?.[1] ?? horde?.text.match(/deals?\s+(\d+d\d+(?:\s*[+-]\s*\d+)?)/i)?.[1];

    const warnings = [];
    if (!hp) warnings.push('HP not found');
    if (!stress) warnings.push('Stress not found');
    const attack = parseAttack(statText);
    if (!attack) warnings.push('Standard attack not found');
    warnings.push(...missingGlyphWarnings(features, statText));

    return {
        kind: 'adversary',
        name: block.name,
        page: block.page,
        tier: block.tier,
        type,
        description: linesToHtml(description).html,
        motives,
        difficulty: difficulty ? Number(difficulty[1]) : null,
        thresholds: thresholds(statText),
        hp: hp ? Number(hp[1]) : null,
        stress: stress ? Number(stress[1]) : null,
        attack,
        experiences: parseExperiences(statText),
        hordeHP: type === 'horde' ? (block.hordeHP ?? 1) : null,
        hordeDamage: type === 'horde' ? (hordeDamage?.replace(/\s/g, '') ?? null) : null,
        notes: preamble.html,
        features,
        warnings
    };
}

/**
 * Interpret an environment stat block.
 * @param {object} block
 */
export function parseEnvironment(block) {
    const lines = block.body;
    const statIndex = lines.findIndex(l => STAT_LINE.test(l.text));
    const { description, label: impulses } = splitIntro(
        lines.slice(0, statIndex >= 0 ? statIndex : 0),
        /^Impulses?\s*:\s*/i
    );

    let featureIndex = lines.findIndex(
        (l, i) => i > statIndex && (FEATURES_HEADING.test(l.text.trim()) || matchFeatureStart(lines, i))
    );
    if (featureIndex < 0) featureIndex = lines.length;
    const statText = lines
        .slice(Math.max(statIndex, 0), featureIndex)
        .map(l => cleanText(l.text))
        .join(' ');
    const difficulty = statText.match(/\b(?:Difficulty|Diff)\b\s*:?\s*(\d+|Special)/i);
    const adversaryText = statText.match(/Potential Adversaries\s*:\s*(.+)$/i)?.[1] ?? '';
    const { features } = parseFeatures(lines.slice(featureIndex), { secretQuestions: true });

    const words = block.typeText.toLowerCase().split(/[\s/]+/);
    return {
        kind: 'environment',
        name: block.name,
        page: block.page,
        tier: block.tier,
        type: words.find(w => ENVIRONMENT_TYPES.includes(w)) ?? 'event',
        typeText: block.typeText,
        description: linesToHtml(description).html,
        impulses,
        difficulty: difficulty && /\d/.test(difficulty[1]) ? Number(difficulty[1]) : null,
        potentialAdversaries: parsePotentialAdversaries(adversaryText),
        features,
        warnings: [...(features.length ? [] : ['No features found']), ...missingGlyphWarnings(features, statText)]
    };
}

/**
 * "Busybody, Guards (Arcanist, Archer, Bladed, Head), Merchant"
 * @returns {{label: string, group: string, names: string[]}[]}
 */
export function parsePotentialAdversaries(text) {
    return splitTopLevel(cleanText(text).replace(/\.$/, '')).map(part => {
        const match = part.match(/^(.*?)\s*\((.+)\)\s*$/);
        if (!match) return { label: part, group: null, names: [part.replace(/\*$/, '')] };
        return {
            label: part,
            group: match[1],
            names: splitTopLevel(match[2]).map(n => n.replace(/\*$/, ''))
        };
    });
}

/**
 * Parse all stat blocks in a document.
 * @param {import('../pdf/layout.mjs').Line[]} lines
 */
export function parseStatBlocks(lines) {
    const results = [];
    for (const block of findStatBlocks(lines)) {
        const isEnvironment = block.body.some(l => /^Impulses?\s*:/i.test(l.text));
        const parsed = isEnvironment ? parseEnvironment(block) : parseAdversary(block);
        if (!parsed) continue;
        // Remember which lines were consumed so the journal can link to the entry instead of repeating it.
        Object.defineProperty(parsed, 'sourceLines', { value: block.sourceLines, enumerable: false });
        results.push(parsed);
    }
    return results;
}
