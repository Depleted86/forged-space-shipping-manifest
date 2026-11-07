# Forged Space Shipping Manifest

A browser extension (Chrome, Firefox, Edge) that helps plan mining trips
for the game [Forged Space](https://forgedspace.com): tracks ore/material
blueprints, planet harvesting, Assembly commodity chains, and your live
in-game inventory, then works out exactly what still needs to be mined for
a given build. Also tracks corp orders against the corp's shared Store,
with CSV export/import for coordinating with corp-mates who'd rather work
from a spreadsheet.

This is an independent fan tool, not an official part of the game.

## Permission and terms

This extension was developed with **explicit permission from Coops**, the
developer of Forged Space, under the following conditions:

- **Local-only, always.** The extension makes no network requests of any
  kind and never transmits anything anywhere. The only data it stores is
  your own Forged Space game data (inventory, blueprints, builds, settings),
  saved locally in your browser and nowhere else.
- **Read-only, always.** It only reads what's already on the page you're
  looking at (via `content.js`, the only script it injects into the
  game). It never clicks anything, fills in a form, or takes any action in
  the game on your behalf. `content.js` does render one piece of its own
  UI directly onto the page - a small floating "Manifest" overlay - but
  that's a separate, self-contained element the extension draws and
  controls itself; it never reads from, writes to, or changes the game's
  own page content.
- **Source available for public review**, specifically so that anyone
  installing it can verify the two points above for themselves rather than
  taking it on faith.

See [`LICENSE`](./LICENSE) for the actual terms this code is shared under
— in short: you're welcome to read it, run it for personal use, and open
Pull Requests, but redistributing modified or competing versions isn't
permitted without permission (Coops can separately authorize another
developer to duplicate or continue this project - see `LICENSE` for that
exception).

See [`PRIVACY.md`](./PRIVACY.md) for the full privacy policy - short
version: no network requests, no tracking, nothing ever leaves your
browser.

## The game changes weekly — expect breakage

Forged Space is still being actively rebuilt. Panels get restyled,
rewritten, or replaced outright, often with no notice. This extension
works by reading the game's live page structure, so **it can and will
break** when that structure changes.

If something stops working or starts showing wrong numbers after a Forged
Space update, that means this extension needs fixing — it does **not**
mean your game or your save is broken. If you hit this, a bug report or
Pull Request describing what changed is genuinely useful (see below).

## Installing

Install it from your browser's extension store:

- **Firefox**: https://addons.mozilla.org/en-US/firefox/addon/forged-space-shipping-manifest/
- **Edge**: https://microsoftedge.microsoft.com/addons/detail/jfhlioekedclgpogjgdjaadidfibidid
- **Chrome**: https://chromewebstore.google.com/detail/forged-space-shipping-man/mackeonbhankbkndaiikhjannmokiplc

To load it locally instead (for development):

- **Firefox**: go to `about:debugging#/runtime/this-firefox`, click "Load
  Temporary Add-on…", and select `browser-extension/manifest.json`. This
  is a temporary load and won't survive a browser restart.
- **Chrome/Edge**: run `./build.sh`, then go to `chrome://extensions` (or
  `edge://extensions`), enable Developer Mode, click "Load unpacked", and
  select the `dist/chromium/` folder.

`./build.sh` also builds the store packages: the Firefox zip and the
Chrome and Edge zips (same contents, with the Firefox-only manifest keys
removed).

## Contributing

Bug reports and Pull Requests are welcome, especially fixes for breakage
caused by game updates (see above). Note that submitting a Pull Request
doesn't grant any redistribution rights beyond what's in `LICENSE` — all
merges and published releases are at the sole discretion of the repository
owner.

## Project layout

- `browser-extension/` — the extension itself (Manifest V3). See
  `dashboard.html`/`dashboard.js` for the main planner UI (opened as an
  ordinary tab), `content.js` for the game-page scraper plus the in-page
  "Manifest" overlay it hosts (`js/overlay-manifest.js` and
  `js/overlay-blueprint-modal.js`), and `background.js` for the service
  worker.
- `browser-extension/test/` — `node --test` suite for the calculation
  engine (`js/calc-engine.js`), checked against golden-master fixtures.
