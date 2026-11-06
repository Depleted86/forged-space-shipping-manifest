# Release Notes

Copy/paste source for each version's AMO submission fields - "Release Notes" (public, shown in the version history) and "Notes for Reviewers" (private, only visible to Mozilla's review team). Not part of the shipped extension - keep out of the packaged zip, same as `chrome-store-listing.md`. New versions get their own section below, newest first.

## 4.1.1 (submitted to AMO, Edge Add-ons and Chrome Web Store 2026-11-06)

### Release notes (public)

- **Fixed: Commercial Storage stopped syncing.** The game rebuilt its Commercial Storage window, and the extension now reads the new one. Searching or filtering the list still never zeroes out items that are hidden.
- **You're told when a screen can't be read.** If the game changes a screen the extension reads (storage, blueprint stores, Assembly Facility, R&D, Character Skills, Lexicon) so that nothing can be read from it, a short notice says so, instead of the sync silently stopping. Your saved data isn't touched.
- Storage is now read by the labels and text the game shows rather than its styling, so it should survive future restyles.

### Notes for reviewers (private)

Supersedes 4.1 (submitted 2026-11-05, still in review); everything in its notes still applies. No permission changes: still just `storage` and the single host permission for `https://forgedspace.com/*`. Still no network requests of any kind; all data stays in `browser.storage.local`.

**Changes, all in `content.js`:**

- **New Commercial Storage reader (`scrapeStoragePanel()`).** The game replaced its storage window. The new reader finds the list by its `role="listbox"` / `aria-label`, and reads each item's name and "N units" text with `querySelectorAll`, `textContent` and `getAttribute("aria-label")` only. Same read-only pattern as the existing scrapers: no `.click()`, `.dispatchEvent()`, value assignment or other page mutation. The old readers stay as fallbacks.
- **"Can't read this screen" notice (`reportScreenRead()`).** When a screen's title is on the page but nothing could be read from it for two polls, a text notice is shown for 8 seconds. It reuses the existing Shadow DOM notice host (`#fsc-toast-host`) from 4.1, with text set via `textContent`, and logs one `console.warn`.

## 4.1 (submitted to AMO and Edge Add-ons 2026-11-05)

### Release notes (public)

- **Move to another browser or PC.** Settings has a new Export to File / Import from File for your blueprints, assembly plans, builds (personal and corp), harvester slots, planet types and ore/buy choices. Importing adds to what's already there. Blueprints that were only seen in a store list get the file's materials. If the file would change your harvester settings or ore/buy choices, you're asked to Allow or Skip first.
- **Blueprint notices.** Viewing a blueprint in a store now shows a short notice: "Blueprint Saved" the first time, "Blueprint Updated - materials changed" if the game's recipe changed, or "Blueprint up to date".
- **More stores are read.** Stores named after their maker, like Sabre Shield Systems, are now recognised from the "... Shield Blueprints" line under their title. Blueprints are grouped by that store category, with a new Shields group, and any new category the game adds gets its own group.
- **Values the game supplies are no longer typed in by hand.** Cargo, Ore Hold and skills show as read from the game. The Blueprints and Assembly tabs are now viewers for what the game recorded (with Delete), and the overlay's blueprint editor is replaced by "Add to Build". A blueprint without materials yet tells you which store to view it in.
- **Harvester slots** are now set on the Planets tab (1-10, the game's maximum), next to the roster they size.
- Fixed: transferring ore on the Ore Hold tab of Commercial Storage now updates trip counts. Changing the ship class filter resets the blueprint picker.
- Chrome and Edge versions are on the way.

### Notes for reviewers (private)

Update to a previously-approved extension (v4.0, submitted 2026-10-31, approved). No permission changes: still just `storage` and the single host permission for `https://forgedspace.com/*`. Still no network requests of any kind; all data stays in `browser.storage.local`.

**Worth a direct look:**

- **Store detection (`content.js`, `blueprintStorePanel()` / `storeCategory()`).** Blueprint stores were recognised by title only. A store is now also recognised by the `<p>` subtitle under its title (e.g. "Mercenur - Shield Blueprints"), because some stores are titled by maker ("Sabre Shield Systems"). The category from that subtitle is stored with each blueprint for grouping. Same read-only pattern as the existing scrapers: `querySelectorAll`/`textContent` only, no `.click()`, `.dispatchEvent()`, value assignment or other page mutation.
- **New in-page notice (`content.js`, `showToast()`).** A short text notice shown for 3 seconds when a blueprint's recipe is saved, updated or confirmed. It lives in its own Shadow DOM host (`#fsc-toast-host`), separate from the game's DOM, like the existing Manifest overlay. Text is set with `textContent`.
- **File export/import (dashboard Settings tab, `js/tab-settings.js`; merge logic in `js/calc-engine.js` `mergeTransferData()`).** Export builds a JSON `Blob` and clicks an `<a download>` - no `downloads` permission. Import reads a user-picked file from `<input type="file">` with `File.text()` and `JSON.parse()`; nothing from it is evaluated or inserted as HTML, only known keys are merged into `browser.storage.local`. The Allow/Skip prompt is a plain dashboard modal.

Also removed: the hand-entry inputs for game-supplied values, the blueprint editor, and the first-launch onboarding (its `dashboardOnboarded` storage key is no longer read or written).

**Re: the "Unsupported /background/service_worker manifest property is ignored by Firefox" warning**, if it appears again: expected and unchanged since v3.1 (`manifest.json` declares both `service_worker` and `scripts` so one manifest works on Chrome/Edge and Firefox). The Chrome/Edge packages from `build.sh` drop `scripts` and `browser_specific_settings`.

## 4.0 (submitted 2026-10-31, approved - confirmed 2026-11-05)

### Release notes (public)

- **Assembly math now works in whole runs.** A plan's rate is the output of one 1-hour run, and its ingredients are used up once per run, so quantities now round up to whole runs. Shared sub-assemblies are rounded once. Totals for large builds are much lower and closer to what the game actually needs.
- **Assembly plans come from the Assembly Facility.** Open Configure Production and the extension reads your plans, including R&D-boosted rates (the old Assembler Plans screen no longer exists in the game).
- **R&D Office support.** Opening Select Research Plan records each plan's research level, progress and status. Items whose plan has no recipe yet now say "Research N required" or "no recipe yet" instead of offering a Farm/Buy choice that did nothing.
- **Every blueprint store is read:** Blueprint Store, Starship Blueprint Store, Auxiliary Systems and the "<Maker> Blueprints" module stores. The extension records ownership, ship class, build limit, price, and for the open blueprint its materials, build cost, guide value, Manufacturing Skill, Captain level and the Engineering needed to fit it.
- **Your skills fill in automatically.** Manufacturing and Engineering come from the Character Skills window and Captain level comes from the HUD. The Blueprints tab flags blueprints your skill or Captain level is too low for.
- **Cargo and Ore Hold sizes are read from the HUD.** Switching ships updates mining trip counts on their own. Ships with an Ore Hold use it for trips.
- **Ship-class filter and store groups** on the Blueprints tab, the Plan a Build picker and the Manifest dropdowns.
- **The Manifest shows what the blueprints cost:** the price of the selected blueprint, or the total for unowned blueprints in a Build Order.
- **Storage sync fix:** using the in-game storage search no longer zeroes out items hidden by the filter, and only Commercial Storage is counted (not Ship Cargo). The Inventory tab has a new "Clear stored inventory" button.
- Builds can be renamed. The Manifest has a "Complete" button and batch counts for each selection. Settings save automatically. ETAs show hours or days instead of both.

### Notes for reviewers (private)

Update to a previously-approved extension (v3.3, approved 2026-08-23). No permission changes: still just `storage` and the single host permission for `https://forgedspace.com/*`. Still no network requests of any kind; all data stays in `browser.storage.local`.

**New page-read surfaces worth a direct look**, all in `content.js` and all using the same read-only pattern as the existing scrapers (`querySelector`/`querySelectorAll`/`textContent` only, with no `.click()`, `.dispatchEvent()`, value assignment, form submission or other page mutation). Each one only reads while that screen is open (the HUD whenever it is on screen):

- Assembly Facility > Configure Production (replaces the old Assembler Plans screen, which the game removed)
- R&D Office > Select Research Plan
- Blueprint stores: Blueprint Store, Starship Blueprint Store, Auxiliary Systems, and module stores titled "<Maker> Blueprints"
- Character Skills window (Manufacturing and Engineering levels)
- The game HUD (Captain level, and the Cargo / Ore Hold maximum capacity)
- Commercial Storage: now limited to the Commercial Storage column, and also reads the search box's text and the "N items" count to tell whether the list is filtered. Nothing is written to the search box.

Everything else (whole-run Assembly math, filters and grouping, the blueprint cost line, build renaming, the Clear inventory button) is UI and logic on the existing Shadow DOM overlay and dashboard tabs.

**Re: the "Unsupported /background/service_worker manifest property is ignored by Firefox" warning**, if it appears again: expected and unchanged since v3.1 (`manifest.json` declares both `service_worker` and `scripts` so one manifest works on Chrome/Edge and Firefox).

## 3.3 (submitted 2026-08-23, approved 2026-08-23 - auto-approved)

### Release notes (public)

- **New "focus" view for the Manifest overlay.** Click any item in the list to zoom in on just that one thing - the panel shrinks down to just the header, a "← All items" link, and that single item, hiding the Farm selector, the Personal Farm/Corp tabs, and the Add Blueprint/Dashboard buttons. A big space-saver if you're playing on a smaller screen and don't want the full list taking up the whole side of your view. Click "← All items" (or the same item again) to go back. Works the same way in both Personal Farm and Corp views.
- The Corp view now has its own Blueprint/Build Order selector, just like Personal Farm already did - pick a corp target directly without needing the dashboard's Corp tab open.
- New "Toxic" planet type added, and future planet types now sync automatically - open the in-game Systems Lexicon, go to Manufacturing, and expand "Planet Types & Resources" to pick up any new ones without waiting for an extension update.
- Fixed a bug where a change made in the Manifest overlay (like switching an Assembly item between Farm and Buy) could get silently reverted if the dashboard happened to save its settings for an unrelated reason while it was open.
- Assembly and Planetary time estimates now show days alongside hours (e.g. "1052.6h (43.9 days)") so long ETAs are easier to read at a glance.
- Mining rows no longer clutter the line with a "(refined: N)" callout - hover the small info icon instead to see how much of that ore is earmarked for refining.
- Redesigned the panel's resize handles for clarity.

### Notes for reviewers (private)

Update to a previously-approved extension (v3.2, approved 2026-08-20, auto-approved). No permission changes - still just `storage` and the single host permission for `https://forgedspace.com/*`.

**The one new thing worth a direct look:** `content.js` now also reads the in-game "Systems Lexicon" reference panel (a static help/reference screen, Manufacturing category, "Planet Types & Resources" topic) when a player has that specific topic expanded, so new planet types can be picked up without an extension update instead of being hardcoded. Same read-only pattern as every other scraper already in this extension (storage screen, Corp Store, Assembler Plans) - `querySelectorAll`/`textContent` only, no `.click()`/`.dispatchEvent()`/form submission/page mutation of any kind. This only ever activates while that one specific reference topic is manually expanded by the player; it doesn't run continuously against arbitrary page content.

Everything else this release (the Manifest overlay's new focus view, the Corp Blueprint/Build Order selector, the settings-sync bugfix, the hours/days formatting change, the resize-handle icon) is UI/logic added on top of the same existing Shadow DOM overlay and dashboard tabs from prior versions - no new permissions, no new network surface, no new page-DOM access beyond the Systems Lexicon read described above.

**Re: the "Unsupported /background/service_worker manifest property is ignored by Firefox" warning**, if it appears again - expected and unchanged since v3.1 (this extension's `manifest.json` intentionally declares both `service_worker` and `scripts` in its `background` block so one manifest works across Chrome/Edge and Firefox).

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
