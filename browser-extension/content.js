// Read-only content script for https://forgedspace.com/*. Scrapes the
// storage screen's item rows and relays them to background.js for
// inventory sync. Deliberately does NOT modify the page's DOM/appearance in
// any way - an earlier version injected a "Manifest" panel directly into the
// game's UI, but that was reverted in favor of a toolbar-triggered floating
// window (popup.html/popup.js) that shows the same data outside the game
// page entirely.

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
// "All Plans" (unfiltered - ingredient lists are always fully visible
// regardless of what's actually buildable yet) feeds the Recipes tab.
// "R&D Unlocked" feeds the Assembly tab, since only R&D-gated items you've
// actually researched can be queued there - each row's own R&D checkmark is
// still checked too (see parseRdUnlock()), not just trust in which sidebar
// filter is active, as a second guard. Captain-Level-gated items have no
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
    // screen feeds the Assembly tab only, not Recipes. Recipes come from a
    // separate set of category screens (Weapons, Defence, Reactors, etc.);
    // importing from there was explored and deliberately shelved (see
    // js/tab-recipes.js's header comment) - Recipes stay hand-entered only.
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

setInterval(checkStorage, STORAGE_POLL_MS);
setInterval(checkCorpStore, CORP_POLL_MS);
setInterval(checkAssemblerPlans, ASSEMBLER_POLL_MS);
