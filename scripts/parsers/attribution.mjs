/**
 * Guesses attribution details (source title and artists) for a PDF.
 */
import { cleanText } from './common.mjs';

/** Turn a file name like "Death_at_Helfast_Spire_v1_0.pdf" into "Death at Helfast Spire". */
export function titleFromFileName(fileName) {
    return cleanText(
        fileName
            .replace(/\.pdf$/i, '')
            .replace(/[_]+/g, ' ')
            .replace(/\s+-\s+(pages|spreads|print|screen|digital|web|printer friendly)$/i, '')
            .replace(/\s+v\d+(?:[ ._]\d+)*$/i, '')
    );
}

/**
 * Pick a source title. Metadata titles are often leftovers from templates ("menagerie2"), so they are
 * only trusted when they look like a real title.
 */
export function guessSource(info, fileName) {
    const meta = cleanText(info?.title ?? '').replace(/\s+v\d+(?:\.\d+)*$/i, '');
    const fromFile = titleFromFileName(fileName);
    const plausible =
        meta.split(' ').length >= 2 && /\p{Lu}/u.test(meta) && !/\d$/.test(meta.split(' ').at(-1) ?? '') && !/^untitled/i.test(meta);
    return plausible ? meta : fromFile || meta;
}

const ART_BY = /\b(?:cover|art|artwork|illustrations?|illustrated)\b[^:]*?\bby\s+(.+)$/i;
const ART_HEADING = /^(?:[\w ,&]*\b(?:art|artwork|artist|artists|illustrations?|illustrator)\b[\w ,&]*)$/i;
const NOT_ART = /\b(?:article|artifact|party|start|heart|smart|apart)\b/i;

const cleanArtist = text =>
    cleanText(text)
        .replace(/@\S+/g, '')
        .replace(/[.,;:\s]+$/, '')
        .trim();

/**
 * Find art credits in the first and last pages of the document.
 * @param {import('../pdf/layout.mjs').Line[]} lines
 * @returns {string}
 */
export function guessArtists(lines) {
    const pages = [...new Set(lines.map(l => l.page))];
    const creditPages = new Set([...pages.slice(0, 4), ...pages.slice(-3)]);
    const candidates = lines.filter(l => creditPages.has(l.page));
    const artists = [];
    const add = text => {
        for (const name of text.split(/\s*(?:,|;|\band\b|&)\s*/)) {
            const clean = cleanArtist(name.replace(/\([^)]*\)?/g, ''));
            if (clean && clean.split(' ').length <= 4 && /\p{Lu}/u.test(clean) && !artists.includes(clean)) artists.push(clean);
        }
    };
    candidates.forEach((line, index) => {
        const text = cleanText(line.text);
        if (NOT_ART.test(text) || text.length > 120) return;
        const by = text.match(ART_BY);
        if (by) {
            let names = by[1];
            // Credits may continue on the next line ("Art by A (Tomb), B" / "C (Citadel)")
            const next = candidates[index + 1];
            if (/,\s*$|\band\s*$/.test(text) && next?.page === line.page) names += ` ${next.text}`;
            add(names);
            return;
        }
        if (ART_HEADING.test(text) && text.split(' ').length <= 8) {
            const next = candidates[index + 1];
            if (next && next.page === line.page && !ART_HEADING.test(next.text) && next.text.length < 60) add(next.text);
        }
    });
    return artists.join(', ');
}

/**
 * @param {object} info              PDF metadata
 * @param {string} fileName
 * @param {import('../pdf/layout.mjs').Line[]} lines
 * @param {number} pageOffset
 */
export function guessAttribution(info, fileName, lines, pageOffset) {
    return { source: guessSource(info, fileName), artist: guessArtists(lines), pageOffset };
}
