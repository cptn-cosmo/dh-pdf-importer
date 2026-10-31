import PdfImporter from './apps/pdf-importer.mjs';
import { MODULE_ID, applyAttributionSources, registerSettings } from './settings.mjs';

/** Open the importer, reusing an open window. */
export function openImporter() {
    const existing = foundry.applications.instances.get('dh-pdf-importer');
    if (existing) return existing.bringToFront();
    return new PdfImporter().render({ force: true });
}

Hooks.once('init', () => {
    registerSettings();
    game.settings.registerMenu(MODULE_ID, 'importer', {
        name: 'DHPI.Title',
        label: 'DHPI.Open',
        hint: 'DHPI.MenuHint',
        icon: 'fa-solid fa-file-pdf',
        type: PdfImporter,
        restricted: true
    });
});

Hooks.once('setup', () => applyAttributionSources());

Hooks.once('ready', () => {
    game.modules.get(MODULE_ID).api = { open: openImporter, PdfImporter };
});

/** Add an "Import PDF" button to the Actor, Item, Journal and Compendium directories. */
function addDirectoryButton(app, element) {
    if (!game.user.isGM || game.system.id !== 'daggerheart') return;
    const actions = element.querySelector('.header-actions');
    if (!actions || actions.querySelector('.dhpi-directory-button')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dhpi-directory-button';
    button.innerHTML = `<i class="fa-solid fa-file-pdf" inert></i> <span>${game.i18n.localize('DHPI.Open')}</span>`;
    button.addEventListener('click', event => {
        event.preventDefault();
        openImporter();
    });
    actions.append(button);
}

for (const hook of ['renderActorDirectory', 'renderItemDirectory', 'renderJournalDirectory', 'renderCompendiumDirectory']) {
    Hooks.on(hook, addDirectoryButton);
}
