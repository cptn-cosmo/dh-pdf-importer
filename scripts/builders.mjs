/**
 * Converts parsed entries into Foundry document source data for the Daggerheart system.
 */
import { parseCosts, randomId } from './parsers/common.mjs';

const newId = () => globalThis.foundry?.utils?.randomID?.() ?? randomId();

export const ICONS = {
    passive: 'icons/magic/symbols/runes-carved-stone-yellow.webp',
    action: 'icons/creatures/abilities/tail-strike-bone-orange.webp',
    reaction: 'icons/magic/defensive/shield-barrier-glowing-triangle-blue.webp',
    evolution: 'icons/magic/control/mouth-smile-deception-purple.webp',
    attack: 'icons/skills/melee/blood-slash-foam-red.webp',
    armor: 'icons/equipment/chest/breastplate-banded-steel.webp'
};

/**
 * The attribution stored on every imported document.
 * @param {{source: string, artist: string, pageOffset: number}} attribution
 * @param {number} pdfPage
 */
export function attributionFor(attribution, pdfPage) {
    const page = pdfPage ? pdfPage + (Number(attribution.pageOffset) || 0) : null;
    return {
        source: attribution.source?.trim() ?? '',
        page: page && page > 0 ? page : null,
        artist: attribution.artist?.trim() ?? ''
    };
}

/** Damage value data for an action. */
function damageValue(damage, multiplier = 'flat') {
    if (!damage) return { custom: { enabled: false, formula: '' }, multiplier, flatMultiplier: 1, dice: 'd6', bonus: null };
    if (!damage.dice) {
        return { custom: { enabled: true, formula: damage.formula }, multiplier: 'flat', flatMultiplier: 1, dice: 'd6', bonus: null };
    }
    return {
        custom: { enabled: false, formula: '' },
        multiplier,
        flatMultiplier: damage.count ?? 1,
        dice: damage.dice,
        bonus: damage.bonus
    };
}

function damagePart(damage, damageType, multiplier) {
    const stress = damageType === 'stress';
    return {
        value: damageValue(damage, multiplier),
        applyTo: stress ? 'stress' : 'hitPoints',
        type: stress ? [] : [damageType]
    };
}

/** A resource-spending action so costs like "Mark a Stress" can be paid from the sheet. */
function costAction(feature) {
    const id = newId();
    return {
        [id]: {
            type: 'effect',
            _id: id,
            systemPath: 'actions',
            name: feature.name,
            img: ICONS[feature.form] ?? ICONS.action,
            description: '',
            chatDisplay: true,
            actionType: feature.form === 'reaction' ? 'reaction' : 'action',
            cost: feature.costs.map(c => ({
                scalable: false,
                key: c.key,
                value: c.value,
                step: null,
                itemId: null,
                consumeOnSuccess: false
            })),
            uses: { value: null, max: null, recovery: null, consumeOnSuccess: false },
            target: { type: 'any', amount: null },
            effects: []
        }
    };
}

function buildFeature(feature, attribution) {
    return {
        _id: newId(),
        name: feature.name,
        type: 'feature',
        img: ICONS[feature.form] ?? ICONS.passive,
        system: {
            description: feature.description,
            featureForm: ['passive', 'action', 'reaction', 'evolution'].includes(feature.form) ? feature.form : 'passive',
            actions: feature.costs?.length ? costAction(feature) : {},
            attribution
        }
    };
}

function buildAdversary(entry, attribution) {
    const experiences = {};
    for (const exp of entry.experiences) experiences[newId()] = { name: exp.name, value: exp.value ?? 1, description: '' };

    const attack = entry.attack
        ? {
              name: entry.attack.name || 'Attack',
              img: ICONS.attack,
              _id: '000BASEATTACK000',
              systemPath: 'attack',
              chatDisplay: false,
              type: 'attack',
              range: entry.attack.range ?? 'melee',
              target: { type: 'any', amount: 1 },
              roll: { type: 'attack', bonus: entry.attack.bonus ?? 0 },
              damage: { main: damagePart(entry.attack.damage, entry.attack.damageType, 'flat') }
          }
        : undefined;

    const system = {
        tier: entry.tier,
        type: entry.type,
        description: entry.description,
        motivesAndTactics: entry.motives,
        notes: entry.notes ?? '',
        difficulty: entry.difficulty ?? 10,
        damageThresholds: { major: entry.thresholds.major ?? 0, severe: entry.thresholds.severe ?? 0 },
        resources: {
            hitPoints: { value: 0, max: entry.hp ?? 1 },
            stress: { value: 0, max: entry.stress ?? 0 }
        },
        experiences,
        attribution
    };
    if (attack) system.attack = attack;
    if (entry.type === 'horde') {
        system.typeData = { type: 'horde', hordeHP: entry.hordeHP ?? 1, hordeDamage: entry.hordeDamage ?? '1d4' };
    }

    return {
        documentName: 'Actor',
        data: {
            name: entry.name,
            type: 'adversary',
            system,
            prototypeToken: { name: entry.name, disposition: -1, actorLink: false },
            items: entry.features.map(f => buildFeature(f, attribution))
        }
    };
}

function buildEnvironment(entry, attribution, resolveAdversaries, linkFeature) {
    const potentialAdversaries = {};
    for (const group of entry.potentialAdversaries) {
        potentialAdversaries[newId()] = {
            label: group.label,
            adversaries: resolveAdversaries?.(group) ?? []
        };
    }
    return {
        documentName: 'Actor',
        data: {
            name: entry.name,
            type: 'environment',
            system: {
                tier: entry.tier,
                type: entry.type,
                description: entry.description,
                impulses: entry.impulses,
                difficulty: entry.difficulty ?? 10,
                potentialAdversaries,
                attribution
            },
            items: entry.features.map(f =>
                buildFeature(linkFeature ? { ...f, description: linkFeature(f.description) } : f, attribution)
            )
        }
    };
}

const itemName = entry => (entry.variantLabel ? `${entry.name} (${entry.variantLabel})` : entry.name);

function buildWeapon(entry, attribution) {
    return {
        documentName: 'Item',
        data: {
            name: itemName(entry),
            type: 'weapon',
            system: {
                tier: entry.tier,
                secondary: entry.secondary,
                burden: entry.burden,
                description: entry.description,
                attribution,
                attack: {
                    name: 'Attack',
                    img: ICONS.attack,
                    _id: newId(),
                    baseAction: true,
                    chatDisplay: false,
                    systemPath: 'attack',
                    type: 'attack',
                    range: entry.range ?? 'melee',
                    target: { type: 'any', amount: 1 },
                    roll: { trait: entry.trait, type: 'attack' },
                    damage: { main: damagePart(entry.damage, entry.damageType, 'prof') }
                }
            }
        }
    };
}

function buildArmor(entry, attribution) {
    return {
        documentName: 'Item',
        data: {
            name: itemName(entry),
            type: 'armor',
            img: ICONS.armor,
            system: {
                tier: entry.tier,
                armor: { current: 0, max: entry.score },
                baseThresholds: entry.thresholds,
                description: entry.description,
                attribution
            }
        }
    };
}

function buildJournal(entry, attribution, resolveLink, pdfSrc) {
    const mode = entry.mode ?? 'text';
    const textPages = mode === 'pdf' ? [] : entry.pages;
    const pages = textPages.map((page, index) => ({
        name: page.name,
        type: 'text',
        sort: (index + 1) * 100000,
        text: {
            format: 1,
            content: page.html.replace(/<p data-dhpi-link="([^"]+)"><\/p>/g, (_m, id) => {
                const link = resolveLink?.(id);
                return link ? `<p>${link}</p>` : '';
            })
        }
    }));
    // The original PDF goes after the text pages so the linked text stays the first thing shown.
    if (mode !== 'text') {
        if (!pdfSrc) throw new Error('No PDF file to attach to the journal');
        pages.push({ name: entry.pdfName ?? entry.name, type: 'pdf', sort: (pages.length + 1) * 100000, src: pdfSrc });
    }
    return {
        documentName: 'JournalEntry',
        data: {
            name: entry.name,
            pages,
            flags: { 'dh-pdf-importer': { attribution } }
        }
    };
}

/* -------------------------------------------- */
/*  Character options                           */
/* -------------------------------------------- */

/**
 * A feature Item that an option links to. Option features are separate Items in the system: the
 * ancestry, community, class or subclass refers to them by UUID.
 * @param {{name: string, description: string, text: string}} feature
 * @param {string|null} link   How the parent refers to it: primary/secondary, hope/class, foundation/…
 */
function optionFeature(feature, link, attribution) {
    const costs = parseCosts(feature.text ?? '');
    const form = costs.length ? 'action' : 'passive';
    return {
        link,
        data: {
            name: feature.name,
            type: 'feature',
            system: {
                description: feature.description,
                featureForm: form,
                actions: costs.length ? costAction({ name: feature.name, form, costs }) : {},
                attribution
            }
        }
    };
}

/** Kebab-case id for a homebrew domain, like the system's own domain creation ("String#slugify"). */
export const domainSlug = label =>
    label
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

function buildAncestry(entry, attribution) {
    return {
        documentName: 'Item',
        data: { name: entry.name, type: 'ancestry', system: { description: entry.description, attribution } },
        // The system shows the first two features as the primary and secondary ancestry features.
        features: entry.features.map((f, i) => optionFeature(f, ['primary', 'secondary'][i] ?? null, attribution)),
        linkFeatures: links => ({ 'system.features': links.map(l => ({ type: l.link, item: l.uuid })) })
    };
}

function buildCommunity(entry, attribution) {
    return {
        documentName: 'Item',
        data: { name: entry.name, type: 'community', system: { description: entry.description, attribution } },
        features: entry.features.map(f => optionFeature(f, null, attribution)),
        linkFeatures: links => ({ 'system.features': links.map(l => l.uuid) })
    };
}

function buildClass(entry, attribution, resolveDomain) {
    // Class items are free text in the PDF; the system expects Item UUIDs, so they go in the description.
    const items = entry.classItems ? `<p><strong>Class Items:</strong> ${entry.classItems}</p>` : '';
    const pad = list => [...list, '', '', ''].slice(0, Math.max(3, list.length));
    return {
        documentName: 'Item',
        data: {
            name: entry.name,
            type: 'class',
            system: {
                description: entry.description + items,
                domains: entry.domains.map(d => resolveDomain?.(d) ?? domainSlug(d)),
                ...(Number.isFinite(entry.hitPoints) ? { hitPoints: entry.hitPoints } : {}),
                ...(Number.isFinite(entry.evasion) ? { evasion: entry.evasion } : {}),
                backgroundQuestions: pad(entry.backgroundQuestions),
                connections: pad(entry.connections),
                attribution
            }
        },
        features: [
            ...(entry.hopeFeature ? [optionFeature(entry.hopeFeature, 'hope', attribution)] : []),
            ...entry.features.map(f => optionFeature(f, 'class', attribution))
        ],
        linkFeatures: links => ({ 'system.features': links.map(l => ({ type: l.link, item: l.uuid })) })
    };
}

function buildSubclass(entry, attribution, resolveClass) {
    return {
        documentName: 'Item',
        data: {
            name: entry.name,
            type: 'subclass',
            system: {
                description: entry.description,
                spellcastingTrait: entry.spellcastingTrait,
                linkedClass: resolveClass?.(entry.className) ?? null,
                attribution
            }
        },
        features: ['foundation', 'specialization', 'mastery'].flatMap(level =>
            entry.features[level].map(f => optionFeature(f, level, attribution))
        ),
        linkFeatures: links => ({ 'system.features': links.map(l => ({ type: l.link, item: l.uuid })) })
    };
}

function buildDomainCard(entry, attribution, resolveDomain) {
    return {
        documentName: 'Item',
        data: {
            name: entry.name,
            type: 'domainCard',
            system: {
                description: entry.description,
                domain: resolveDomain?.(entry.domain) ?? domainSlug(entry.domain),
                level: entry.level,
                recallCost: entry.recallCost,
                type: entry.cardType,
                attribution
            },
            // Card types of other games ("Anomaly", "Skill") map onto ability/spell; keep the original.
            flags: { 'dh-pdf-importer': { cardType: entry.typeText } }
        }
    };
}

/**
 * Build document data for an entry.
 * @param {object} entry
 * @param {object} context
 * @param {{source: string, artist: string, pageOffset: number}} context.attribution
 * @param {(group: object) => string[]} [context.resolveAdversaries]  Potential adversary UUIDs
 * @param {(id: string) => string|null} [context.resolveLink]           Content link for an entry id
 * @param {(html: string) => string} [context.linkFeature]             Adds adversary links to feature text
 * @param {(label: string) => string} [context.resolveDomain]          Domain id for a domain name
 * @param {(name: string) => string|null} [context.resolveClass]       Class UUID for a subclass's class name
 * @param {string} [context.pdfSrc]                                     Path of the PDF for a journal in "pdf" or "both" mode
 * @returns {{documentName: string, data: object, features?: {link: string|null, data: object}[], linkFeatures?: Function}}
 *   Options also return the feature Items to create first, and how to link them once they have UUIDs.
 */
export function buildDocument(entry, { attribution, resolveAdversaries, resolveLink, linkFeature, pdfSrc, resolveDomain, resolveClass }) {
    const attr = attributionFor(attribution, entry.page);
    switch (entry.kind) {
        case 'adversary':
            return buildAdversary(entry, attr);
        case 'environment':
            return buildEnvironment(entry, attr, resolveAdversaries, linkFeature);
        case 'weapon':
            return buildWeapon(entry, attr);
        case 'armor':
            return buildArmor(entry, attr);
        case 'ancestry':
            return buildAncestry(entry, attr);
        case 'community':
            return buildCommunity(entry, attr);
        case 'class':
            return buildClass(entry, attr, resolveDomain);
        case 'subclass':
            return buildSubclass(entry, attr, resolveClass);
        case 'domainCard':
            return buildDomainCard(entry, attr, resolveDomain);
        case 'journal':
            return buildJournal(entry, attr, resolveLink, pdfSrc);
    }
    throw new Error(`Unknown entry kind ${entry.kind}`);
}
