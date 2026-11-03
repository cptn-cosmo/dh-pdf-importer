# Daggerheart PDF Importer

A Foundry VTT v14 module for the [Daggerheart system](https://github.com/Foundryborne/daggerheart) that reads a PDF supplement, shows everything it recognises in a preview, and imports the entries you pick.

## Usage

As a GM, click **Import PDF** at the top of the Actors, Items, Journal or Compendium sidebar (or use *Configure Settings → Daggerheart PDF Importer*). Then drop a PDF onto the window, choose one from your computer, or browse the Foundry data folder.

The review screen shows a card for each entry, grouped by type. You can:

- import everything (the default) or untick the entries you don't want. You can also select or deselect a whole group, or everything shown under the current filter or search
- rename entries, or mark a weapon as secondary, before importing
- edit the **attribution**: source, artist and page offset. These are guessed from the PDF's metadata, file name, credits and printed page numbers
- choose where each document type goes: a world folder named after the source, or any unlocked compendium

Character options are set up the way the system's own compendiums are: their features are separate feature Items in a "Features" folder next to them, linked by UUID (primary/secondary for ancestries, Hope/class features for classes, foundation/specialization/mastery for subclasses). Domains that the system doesn't have yet (such as The New Unknown's Mars or Nibiru) are added to its homebrew domains when you import, and the preview lists them first.

Every imported document gets `system.attribution` (source, printed page and artist). After an import, the source is added to the system's attribution dialog under **Imported PDFs**.

## What is recognised

| Content | Notes |
| --- | --- |
| Adversaries | Official layout (`Difficulty: 14 \| Thresholds: 8/15 \| HP: 8 \| Stress: 3`, `ATK: +3 \| Claws: Very Close \| 1d12+2 phy`), the compact layout (`Diff 13, Th 7/13, HP 6, Stress 3`) and the Quickstart card layout (`Bite - Melee - 1d6+3 phy`, `Attack Modifier: +1`, `Major 4 \| Severe 8`, HP and Stress printed as boxes `O O O`). Stats printed in a side column are found wherever they end up in reading order. This includes horde HP and damage, minions, experiences, multi-phase adversaries ("Young Thorn Dragon: Laughing Lasher") and features with their form. Costs such as *Mark a Stress* or *Spend 2 Fear* become actions. |
| Environments | Tier/type, impulses, difficulty, potential adversaries and features. GM questions are stored as secret blocks. Potential adversaries are linked to adversaries from the same import, the world, or compendiums (the system's adversary compendium first), including group notation such as "Guards (Arcanist, Head)" → *Arcanist Guard*, *Head Guard* and multi-phase adversaries. Adversary names in feature text ("introduce a Zombie Pack") become links too. The preview shows what will be linked. |
| Weapons & armor | Tables with `Name / Trait / Range / Damage / Burden / Feature` or `Name / Base Thresholds / Armor Score / Feature` columns. Tiered rows become one item per tier. |
| Classes & subclasses | The SRD class layout: domains, starting Evasion and Hit Points, class items, Hope feature, class features, background questions and connections, then each subclass with its spellcast trait (or "power trait") and foundation, specialization and mastery features. Subclasses are linked to their class. |
| Ancestries & communities | Entries under an "Ancestry"/"Community" heading, with their description and "Name: text" features. |
| Domain cards | The SRD reference format ("Level 1 Arcana Spell", "Recall Cost: 1"). Card types of other games such as The New Unknown (Skill, Tech, Psionic, Anomaly, Engram, Sigil) map onto ability or spell, and the original type is kept in the card's flags. |
| Journal | The rest of the text, as one journal entry with a page per major heading. Text that was imported as a stat block or table is replaced with a link to the new document. |

### Scanned PDFs (OCR)

Pages that contain only images (scans, browser "print to PDF" of an image) are listed in the preview with a **Recognise text (OCR)** button. You can edit the list of pages first, for example to skip covers or maps. OCR runs in the browser with [tesseract.js](https://github.com/naptha/tesseract.js). Its engine and English data (about 15 MB) are downloaded from cdn.jsdelivr.net the first time and cached by the browser, so this needs internet access.

Some PDFs have a normal text layer but paste their stat blocks in as pictures. **Find text in images** looks for such images and reads only those with OCR. It skips small images, artwork without readable text, and background images that the page's own text is printed on. The recognised text is merged into the page, so the stat blocks are parsed like any other. Finding the images means scanning every page, which takes a few seconds per page on image-heavy PDFs, so this only runs when you click it.

OCR is less accurate than reading text from the PDF. Once it has been used, the preview says so, and each entry from an OCR page is marked **OCR**. Check names, stats and dice before importing. Clean digital scans work well; photographed or low-resolution pages produce misread words.

PDFs that already carry an invisible OCR text layer (for example from OCRmyPDF) are read directly, and their entries are marked **OCR** as well.

HP and Stress printed as empty boxes are counted, whether they are characters (`HP: O O O`, `☐ ☐`) or circles drawn as shapes.

### Missing characters

Some PDFs use fonts with no text mapping for a few glyphs, often digits. They show on the page, but copying the text loses them, and so does reading it. They are shown as `[?]`, and the entry warns which features are affected.

The preview then offers **Recover missing characters**. It renders a few lines containing each unknown glyph and recognises them with OCR. It then matches the recognised text against the known text around the gaps ("they take [?]d[?] physical" against "they take 2d4 physical") to learn which character each glyph is, and applies that to every place the glyph appears. Only a handful of lines are recognised, so this takes a few seconds.

Fonts that are known to keep alternate figures in the Private Use Area are resolved automatically, without OCR. Currently that's the Questa family (Questa, Questa Sans, Questa Slab, Questa Grande), whose lining and tabular figures are often recorded this way. More fonts can be added to `KNOWN_FONT_GLYPHS` in `scripts/pdf/glyphs.mjs`.

Image-only pages you don't run OCR on are skipped. Such a PDF can still be imported as a PDF journal page.

## Development

The parser doesn't depend on Foundry and runs in Node, using the pdf.js build that ships with Foundry (set `PDFJS_PATH` to point at another `pdf.mjs`):

```sh
node tests/run.mjs [dir]            # regression test against the sample supplements (OCR cases need pdftoppm + tesseract)
node tests/parse.mjs file.pdf       # summary of everything recognised
node tests/dump.mjs file.pdf [page] # laid out lines, for debugging layout issues
# add --ocr to dump.mjs, parse.mjs or preview.mjs to OCR image-only pages with the tesseract CLI,
# or --images to read text inside images on pages that have a text layer
node tests/glyphs.mjs file.pdf       # recover glyphs without a text mapping and show the result
node tests/linker.mjs env.pdf [adversaries.pdf…]  # how many potential adversaries match the system compendium
node tests/preview.mjs file.pdf out.html  # render the review screen with stubbed Foundry globals
```
