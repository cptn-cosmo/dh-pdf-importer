# Daggerheart PDF Importer

A Foundry VTT v14 module for the [Daggerheart system](https://github.com/Foundryborne/daggerheart) that reads a PDF supplement, shows everything it recognises in a preview, and imports the entries you pick.

## Usage

As a GM, click **Import PDF** at the top of the Actors, Items, Journal or Compendium sidebar (or use *Configure Settings → Daggerheart PDF Importer*). Then drop a PDF onto the window, choose one from your computer, or browse the Foundry data folder.

The review screen shows a card for each entry, grouped by type. You can:

- import everything (the default) or untick the entries you don't want. You can also select or deselect a whole group, or everything shown under the current filter or search
- rename entries, or mark a weapon as secondary, before importing
- edit the **attribution**: source, artist and page offset. These are guessed from the PDF's metadata, file name, credits and printed page numbers
- choose where each document type goes: a world folder named after the source, or any unlocked compendium

Every imported document gets `system.attribution` (source, printed page and artist). After an import, the source is added to the system's attribution dialog under **Imported PDFs**.

## What is recognised

| Content | Notes |
| --- | --- |
| Adversaries | Official layout (`Difficulty: 14 \| Thresholds: 8/15 \| HP: 8 \| Stress: 3`, `ATK: +3 \| Claws: Very Close \| 1d12+2 phy`) and the compact layout (`Diff 13, Th 7/13, HP 6, Stress 3`). This includes horde HP and damage, minions, experiences, multi-phase adversaries ("Young Thorn Dragon: Laughing Lasher") and features with their form. Costs such as *Mark a Stress* or *Spend 2 Fear* become actions. |
| Environments | Tier/type, impulses, difficulty, potential adversaries and features. GM questions are stored as secret blocks. Potential adversaries are linked to adversaries from the same import, the world, or compendiums (the system's adversary compendium first), including group notation such as "Guards (Arcanist, Head)" → *Arcanist Guard*, *Head Guard* and multi-phase adversaries. Adversary names in feature text ("introduce a Zombie Pack") become links too. The preview shows what will be linked. |
| Weapons & armor | Tables with `Name / Trait / Range / Damage / Burden / Feature` or `Name / Base Thresholds / Armor Score / Feature` columns. Tiered rows become one item per tier. |
| Journal | The rest of the text, as one journal entry with a page per major heading. Text that was imported as a stat block or table is replaced with a link to the new document. |

Image-only pages or PDFs (scans, card sheets) have no text to read and are reported in the preview.

## Development

The parser doesn't depend on Foundry and runs in Node, using the pdf.js build that ships with Foundry (set `PDFJS_PATH` to point at another `pdf.mjs`):

```sh
node tests/run.mjs [dir]            # regression test against the sample supplements
node tests/parse.mjs file.pdf       # summary of everything recognised
node tests/dump.mjs file.pdf [page] # laid out lines, for debugging layout issues
node tests/linker.mjs env.pdf [adversaries.pdf…]  # how many potential adversaries match the system compendium
node tests/preview.mjs file.pdf out.html  # render the review screen with stubbed Foundry globals
```
