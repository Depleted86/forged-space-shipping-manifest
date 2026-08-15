# Chrome Web Store Listing — Forged Space Shipping Manifest

Copy/paste source for the Developer Dashboard listing form. Not part of the
shipped extension - keep this out of the packaged zip.

## Short description (≤132 characters)

Mining, refining, and assembly planner for Forged Space, with a live Manifest popup and corp order tracking synced to your storage.

## Detailed description

Forged Space Shipping Manifest is a companion planner for the game Forged
Space, developed with explicit permission from Coops, the game's developer.

Track recipes, refining/assembly chains, and planetary harvesting rates,
then build a full mining-to-launch plan. A floating "Manifest" window shows
exactly what's left to gather, live-synced to your in-game storage - no more
juggling a spreadsheet or a separate desktop app.

For corp orders, the Corp tab tracks a shared build against the corp's
Store, with an editable "have" figure any corp-mate can correct for
everyone else and a CSV export/import so players who'd rather work from a
spreadsheet can too.

This extension is strictly read-only and makes no network requests of any
kind. It only reads the storage screen you're already looking at on
forgedspace.com - it never clicks, submits, or automates anything in the
game on your behalf. Everything it stores (recipes, inventory, builds,
settings) stays local to your own browser and is never transmitted
anywhere.

Full source code is public so anyone can verify the above for themselves:
https://github.com/Depleted86/forged-space-shipping-manifest

This is an independently maintained fan tool, not an official part of the
game. Forged Space is still being actively developed and its pages can
change without notice - if something looks off after a game update, that
means the extension needs an update, not that your save is broken.

## Category

Productivity (or Tools, if Productivity isn't offered as a distinct option)

## Single purpose description

Helps Forged Space players plan mining, refining, and assembly by tracking
recipes and syncing a live manifest from their in-game storage.

## Permission justifications

**storage**
Used to save the player's own recipes, inventory snapshots, saved builds,
corp order data, and settings locally in the browser, so their planning
data persists between sessions.

**Host permission: https://forgedspace.com/***
Used only so the extension's content script can read the storage/inventory
listing on forgedspace.com to keep the extension's local tracking in sync.
It never submits or modifies anything on the page.

## Privacy policy URL

https://github.com/Depleted86/forged-space-shipping-manifest/blob/main/PRIVACY.md

## Data usage tab

None of the data-collection checkboxes apply - nothing ever leaves the
user's device. Check all three compliance certifications:
- I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- I do not use or transfer user data for purposes unrelated to the item's
  single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

## Visibility

Public
