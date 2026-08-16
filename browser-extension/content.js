// Content script for https://forgedspace.com/*. Scrapes storage/Corp
// Store/Assembler Plans rows and relays them to background.js for sync
// (see checkStorage()/checkCorpStore()/checkAssemblerPlans() below - none
// of that ever modifies the page's own DOM, purely reads it), AND hosts
// the in-page "Manifest" overlay (js/overlay-manifest.js) plus its Add
// Blueprint modal (js/overlay-blueprint-modal.js).
//
// The overlay approach replaces an earlier floating popup-type browser
// window (popup.html/popup.js, now removed). That relied on the OS window
// manager's own "always on top" - not a real WebExtension capability
// (browser.windows has no such option, by design, on every browser) - so
// it only ever actually stayed above the game on setups where the user's
// own window manager provided that themselves. An in-page overlay, appended
// directly into this same document at the highest stacking context, has no
// such dependency: it's part of the page's own render tree, so it's
// guaranteed to sit above the game's own UI everywhere, on every platform,
// with no window-manager cooperation needed at all. It lives inside a
// Shadow DOM (see overlay-manifest.js's initManifestOverlay()) so its own
// styles can never leak into or collide with the game's, and vice versa.
//
// Loaded as a classic (non-module) content script - Firefox's WebExtension
// manifest schema doesn't recognize the content_scripts "type" property
// Chrome MV3 added for declaring module-type content scripts (confirmed via
// Firefox's own "unexpected property" warning when it was set), so this
// file can't use a static top-level `import` the way overlay-manifest.js/
// overlay-blueprint-modal.js do between themselves and storage.js/
// calc-engine.js/catalog.js/dom-helpers.js. Instead, the overlay is pulled
// in with a dynamic import() at the bottom of this file - that works from a
// classic script in every browser with no manifest declaration at all,
// since dynamic import() isn't tied to the parent script's own module-ness.
// browser-compat.js is loaded the older way instead, as its own separate
// classic script listed before this one in manifest.json, since it needs to
// run before anything below calls browser.* .

// Storage screen: each item is a row like
//   <div class="p-3 rounded border cursor-pointer transition-colors
//                bg-gray-800/30 border-gray-600/30 hover:border-blue-500/40">
//     <div class="font-medium text-cyan-100 text-sm">Chloracite Ore</div>
//     <div class="text-xs text-gray-400">19 units</div>
//     ...
// confirmed via live inspection - not virtualized, all rows exist in the DOM
// at once even when scrolled out of view.
const STORAGE_ROW_SELECTOR = 'div[class*="cursor-pointer"][class*="bg-gray-800/30"][class*="border-gray-600/30"]';
const STORAGE_NAME_SELECTOR = ".font-medium.text-cyan-100.text-sm";
const STORAGE_QTY_SELECTOR = ".text-xs.text-gray-400";
const STORAGE_POLL_MS = 2000;

let lastStorageSnapshot = null;

// Scrapes whatever storage rows are currently in the DOM. Returns [] if the
// storage screen isn't open (selector matches nothing).
function scrapeStorageRows() {
  const rows = document.querySelectorAll(STORAGE_ROW_SELECTOR);
  const items = [];
  rows.forEach((row) => {
    const nameEl = row.querySelector(STORAGE_NAME_SELECTOR);
    const qtyEl = row.querySelector(STORAGE_QTY_SELECTOR);
    if (!nameEl || !qtyEl) return;
    const name = nameEl.textContent.trim();
    // "1,276 units" - strip thousands separators before parseFloat, which
    // would otherwise stop at the comma and read this as 1.
    const quantity = parseFloat(qtyEl.textContent.replace(/,/g, ""));
    if (!name || Number.isNaN(quantity)) return;
    items.push({ name, quantity });
  });
  return items;
}

// Offices > Store screen: two side-by-side panels - "Your Commercial
// Storage" and "Corp Store" - share IDENTICAL row markup/classes (an indigo
// theme, different from the gray/cyan storage-transfer screen above), so row
// classes alone can't tell them apart. Both are scoped by first finding the
// panel whose header text matches, then only scraping rows inside that
// specific panel.
//
// "Your Commercial Storage" here is the SAME personal storage as the
// ship-cargo-transfer screen above - just a second place the game happens to
// display it - so it feeds the exact same fsc-storage-scrape message/
// handleStorageScrape() pipeline as that screen (see checkStorage() below),
// not a separate one. "Corp Store" is a genuinely different, shared pool and
// gets its own message type/pipeline (see checkCorpStore()).
const INDIGO_ROW_SELECTOR = 'div[class*="cursor-pointer"][class*="bg-indigo-950/30"][class*="border-indigo-500/15"]';
const INDIGO_HEADER_SELECTOR = "div.flex.items-center.justify-between.mb-2";
const CORP_POLL_MS = 2000;

let lastCorpSnapshot = null;

function findIndigoPanel(headerText) {
  const headers = document.querySelectorAll(INDIGO_HEADER_SELECTOR);
  for (const header of headers) {
    if (header.textContent.includes(headerText)) return header.parentElement;
  }
  return null;
}

// Each row is:
//   <div class="p-3 rounded border ... bg-indigo-950/30 border-indigo-500/15">
//     <div class="flex items-center justify-between gap-2">
//       <div class="flex-1 min-w-0">
//         <div class="text-sm font-medium truncate text-indigo-100">Abaron</div>
//         <div class="text-xs text-indigo-400/50">14,593 units</div>
//       ...
// Reads name/qty by position within that info div rather than matching the
// qty div's own class directly, since text-indigo-400/50 contains a slash
// that would need escaping as a bare CSS class selector.
function scrapeIndigoPanelRows(panel) {
  if (!panel) return [];
  const rows = panel.querySelectorAll(INDIGO_ROW_SELECTOR);
  const items = [];
  rows.forEach((row) => {
    const infoEl = row.querySelector(".flex-1.min-w-0");
    if (!infoEl) return;
    const nameEl = infoEl.children[0];
    const qtyEl = infoEl.children[1];
    if (!nameEl || !qtyEl) return;
    const name = nameEl.textContent.trim();
    const quantity = parseFloat(qtyEl.textContent.replace(/,/g, ""));
    if (!name || Number.isNaN(quantity)) return;
    items.push({ name, quantity });
  });
  return items;
}

function scrapeCommercialStoragePanelRows() {
  return scrapeIndigoPanelRows(findIndigoPanel("Your Commercial Storage"));
}

function scrapeCorpStoreRows() {
  return scrapeIndigoPanelRows(findIndigoPanel("Corp Store"));
}

function checkCorpStore() {
  const items = scrapeCorpStoreRows();
  if (items.length === 0) return;
  const snapshot = JSON.stringify(items);
  if (snapshot === lastCorpSnapshot) return;
  // Only marked "sent" once background.js actually confirms it (see its
  // onMessage listener's sendResponse() call) - not optimistically before
  // sending. A dropped/failed send otherwise gets silently marked as
  // already-handled here, with the poll loop never retrying it since the
  // snapshot comparison above would keep matching on every future tick.
  browser.runtime
    .sendMessage({ type: "fsc-corp-store-scrape", items })
    .then(() => { lastCorpSnapshot = snapshot; })
    .catch(() => {});
}

// Same bounded-polling approach as elsewhere in this project - a plain
// interval, not a MutationObserver, since a first version using
// observer.observe(document.body, {subtree: true}) tripped Firefox's "this
// extension is slowing down your browser" warning on this live, frequently
// re-rendering game UI. A single querySelectorAll() every 2s is cheap and
// bounded by comparison. Only sends a message (and thus only triggers a
// storage.local write in background.js) when the scraped snapshot actually
// changed since the last tick, so leaving the storage screen open and idle
// doesn't write every 2s.
function checkStorage() {
  // Personal storage shows up on two different screens with entirely
  // different markup - the ship-cargo-transfer screen (gray/cyan) and the
  // Offices > Store screen's "Your Commercial Storage" panel (indigo). Only
  // one is ever open/rendered at a time, so try the ship-cargo one first and
  // fall back to the Offices panel - either way the result feeds the same
  // fsc-storage-scrape pipeline, so personal inventory updates identically
  // no matter which one the player happens to have open.
  const dockingItems = scrapeStorageRows();
  const items = dockingItems.length > 0 ? dockingItems : scrapeCommercialStoragePanelRows();
  if (items.length === 0) return;
  const snapshot = JSON.stringify(items);
  if (snapshot === lastStorageSnapshot) return;
  // See checkCorpStore()'s comment - only marked "sent" once confirmed.
  browser.runtime
    .sendMessage({ type: "fsc-storage-scrape", items })
    .then(() => { lastStorageSnapshot = snapshot; })
    .catch(() => {});
}

// Assembler Plans screen: a reference database of every producible item -
// its ingredient breakdown, output rate, and two INDEPENDENT unlock gates
// (Captain Level and R&D, never both on the same row in practice) - that's
// fully browsable regardless of progress, unlike storage/Corp Store which
// reflect live, changing state. The game itself offers three sidebar
// filters over this same data - "All Plans", "Captain Level", "R&D
// Unlocked" - and this only ever reads whichever one the player has
// currently selected (see activeAssemblerFilter()); it never clicks a
// filter button itself, since that would be automating the page rather
// than just reading it.
//
// Both "All Plans" and "R&D Unlocked" feed the Assembly tab only (see
// checkAssemblerPlans() below) - never the Blueprints tab, which is
// hand-entered only. "R&D Unlocked" additionally guards on each row's own
// R&D checkmark (see parseRdUnlock()), not just trust in which sidebar
// filter is active, since only R&D-gated items actually researched can be
// queued there. Captain-Level-gated items have no
// met/unmet indicator in the markup at all (just a bare "Lv N" or "—"), so
// captainLevel is carried through as a display-only stat rather than used
// to gate anything - the player judges that for themselves.
const ASSEMBLER_ROW_SELECTOR = 'div[class*="cursor-pointer"][class*="py-2.5"][style*="1fr 160px 80px 90px 170px 90px 80px"]';
const ASSEMBLER_FILTER_LABELS = ["All Plans", "R&D Unlocked", "Captain Level"];
const ASSEMBLER_POLL_MS = 2000;

let lastAssemblerSnapshot = null;

// Reads which of the three sidebar filter buttons is currently selected
// (highlighted) - purely a read of existing page state, never a click.
function activeAssemblerFilter() {
  const buttons = document.querySelectorAll("button");
  for (const btn of buttons) {
    const text = btn.textContent.trim();
    if (ASSEMBLER_FILTER_LABELS.includes(text) && btn.className.includes("bg-cyan-500/20")) {
      return text;
    }
  }
  return null;
}

// "Zephyr Flux ×8 · Geolith Fragments ×8 · Exotic Osmite ×4 · Malifinum ×13"
// -> { "Zephyr Flux": 8, "Geolith Fragments": 8, ... }
function parseIngredients(text) {
  const requirements = {};
  if (!text) return requirements;
  for (const part of text.split("·")) {
    const match = part.trim().match(/^(.*?)\s*×\s*([\d,.]+)$/);
    if (!match) continue;
    const name = match[1].trim();
    const qty = parseFloat(match[2].replace(/,/g, ""));
    if (!name || Number.isNaN(qty)) continue;
    requirements[name] = qty;
  }
  return requirements;
}

// "4/hr" -> 4, "—" -> null
function parseRate(text) {
  const match = (text || "").trim().match(/^([\d,.]+)\/hr$/);
  return match ? parseFloat(match[1].replace(/,/g, "")) : null;
}

// "Lv 5" -> 5, "—" -> null
function parseCapLevel(text) {
  const match = (text || "").trim().match(/^Lv\s*(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

// The R&D Unlock cell is either a plain "—" (no R&D gate on this item at
// all) or a checkmark icon + "R&D Lv N" text (gate met - no example of an
// unmet-but-visible R&D row has been seen, so absence of the checkmark icon
// is treated as "not met" defensively).
function parseRdUnlock(cell) {
  if (!cell) return { level: null, met: false };
  const met = !!cell.querySelector(".lucide-circle-check");
  const levelText = cell.textContent || "";
  const match = levelText.match(/R&D\s*Lv\s*(\d+)/i);
  return { level: match ? parseInt(match[1], 10) : null, met };
}

function scrapeAssemblerRows() {
  const rows = document.querySelectorAll(ASSEMBLER_ROW_SELECTOR);
  const items = [];
  rows.forEach((row) => {
    const cells = row.children;
    if (cells.length < 5) return;
    const infoEl = cells[0];
    const nameEl = infoEl.children[0];
    const ingredientsEl = infoEl.children[1];
    if (!nameEl) return;
    const name = nameEl.textContent.trim();
    if (!name) return;
    const requirements = parseIngredients(ingredientsEl ? ingredientsEl.textContent : "");
    const ratePerHour = parseRate(cells[2] ? cells[2].textContent : "");
    const captainLevel = parseCapLevel(cells[3] ? cells[3].textContent : "");
    const { level: rdLevel, met: rdMet } = parseRdUnlock(cells[4]);
    items.push({ name, requirements, ratePerHour, captainLevel, rdLevel, rdMet });
  });
  return items;
}

function checkAssemblerPlans() {
  const filter = activeAssemblerFilter();
  if (filter !== "All Plans" && filter !== "R&D Unlocked") return;
  const scraped = scrapeAssemblerRows();
  if (scraped.length === 0) return;
  const snapshot = `${filter}|${JSON.stringify(scraped)}`;
  if (snapshot === lastAssemblerSnapshot) return;
  // Only marked "sent" once background.js actually confirms it - see
  // checkCorpStore()'s comment for why. This matters MORE here than for
  // storage/Corp Store: this screen is a static reference database (per
  // this file's header comment above), not live-changing game state, so a
  // dropped send here would never get superseded by a later, different
  // snapshot - the poll loop would just keep matching "already sent"
  // forever with nothing ever actually saved.
  let items;
  if (filter === "All Plans") {
    // Every row on this screen is something built at the Assembly (it has a
    // rate/hr regardless of which gate, if any, it's behind) - this whole
    // screen feeds the Assembly tab only, not Blueprints. Blueprints come
    // from a separate set of category screens (Weapons, Defence, Reactors,
    // etc.); importing from there was explored and deliberately shelved (see
    // js/tab-blueprints.js's header comment) - Blueprints stay hand-entered
    // only.
    items = scraped;
  } else {
    // "R&D Unlocked" is a subset of the same data, already filtered by the
    // game itself - re-applying the per-row checkmark is just a second
    // guard, redundant with "All Plans" above but harmless.
    items = scraped.filter((item) => item.rdMet);
    if (items.length === 0) return;
  }
  browser.runtime
    .sendMessage({ type: "fsc-assembler-scrape", items })
    .then(() => { lastAssemblerSnapshot = snapshot; })
    .catch(() => {});
}

const pollIntervalIds = [
  setInterval(checkStorage, STORAGE_POLL_MS),
  setInterval(checkCorpStore, CORP_POLL_MS),
  setInterval(checkAssemblerPlans, ASSEMBLER_POLL_MS),
];

// True once this content script's connection to its own extension has gone
// stale - happens whenever the extension reloads (e.g. clicking "Reload" in
// about:debugging, or Chrome's own extensions page) or is uninstalled,
// while this script is still alive in an already-open tab. Firefox/Chrome
// both leave an already-injected content script running in that case -
// reloading only affects what gets injected into pages loaded AFTER the
// reload - so without detecting this ourselves, the OLD instance's overlay
// and edge handle just sit on the page forever, doing nothing (their
// messages to background.js silently fail), never actually going away.
//
// Deliberately does NOT read runtime.id - confirmed via MDN's own list of
// which runtime.* members are exposed to content scripts at all that id is
// NOT among them (only getURL/sendMessage/connect/onMessage/onConnect/
// getManifest/getFrameId/getDocumentId are), so reading it here would just
// be undefined unconditionally and report "invalid" on every single page
// load, valid or not - which is exactly what happened the first time this
// was written this way, and is why scraping stopped working entirely
// within ~2s of any page load. getURL() IS in that accessible set, and
// throws once this context is actually dead, which is the real signal
// wanted here.
function isExtensionContextValid() {
  try {
    browser.runtime.getURL("");
    return true;
  } catch {
    return false;
  }
}

let watchdogIntervalId = null;

// Clears every interval this script started and removes both Shadow DOM
// hosts by their known IDs (see overlay-manifest.js/overlay-blueprint-
// modal.js's ensureHost()/initManifestOverlay()) - this is what actually
// makes the leftover UI disappear on reload, since nothing else ever
// references or cleans up this orphaned script otherwise.
function teardown() {
  for (const id of pollIntervalIds) clearInterval(id);
  if (watchdogIntervalId) clearInterval(watchdogIntervalId);
  document.getElementById("fsc-manifest-overlay-host")?.remove();
  document.getElementById("fsc-blueprint-modal-host")?.remove();
}

// On its own short interval rather than folded into the scrape polls above,
// so cleanup still happens even on a page with none of the storage/Corp
// Store/Assembler Plans screens open (those three all early-return before
// ever touching browser.runtime otherwise, so they'd never notice).
watchdogIntervalId = setInterval(() => {
  if (!isExtensionContextValid()) teardown();
}, 2000);

// Builds the overlay's Shadow DOM host + the always-visible edge handle
// once, on page load - both start collapsed/hidden, per initManifestOverlay()
// itself. Dynamically imported (see header comment) since this file can't
// use a static top-level import.
import(browser.runtime.getURL("js/overlay-manifest.js")).then((overlay) => {
  if (!isExtensionContextValid()) return; // reloaded/uninstalled mid-import - nothing left to attach to
  overlay.initManifestOverlay();

  // The toolbar icon's own click handler (background.js) can't touch this
  // page's DOM directly - it messages this content script instead, which is
  // what actually owns the overlay's visibility state.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "fsc-toggle-overlay") overlay.toggleManifestOverlay();
  });
}).catch((err) => {
  // Without this, a failure here (e.g. a module missing from manifest.json's
  // web_accessible_resources) throws an unhandled rejection that shows up in
  // the console but leaves no trace of what broke on-page - the overlay just
  // silently never appears.
  console.error("Forged Space Shipping Manifest: failed to load the Manifest overlay.", err);
});
