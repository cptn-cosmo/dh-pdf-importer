/**
 * Converts parsed entries into Foundry document source data for the Daggerheart system.
 */
import { randomId } from './parsers/common.mjs';

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

function buildJournal(entry, attribution, resolveLink) {
    const pages = entry.pages.map((page, index) => ({
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
    return {
        documentName: 'JournalEntry',
        data: {
            name: entry.name,
            pages,
            flags: { 'dh-pdf-importer': { attribution } }
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
 * @returns {{documentName: string, data: object}}
 */
export function buildDocument(entry, { attribution, resolveAdversaries, resolveLink, linkFeature }) {
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
        case 'journal':
            return buildJournal(entry, attr, resolveLink);
    }
    throw new Error(`Unknown entry kind ${entry.kind}`);
}
