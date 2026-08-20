# Release Notes

Copy/paste source for each version's AMO submission fields - "Release Notes" (public, shown in the version history) and "Notes for Reviewers" (private, only visible to Mozilla's review team). Not part of the shipped extension - keep out of the packaged zip, same as `chrome-store-listing.md`. New versions get their own section below, newest first.

## 3.2 (submitted 2026-08-20, approved 2026-08-20 - auto-approved, no manual review wait)

### Release notes (public)

- **Replaced the separate floating "To Mine" window with an in-page Manifest overlay.** Instead of opening its own browser window (which could only stay on top of the game if your OS window manager happened to allow it), the Manifest now renders directly on the game page itself via an always-visible edge handle - guaranteed to sit above the game on every platform, no window-juggling required.
- The Manifest overlay's dropdown now lets you pick a single Blueprint directly, not just a saved Build Order - handy for a quick one-off farm without setting up a full build first.
- Each Blueprint/Build Order remembers its own source-ore choice per material - pick which ore to mine for a refined material right in the Refined section, remembered separately for each one.
- Assembly items now have a Farm/Buy toggle: Farm shows the ore and item breakdown needed to make it yourself; Buy shows just the quantity to acquire directly.
- Added a "quick add" Blueprint entry, reachable right from the in-game overlay without switching to the dashboard tab.
- Added a manual refresh button on the overlay for when you change something on the dashboard (like cargo capacity) that the overlay hasn't picked up yet.
- Added support for ships with a separate Ore Hold - a new Settings toggle lets mining trip counts use your Ore Hold capacity instead of your general cargo capacity.
- First-time users now land on the Settings tab with a short prompt to fill in their ship's numbers before anything else.
- Renamed "Recipe" to "Blueprint" throughout, to match the game's own terminology.
- Fixed a spacing bug where item quantities in the quick "Add Blueprint" list didn't line up when item names were different lengths.

### Notes for reviewers (private)

Update to a previously-approved extension (v3.1, approved 2026-08-15). No permission changes - still just `storage` and the single host permission for `https://forgedspace.com/*`.

**The most significant change to review:** v3.1 showed its "Manifest" (mining to-do list) in a separate `browser.windows.create({type:"popup"})` window. That approach relied on OS/window-manager "always on top" behavior that isn't a real WebExtension capability, so it only worked reliably on some platforms. v3.2 replaces it with an **in-page overlay**, rendered by `content.js` into its own open-mode Shadow DOM host (`host.attachShadow({mode:"open"})`) appended to `document.documentElement`. This is new DOM-injection surface that wasn't in the version you last reviewed, so it's worth double-checking directly:

- The overlay only ever reads from and writes to its own Shadow DOM subtree - it never queries, reads, or modifies the game page's own DOM. `content.js`'s actual page-reading code (`scrapeStorageRows()`, `scrapeCorpStoreRows()`, `scrapeAssemblerRows()`) is unchanged from v3.1 and still only uses `querySelectorAll`/`querySelector`/`.textContent` - no `.click()`, `.dispatchEvent()`, `.value =`, or form submission anywhere in the extension.
- Still zero network requests of any kind; everything is `browser.storage.local`, scoped to the user's own browser.
- The overlay is togglable via the toolbar icon or a small always-visible edge-tab handle on the page; both just flip a CSS class on the Shadow DOM host, nothing more.

Everything else this release (Blueprint/Build Order picker, per-material ore choices, Farm/Buy toggle, Ore Hold setting, first-launch onboarding) is UI/logic added on top of that same overlay and the existing dashboard tabs - no new permissions, no new network surface, no new page-DOM access.

**Re: the "Unsupported /background/service_worker manifest property is ignored by Firefox" warning**, if it appears again - expected and unchanged from v3.1 (passed with 0 errors, this same warning). `manifest.json`'s `background` block intentionally declares both `service_worker` (Chrome/Edge) and `scripts` (Firefox) so one manifest works cross-browser.

## 3.1 (approved 2026-08-15)

No notes preserved from this submission - written retroactively for 3.2. If revisiting, see the AMO listing's own "Review History" for the original validation output (0 errors, 1 warning - the same `background.service_worker` warning referenced above).
