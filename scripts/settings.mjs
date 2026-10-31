/**
 * Module settings, including the attribution sources added by previous imports.
 */
export const MODULE_ID = 'dh-pdf-importer';

const SOURCES_SETTING = 'attributionSources';
const OPTIONS_SETTING = 'importOptions';
const PDF_FOLDER_SETTING = 'pdfFolder';
const DEFAULT_PDF_FOLDER = 'assets/dh-pdf-importer';

export function registerSettings() {
    game.settings.register(MODULE_ID, SOURCES_SETTING, {
        scope: 'world',
        config: false,
        type: Array,
        default: [],
        onChange: () => applyAttributionSources()
    });
    game.settings.register(MODULE_ID, OPTIONS_SETTING, {
        scope: 'client',
        config: false,
        type: Object,
        default: {}
    });
    game.settings.register(MODULE_ID, PDF_FOLDER_SETTING, {
        name: 'DHPI.Settings.pdfFolder.name',
        hint: 'DHPI.Settings.pdfFolder.hint',
        scope: 'world',
        config: true,
        type: String,
        filePicker: 'folder',
        default: DEFAULT_PDF_FOLDER
    });
}

/**
 * Folder in the Foundry data directory that PDFs from the user's computer are uploaded to.
 * @returns {string}
 */
export function getPdfFolder() {
    const folder = game.settings.get(MODULE_ID, PDF_FOLDER_SETTING)?.trim().replace(/^\/+|\/+$/g, '');
    return folder || DEFAULT_PDF_FOLDER;
}

/**
 * Destinations and folder options chosen in the last import, remembered per user.
 * @returns {{destinations?: Record<string, string>, folders?: {mode: string, separateKinds: boolean}}}
 */
export function getImportOptions() {
    return game.settings.get(MODULE_ID, OPTIONS_SETTING) ?? {};
}

export function setImportOptions(options) {
    return game.settings.set(MODULE_ID, OPTIONS_SETTING, options);
}

/** @returns {string[]} */
export function getAttributionSources() {
    return game.settings.get(MODULE_ID, SOURCES_SETTING) ?? [];
}

/**
 * Offer imported sources in the system's attribution dialog.
 */
export function applyAttributionSources() {
    const groups = CONFIG.DH?.GENERAL?.attributionSources;
    if (!groups) return;
    const sources = getAttributionSources();
    if (!sources.length) {
        delete groups[MODULE_ID];
        return;
    }
    groups[MODULE_ID] = {
        label: game.i18n.localize('DHPI.AttributionGroup'),
        values: sources.toSorted((a, b) => a.localeCompare(b)).map(label => ({ label }))
    };
}

/**
 * Remember a source so it is offered for future attributions.
 * @param {string} source
 */
export async function registerAttributionSource(source) {
    const sources = getAttributionSources();
    if (sources.includes(source) || knownSystemSources().includes(source)) return;
    await game.settings.set(MODULE_ID, SOURCES_SETTING, [...sources, source]);
    applyAttributionSources();
}

/** Sources already offered by the system or other modules. */
export function knownSystemSources() {
    const groups = CONFIG.DH?.GENERAL?.attributionSources ?? {};
    return Object.entries(groups)
        .filter(([key]) => key !== MODULE_ID)
        .flatMap(([, group]) => group.values.map(v => game.i18n.localize(v.label)));
}

/** All sources that can be suggested in the importer. */
export function allAttributionSources() {
    return [...new Set([...knownSystemSources(), ...getAttributionSources()])];
}
