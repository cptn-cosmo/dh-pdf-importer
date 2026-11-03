/**
 * Character options: classes with their subclasses, ancestries, communities and domain cards.
 *
 * Classes and subclasses follow the SRD layout: a class title followed by "DOMAINS", "STARTING EVASION",
 * "STARTING HIT POINTS", "CLASS ITEMS", "HOPE FEATURE" and "CLASS FEATURE(S)", then "<CLASS> SUBCLASSES"
 * with, for each subclass, a "SPELLCAST TRAIT" (or "POWER TRAIT") and "FOUNDATION", "SPECIALIZATION" and
 * "MASTERY" features, and the class's "BACKGROUND QUESTIONS" and "CONNECTIONS".
 * Ancestries and communities are entries under an "Ancestry"/"Community" heading, with features written
 * as "Name: text". Domain cards use the SRD reference format: "NAME" / "Level 1 Arcana Spell" / "Recall Cost: 1".
 */
import { cleanText, formatName, renderParagraphs, sliceRuns } from './common.mjs';

const TRAITS = ['agility', 'strength', 'finesse', 'instinct', 'presence', 'knowledge'];

/** Domain card types of the system, and the card types of other games mapped onto them. */
const CARD_TYPES = {
    ability: 'ability',
    spell: 'spell',
    grimoire: 'grimoire',
    // The New Unknown
    skill: 'ability',
    tech: 'ability',
    psionic: 'spell',
    anomaly: 'spell',
    engram: 'spell',
    sigil: 'spell'
};

/** Text of a heading without decorative glyphs ("J POWER TRAIT", "■ Overview"). */
const headingText = line => cleanText(line.text).replace(/^(?:[■●•▪◆►›»]|[A-Z](?=\s+[A-Z]{2}))\s*/u, '');
const normalized = line => headingText(line).toUpperCase();

/** Is a line a heading at least `factor` times the body size? */
function isHeading(line, bodySize, factor = 1.25) {
    const text = headingText(line);
    return line.size >= bodySize * factor && text.length > 1 && text.length < 60 && !/[.,;]$/.test(text);
}

/** A sub-heading inside a section: slightly larger than the body and in capitals, like "TRIBUTE". */
function isSubHeading(line, bodySize) {
    const text = headingText(line);
    return line.size > bodySize * 1.05 && text.length < 40 && /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text);
}

/**
 * "Name: text" at the start of a line, preferably as a bold run. Returns the name and where the text
 * starts, or null.
 */
function namedStart(line) {
    const first = line.runs[0];
    const bold = first?.bold ? first.text : null;
    const source = bold?.includes(':') ? bold : line.text;
    const match = source.match(/^\s*([A-Z“"'‘][^:.!?]{1,48}?)\s*:\s*/u);
    if (!match) return null;
    const name = cleanText(match[1]);
    // Bold names may be several words; plain text names must be short to avoid sentences with colons.
    if (!bold && name.split(' ').length > 5) return null;
    if (/^(?:Note|Example|Recall Cost|Level|Tier)$/i.test(name)) return null;
    return { name, offset: match[0].length };
}

/**
 * Split lines into features. A feature starts at a sub-heading ("TRIBUTE") or at "Name: text"; inside
 * a sub-heading feature, "Name: text" lines are part of its text.
 * @returns {{name: string, description: string, text: string}[]}
 */
export function collectFeatures(lines, bodySize) {
    const features = [];
    let current = null;
    for (const line of lines) {
        if (isSubHeading(line, bodySize)) {
            current = { name: formatName(headingText(line)), entries: [], heading: true };
            features.push(current);
            continue;
        }
        // Under a sub-heading, "Name: text" lines ("Augmentation Die: …") belong to that feature.
        const start = current?.heading ? null : namedStart(line);
        if (start) {
            current = { name: start.name, entries: [{ runs: sliceRuns(line.runs, start.offset), line }], heading: false };
            features.push(current);
        } else current?.entries.push({ runs: line.runs, line });
    }
    return features
        .map(f => ({ name: f.name, ...renderParagraphs(f.entries) }))
        .map(({ name, html, text }) => ({ name, description: html, text }))
        .filter(f => f.text || f.description);
}

const toHtml = lines => renderParagraphs(lines.map(line => ({ runs: line.runs, line })));

/** Questions listed under a heading, one per paragraph, without the italic instructions. */
function questions(lines) {
    // Each question is its own block of text (and usually its own bullet).
    const groups = [];
    for (const line of lines) {
        const text = cleanText(line.text);
        if (line.italic || /^[•·▪-]?$/.test(text)) continue;
        const bullet = /^[•·▪-]\s+/.test(text);
        const last = groups.at(-1);
        if (last && last.block === line.block && !bullet) {
            last.text = last.soft ? last.text.replace(/-$/, '') + text : /\p{L}-$/u.test(last.text) ? last.text + text : `${last.text} ${text}`;
        } else groups.push({ block: line.block, text: text.replace(/^[•·▪-]\s+/, '') });
        groups.at(-1).soft = line.softHyphen;
    }
    return groups.map(g => cleanText(g.text)).filter(q => q.length > 3);
}

const domainNames = text =>
    cleanText(text)
        .split(/\s*(?:,|&|\band\b|\/)\s*/i)
        .map(d => d.replace(/\s+domain$/i, '').trim())
        // "Nibiru and one domain of your choice": keep only what looks like a domain name.
        .filter(d => /^\p{Lu}[\p{L}'’-]*(?: \p{Lu}[\p{L}'’-]*)?$/u.test(d));

/* -------------------------------------------- */
/*  Classes and subclasses                      */
/* -------------------------------------------- */

const CLASS_SECTIONS = ['DOMAINS', 'STARTING EVASION', 'STARTING HIT POINTS', 'CLASS ITEMS', 'HOPE FEATURE', 'CLASS FEATURE', 'CLASS FEATURES'];
const SUBCLASS_SECTIONS = /^(?:SPELLCAST(?:ING)? TRAIT|POWER TRAIT|FOUNDATION FEATURES?|SPECIALIZATION FEATURES?|MASTERY FEATURES?)$/;
const CLASS_TRAILER = /^(?:BACKGROUND QUESTIONS|CONNECTIONS)$/;

/**
 * Split a run of lines into sections by headings of (about) the given size.
 * @returns {{title: string, line: object, lines: object[]}[]}
 */
function sections(lines, headingSize, bodySize) {
    const result = [];
    let current = null;
    for (const line of lines) {
        if (isHeading(line, bodySize, 1.15) && Math.abs(line.size - headingSize) <= headingSize * 0.12) {
            current = { title: normalized(line), line, lines: [] };
            result.push(current);
        } else current?.lines.push(line);
    }
    return result;
}

function parseClasses(lines, bodySize) {
    const results = [];
    lines.forEach((line, index) => {
        if (normalized(line) !== 'DOMAINS' || !isHeading(line, bodySize, 1.15)) return;
        // A class page lists its starting statistics right after the domains.
        const next = lines.slice(index + 1, index + 12).map(normalized);
        if (!next.includes('STARTING EVASION') && !next.includes('STARTING HIT POINTS')) return;

        const headingSize = line.size;
        let titleIndex = -1;
        for (let i = index - 1; i >= Math.max(0, index - 40); i--) {
            if (lines[i].size >= headingSize * 1.4 && isHeading(lines[i], bodySize, 1.5)) {
                titleIndex = i;
                break;
            }
        }
        if (titleIndex < 0) return;
        const title = lines[titleIndex];
        const name = formatName(headingText(title));

        // The class runs until the next class title.
        let end = lines.length;
        for (let i = index + 1; i < lines.length; i++) {
            if (lines[i].size >= title.size * 0.9 && isHeading(lines[i], bodySize, 1.5)) {
                end = i;
                break;
            }
        }
        const body = lines.slice(index, end);
        const parts = sections(body, headingSize, bodySize);
        const part = title => parts.find(p => p.title === title);
        const number = title => Number(cleanText(part(title)?.lines.map(l => l.text).join(' ') ?? '').match(/\d+/)?.[0] ?? NaN);

        const subclassIndex = parts.findIndex(p => /SUBCLASSES$/.test(p.title));
        const classParts = subclassIndex >= 0 ? parts.slice(0, subclassIndex) : parts;
        const hope = collectFeatures(part('HOPE FEATURE')?.lines ?? [], bodySize);
        const classFeatures = collectFeatures(
            classParts.filter(p => /^CLASS FEATURES?$/.test(p.title)).flatMap(p => p.lines),
            bodySize
        );
        const description = toHtml(lines.slice(titleIndex + 1, index));

        const entry = {
            kind: 'class',
            name,
            page: title.page,
            description: description.html,
            domains: domainNames(part('DOMAINS')?.lines.map(l => l.text).join(' ') ?? ''),
            evasion: number('STARTING EVASION'),
            hitPoints: number('STARTING HIT POINTS'),
            classItems: cleanText(part('CLASS ITEMS')?.lines.map(l => l.text).join(' ') ?? ''),
            hopeFeature: hope[0] ?? null,
            features: classFeatures,
            backgroundQuestions: questions(part('BACKGROUND QUESTIONS')?.lines ?? []),
            connections: questions(part('CONNECTIONS')?.lines ?? []),
            warnings: []
        };
        if (!Number.isFinite(entry.evasion)) entry.warnings.push('Starting Evasion not found');
        if (!Number.isFinite(entry.hitPoints)) entry.warnings.push('Starting Hit Points not found');
        if (!entry.hopeFeature) entry.warnings.push('Hope feature not found');
        Object.defineProperty(entry, 'sourceLines', { value: [title, ...lines.slice(titleIndex + 1, end)], enumerable: false });
        results.push(entry);

        // The class title may be artwork; "MONOLITH SUBCLASSES" names the class reliably.
        const named = subclassIndex >= 0 ? parts[subclassIndex].title.replace(/\s+SUBCLASSES$/, '') : '';
        if (named && named.toLowerCase() !== entry.name.toLowerCase()) entry.name = formatName(named);
        if (subclassIndex >= 0) results.push(...parseSubclasses(parts.slice(subclassIndex + 1), entry, bodySize));
    });
    return results;
}

/** Subclasses: a heading that isn't a known section, followed by its trait and features. */
function parseSubclasses(parts, parent, bodySize) {
    const subclasses = [];
    let current = null;
    for (const part of parts) {
        if (CLASS_TRAILER.test(part.title)) {
            current = null;
            continue;
        }
        if (!SUBCLASS_SECTIONS.test(part.title)) {
            current = {
                kind: 'subclass',
                name: formatName(headingText(part.line)),
                page: part.line.page,
                className: parent.name,
                description: toHtml(part.lines).html,
                spellcastingTrait: null,
                traitText: '',
                features: { foundation: [], specialization: [], mastery: [] },
                warnings: []
            };
            Object.defineProperty(current, 'sourceLines', { value: [part.line, ...part.lines], enumerable: false });
            subclasses.push(current);
            continue;
        }
        if (!current) continue;
        current.sourceLines.push(part.line, ...part.lines);
        if (/TRAIT$/.test(part.title)) {
            // A trailing single capital is the icon of the next heading ("Agility J").
            current.traitText = cleanText(part.lines.map(l => l.text).join(' ')).replace(/\s+\p{Lu}$/u, '');
            current.spellcastingTrait = TRAITS.find(t => current.traitText.toLowerCase().startsWith(t)) ?? null;
            continue;
        }
        const level = /^FOUNDATION/.test(part.title) ? 'foundation' : /^SPECIALIZATION/.test(part.title) ? 'specialization' : 'mastery';
        current.features[level].push(...collectFeatures(part.lines, bodySize));
    }
    // Headings that are followed by neither a trait nor features are not subclasses (e.g. reference sheets).
    const real = subclasses.filter(s => s.traitText || Object.values(s.features).some(list => list.length));
    for (const s of real) {
        if (!s.features.foundation.length) s.warnings.push('Foundation feature not found');
    }
    return real;
}

/* -------------------------------------------- */
/*  Ancestries and communities                  */
/* -------------------------------------------- */

/**
 * Entries under a section heading such as "Ancestry" or "Communities": each entry is a heading followed
 * by its description and "Name: text" features.
 */
function parseEntrySections(lines, bodySize, sectionRe, kind) {
    const results = [];
    lines.forEach((line, index) => {
        if (!sectionRe.test(headingText(line)) || !isHeading(line, bodySize, 1.6)) return;
        const sectionSize = line.size;
        // Entry headings are smaller than the section heading but clearly larger than body text.
        const entryHeading = l => isHeading(l, bodySize, 1.2) && l.size < sectionSize * 0.85 && !/^(?:community|ancestry) features?$/i.test(headingText(l));
        let entry = null;
        for (let i = index + 1; i < lines.length; i++) {
            const l = lines[i];
            if (l.size >= sectionSize * 0.85 && isHeading(l, bodySize, 1.6)) break;
            if (entryHeading(l)) {
                entry = { line: l, lines: [] };
                results.push(entry);
            } else entry?.lines.push(l);
        }
    });
    return results.map(({ line, lines: body }) => buildEntry(kind, line, body, bodySize));
}

function buildEntry(kind, heading, body, bodySize) {
    // Text after a further heading (e.g. "TOUCHSTONES") is not part of the entry.
    const stop = body.findIndex(l => isSubHeading(l, bodySize) && !/FEATURES?$/.test(normalized(l)));
    const lines = stop >= 0 ? body.slice(0, stop) : body;
    const firstFeature = lines.findIndex(l => namedStart(l) || /FEATURES?$/.test(normalized(l)));
    const intro = firstFeature >= 0 ? lines.slice(0, firstFeature) : lines;
    const featureLines = (firstFeature >= 0 ? lines.slice(firstFeature) : []).filter(l => !/FEATURES?$/.test(normalized(l)));
    const entry = {
        kind,
        name: formatName(headingText(heading)),
        page: heading.page,
        description: toHtml(intro).html,
        features: collectFeatures(featureLines, bodySize),
        warnings: []
    };
    if (!entry.features.length) entry.warnings.push('No features found');
    Object.defineProperty(entry, 'sourceLines', { value: [heading, ...lines], enumerable: false });
    return entry;
}

/* -------------------------------------------- */
/*  Domain cards                                */
/* -------------------------------------------- */

const LEVEL_LINE = /^Level\s+(\d{1,2})\s+(.+?)\s+([A-Za-z]+)$/i;
const RECALL_LINE = /^Recall\s+Cost\s*:?\s*(\d+)/i;

function parseDomainCards(lines, bodySize) {
    const starts = [];
    lines.forEach((line, i) => {
        const level = cleanText(lines[i + 1]?.text ?? '').match(LEVEL_LINE);
        const recall = cleanText(lines[i + 2]?.text ?? '').match(RECALL_LINE);
        if (!level || !recall || !CARD_TYPES[level[3].toLowerCase()]) return;
        starts.push({ index: i, level, recall });
    });
    return starts.map((start, n) => {
        const nameLine = lines[start.index];
        const end = starts[n + 1]?.index ?? lines.length;
        const body = [];
        let name = headingText(nameLine);
        let from = start.index + 3;
        // A name cut at the column edge continues on the next line: "MY BODY IS A WEAPO" / "N".
        if (/^\p{Lu}{1,2}$/u.test(cleanText(lines[from]?.text ?? ''))) name += cleanText(lines[from++].text);
        for (let i = from; i < end; i++) {
            // A new domain section ("MARS DOMAIN") or a page title ends the card.
            if (isHeading(lines[i], bodySize, 1.3)) break;
            body.push(lines[i]);
        }
        const typeText = start.level[3];
        const entry = {
            kind: 'domainCard',
            name: formatName(name),
            page: nameLine.page,
            level: Number(start.level[1]),
            domain: cleanText(start.level[2]),
            cardType: CARD_TYPES[typeText.toLowerCase()],
            typeText: formatName(typeText),
            recallCost: Number(start.recall[1]),
            description: toHtml(body).html,
            warnings: body.length ? [] : ['No card text found']
        };
        Object.defineProperty(entry, 'sourceLines', { value: [nameLine, lines[start.index + 1], lines[start.index + 2], ...body], enumerable: false });
        return entry;
    });
}

/**
 * Parse all character options in a document.
 * @param {import('../pdf/layout.mjs').Line[]} lines
 * @param {number} bodySize
 */
export function parseOptions(lines, bodySize) {
    return [
        ...parseClasses(lines, bodySize),
        ...parseEntrySections(lines, bodySize, /^ancestr(?:y|ies)$/i, 'ancestry'),
        ...parseEntrySections(lines, bodySize, /^communit(?:y|ies)$/i, 'community'),
        ...parseDomainCards(lines, bodySize)
    ];
}
