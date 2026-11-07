# Chrome Web Store / Edge Add-ons Listing — Forged Space Shipping Manifest

Copy/paste source for the Chrome Developer Dashboard and Microsoft Partner
Center (Edge Add-ons) listing forms - both ask for the same fields. Upload
`forged-space-shipping-manifest-chrome-<ver>.zip` to Chrome and
`forged-space-shipping-manifest-edge-<ver>.zip` to Edge (both from
`build.sh`). Not part of the shipped extension - keep this out of the
packaged zip.

## Short description (≤132 characters)

Mining, refining, and assembly planner for Forged Space, with an in-game Manifest overlay and corp order tracking.

## Detailed description

Forged Space Shipping Manifest is a companion planner for the game Forged
Space, developed with explicit permission from Coops, the game's developer.

Track blueprints, refining/assembly chains, and planetary harvesting rates,
then build a full mining-to-launch plan. An in-game "Manifest" overlay
shows exactly what's left to gather, live-synced to your in-game storage -
no more juggling a spreadsheet or a separate desktop app.

Blueprints, assembly plans, skills and ship capacities are read from the
game screens as you open them, so there's nothing to type in by hand.

For corp orders, the Corp tab tracks a shared build against the corp's
Store, with an editable "have" figure any corp-mate can correct for
everyone else and a CSV export/import so players who'd rather work from a
spreadsheet can too. Your blueprints, builds and harvester setup can be
exported to a file and imported on another browser or PC.

This extension is strictly read-only and makes no network requests of any
kind. It only reads the game screens you open on forgedspace.com - it
never clicks, submits, or automates anything in the game on your behalf.
Its on-page UI (the Manifest overlay, a setup checklist and short notices) is
drawn and controlled by the extension itself, separate from the game's
own page, and it never modifies the game's page content. Everything it stores (blueprints,
inventory, builds, settings) stays local to your own browser and is never
transmitted anywhere.

Full source code is public so anyone can verify the above for themselves:
https://github.com/Depleted86/forged-space-shipping-manifest

This is an independently maintained fan tool, not an official part of the
game. Forged Space is still being actively developed and its pages can
change without notice - if something looks off after a game update, that
means the extension needs an update, not that your save is broken.

## Category

Tools (Chrome: Productivity was not selectable, 2026-11-06). Edge: Productivity.

## Single purpose description

Helps Forged Space players plan mining, refining, harvesting and assembly
for their builds. It reads the game screens the player opens on
forgedspace.com (storage, blueprint stores, assembly and research plans,
skills) to keep a local plan up to date, and shows what's left to gather in
an in-game Manifest overlay.

## Permission justifications

**storage**
Saves the player's own planning data locally in the browser so it persists
between sessions: blueprints and assembly plans read from the game,
inventory snapshots, saved builds and corp orders, harvester assignments
and settings. Nothing is ever sent off the device.

**Host permission: https://forgedspace.com/***
The only host is https://forgedspace.com/*, the game itself. The content
script reads the game screens the player opens there (Commercial Storage,
Corp Store, blueprint stores, Assembly Facility, R&D Office, Character
Skills, the Systems Lexicon and the HUD) using textContent only, to keep
the local plan in sync, and draws the extension's own Manifest overlay. It
never clicks, submits or changes anything on the page, and makes no
network requests.

**Remote code**
No, I am not using remote code. Every script ships in the package.

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
