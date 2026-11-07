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
// No cursor-pointer: with the Ore Hold tab selected the game disables
// withdrawals and marks every row cursor-default instead.
const STORAGE_ROW_SELECTOR = 'div[class*="bg-gray-800/30"][class*="border-gray-600/30"]';
const STORAGE_NAME_SELECTOR = ".font-medium.text-cyan-100.text-sm";
const STORAGE_QTY_SELECTOR = ".text-xs.text-gray-400";
const STORAGE_POLL_MS = 2000;

let lastStorageSnapshot = null;

// The Commercial Storage window (Promenade > Storage Facility) puts Ship
// Cargo and Commercial Storage side by side, so rows are only read from the
// column under the "Commercial Storage" heading - cargo items must never be
// counted as stored. That column's header also has an "N items" badge, and
// the window a "Search items..." box: the list is only complete (safe to
// replace the stored inventory with, so used-up items drop to 0) when the
// search is empty AND every badged item was read. Anything less is merged
// by background.js instead.
function storageColumn() {
  for (const h4 of document.querySelectorAll("h4")) {
    if (h4.textContent.trim() === "Commercial Storage") return h4.closest(".space-y-4") || h4.parentElement.parentElement;
  }
  return null;
}

function storageListIsComplete(column, rowCount) {
  const search = document.querySelector('input[placeholder^="Search items"]');
  if (search && search.value.trim() !== "") return false;
  const badge = [...column.querySelectorAll("div")].map((el) => el.textContent.trim().match(/^([\d,]+) items?$/)).find(Boolean);
  return !!badge && parseInt(badge[1].replace(/,/g, ""), 10) === rowCount;
}

// Scrapes whatever storage rows are currently in the DOM. Returns
// {items: [], complete: false} if the storage screen isn't open.
function scrapeStorageRows() {
  const column = storageColumn();
  const rows = (column || document).querySelectorAll(STORAGE_ROW_SELECTOR);
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
  return { items, complete: !!column && items.length > 0 && storageListIsComplete(column, items.length) };
}

// Commercial Storage as rebuilt by the game on 2026-11-06: one panel
// (".fsx.sto", titled "Commercial Storage") with the ship's cargo hold in its
// left column and storage as a list of tiles in the middle -
//   <div class="tile" role="option">
//     <button class="tick" aria-label="Pick Abaron to withdraw"></button>
//     ...<div class="nm"><i></i>Abaron</div>...
//     <div class="q">41,374 units</div>
// grouped under Ore / Refined / Planet resources / Solar gases / Items
// headings. Only tiles inside the storage list are read, so cargo-hold rows
// (".srow") never count as stored. The list is complete when the search box
// is empty, the "Show" filter is on "All N" and all N tiles were read.
//
// Read by what the game shows and labels for screen readers - the list's
// "Your storage" name, each tile's "N units" text and its "Pick <name> to
// withdraw" checkbox - before its style classes, which a restyle is far more
// likely to rename. The classes are only a fallback.
const STORAGE_PANEL_TITLE = "Commercial Storage";
const STORAGE_UNITS_TEXT = /^([\d,.]+)\s*units?$/i;

function storageList() {
  const labelled = document.querySelector('[role="listbox"][aria-label="Your storage"]');
  if (labelled) return labelled;
  for (const panel of document.querySelectorAll(".fsx.sto")) {
    const title = panel.querySelector(".ttl");
    if (title && title.textContent.trim() === STORAGE_PANEL_TITLE) return panel.querySelector('[role="listbox"]') || panel.querySelector(".list");
  }
  return null;
}

function storageTileName(tile) {
  const nameEl = tile.querySelector(".nm");
  if (nameEl && nameEl.textContent.trim()) return nameEl.textContent.trim();
  for (const el of tile.querySelectorAll("[aria-label]")) {
    const pick = el.getAttribute("aria-label").match(/^Pick (.+) to withdraw$/);
    if (pick) return pick[1].trim();
  }
  return null;
}

// The element reading "41,347 units" - by its whole text, since the game
// splits it across tags ("41,347<small> units</small>" since the
// 2026-11-07 update). Only an element whose text is exactly that matches,
// so the tile itself, the credit value ("1,695,227 CR") and the rest don't.
function storageTileQuantity(tile) {
  for (const el of tile.querySelectorAll("*")) {
    const units = el.textContent.replace(/\s+/g, " ").trim().match(STORAGE_UNITS_TEXT);
    if (units) return parseFloat(units[1].replace(/,/g, ""));
  }
  return null;
}

// How many kinds the whole storage holds: the "Show" filter's "All N"
// button, or the header's "N kinds" chip. null when the filter is on
// something other than All (the list is a subset) or neither is found.
function storageTotalKinds(panel) {
  const show = panel.querySelector('[role="group"][aria-label="Show"]');
  if (show) {
    const pressed = show.querySelector('button[aria-pressed="true"]');
    const all = pressed && pressed.textContent.trim().match(/^All ([\d,]+)$/);
    return all ? parseInt(all[1].replace(/,/g, ""), 10) : null;
  }
  for (const el of panel.querySelectorAll("span, div")) {
    const kinds = el.textContent.trim().match(/^([\d,]+) kinds$/);
    if (kinds) return parseInt(kinds[1].replace(/,/g, ""), 10);
  }
  return null;
}

function scrapeStoragePanel() {
  const list = storageList();
  if (!list) return { items: [], complete: false };
  let tiles = list.querySelectorAll('[role="option"]');
  if (tiles.length === 0) tiles = list.querySelectorAll(".tile");
  const items = [];
  tiles.forEach((tile) => {
    const name = storageTileName(tile);
    const quantity = storageTileQuantity(tile);
    if (!name || quantity === null || Number.isNaN(quantity)) return;
    items.push({ name, quantity });
  });
  const panel = list.closest("[data-panel-open]") || list.closest(".fsx") || document;
  const search = panel.querySelector('input[type="search"]');
  const searching = !!search && search.value.trim() !== "";
  const complete = items.length > 0 && !searching && storageTotalKinds(panel) === items.length;
  return { items, complete };
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
// The storage screen is on the page, by its title, and shows quantities
// ("N units") - an empty storage shows none, so it never reads as unreadable.
function storageScreenOpen() {
  const title = findLeafText("h1, h2, h3, h4, div", STORAGE_PANEL_TITLE);
  if (!title) return false;
  const panel = title.closest("[data-panel-open]") || title.parentElement?.parentElement?.parentElement;
  return !!panel && /\d\s+units?\b/i.test(panel.textContent);
}

function checkStorage() {
  // Personal storage shows up on different screens with entirely different
  // markup - the Commercial Storage panel (tiles, current), the older
  // ship-cargo-transfer screen (gray/cyan) and the Offices > Store screen's
  // "Your Commercial Storage" panel (indigo). Only one is ever open/rendered
  // at a time, so try them in that order - either way the result feeds the
  // same fsc-storage-scrape pipeline, so personal inventory updates
  // identically no matter which one the player happens to have open.
  const panel = scrapeStoragePanel();
  const docking = panel.items.length > 0 ? panel : scrapeStorageRows();
  // The Offices panel has no way to tell a filtered list from a full one,
  // so it's always merged.
  const items = docking.items.length > 0 ? docking.items : scrapeCommercialStoragePanelRows();
  const complete = docking.items.length > 0 && docking.complete;
  reportScreenRead("Commercial Storage", items.length === 0 && storageScreenOpen(), items.length > 0);
  if (items.length > 0 && setupWindows) setupWindows.noteRead("storage");
  if (items.length === 0) {
    // Screen closed - forget what was last sent, so reopening it always
    // resyncs (the stored inventory may have changed meanwhile, e.g. from
    // refining batches entered in the Manifest or edits on the dashboard).
    lastStorageSnapshot = null;
    return;
  }
  const snapshot = JSON.stringify([items, complete]);
  if (snapshot === lastStorageSnapshot) return;
  // See checkCorpStore()'s comment - only marked "sent" once confirmed.
  browser.runtime
    .sendMessage({ type: "fsc-storage-scrape", items, complete })
    .then(() => { lastStorageSnapshot = snapshot; })
    .catch(() => {});
}

// Assembly Facility > Configure Production: the list of plans the player
// can queue at an Assembler, one card per plan - name, output rate,
// unlock gates, and a "Required Resources" chip list. Coops removed the old
// Item Database > Assembler Plans screen (a browsable database of EVERY
// plan) in the late-October 2026 update; this panel replaced it as the only
// place recipes appear, and it lists only plans the player already knows.
// That's fine here because handleAssemblerScrape() in background.js only
// ever adds/updates the plans it's sent and never prunes the rest, so plans
// imported earlier (or hand-entered) for still-locked items are kept.
//
// Cards are found by their "Required Resources" label text rather than by
// Tailwind classes or grid widths - the previous scraper keyed on an exact
// grid-template string and broke silently the moment the layout changed.
// Category filter tabs (All/Drones/Commodities/...) just show a subset of
// the same cards, so whichever tab is open is scraped as-is - it never
// clicks a tab itself, since that would be automating the page rather than
// just reading it. Both the Personal and Corporation tabs show the same
// plans. Feeds the Assembly tab only - Blueprints stay hand-entered (see
// js/tab-blueprints.js).
const ASSEMBLER_PANEL_TITLE = "Assembly Facility";
const ASSEMBLER_RESOURCES_LABEL = /^Required Resources\b/i;
const ASSEMBLER_POLL_MS = 2000;

// "8x White Iron" -> ["White Iron", 8]
function parseResourceChip(text) {
  const match = (text || "").trim().match(/^([\d,.]+)\s*x\s+(.+)$/i);
  if (!match) return null;
  const qty = parseFloat(match[1].replace(/,/g, ""));
  const name = match[2].trim();
  return name && !Number.isNaN(qty) ? [name, qty] : null;
}

// "2/hour" or "7/hr" -> number, anything else -> null. An R&D-boosted card
// shows the base rate struck through in its own element ("5") followed by
// the effective one ("7/hr") - only the latter carries the "/hr" suffix, so
// it's the one that matches. That effective rate is what this player's
// Assembler actually yields per run, so it's the one stored.
function parseRate(text) {
  const match = (text || "").trim().match(/^([\d,.]+)\s*\/\s*(?:hour|hr)$/i);
  return match ? parseFloat(match[1].replace(/,/g, "")) : null;
}

let lastAssemblerSnapshot = null;

function isAssemblyFacilityOpen() {
  for (const h2 of document.querySelectorAll("h2")) {
    if (h2.textContent.trim().startsWith(ASSEMBLER_PANEL_TITLE)) return true;
  }
  return false;
}

// Walks up from a card's "Required Resources" label to the card itself:
// the nearest ancestor that also contains the plan's <h4> name.
function assemblerCardFor(labelEl) {
  let el = labelEl.parentElement;
  while (el && !el.querySelector("h4")) el = el.parentElement;
  return el;
}

function scrapeAssemblerCards() {
  const items = [];
  for (const label of document.querySelectorAll("p")) {
    if (!ASSEMBLER_RESOURCES_LABEL.test(label.textContent.trim())) continue;
    const card = assemblerCardFor(label);
    if (!card) continue;
    const name = card.querySelector("h4").textContent.trim();
    if (!name) continue;

    const requirements = {};
    const chipList = label.nextElementSibling;
    for (const chip of chipList ? chipList.children : []) {
      const parsed = parseResourceChip(chip.textContent);
      if (parsed) requirements[parsed[0]] = parsed[1];
    }
    if (Object.keys(requirements).length === 0) continue;

    let ratePerHour = null;
    let captainLevel = null;
    let rdLevel = null;
    // Leaf elements only, so a wrapper's concatenated text ("57/hr(+50%)")
    // never shadows the individual values.
    for (const el of card.querySelectorAll("p, span")) {
      if (el.children.length > 0) continue;
      const text = el.textContent.trim();
      const rate = parseRate(text);
      if (rate !== null && ratePerHour === null) ratePerHour = rate;
      const cap = text.match(/^Req:\s*Captain\s*Lv\s*(\d+)$/i);
      if (cap) captainLevel = parseInt(cap[1], 10);
      const rd = text.match(/^R&D\s*Level\s*(\d+)$/i);
      if (rd) rdLevel = parseInt(rd[1], 10);
    }
    // This screen only lists plans the player has, so an R&D gate shown
    // here is one already researched.
    items.push({ name, requirements, ratePerHour, captainLevel, rdLevel, rdMet: rdLevel !== null });
  }
  return items;
}

function checkAssemblerPlans() {
  if (!isAssemblyFacilityOpen()) {
    reportScreenRead("the Assembly Facility's plans", false, false);
    return;
  }
  const items = scrapeAssemblerCards();
  // The Facility has other tabs; only its Configure Production list shows plans.
  reportScreenRead("the Assembly Facility's plans", !!findLeafText("h2, h3, h4", "Configure Production"), items.length > 0);
  if (items.length === 0) return;
  const snapshot = JSON.stringify(items);
  if (snapshot === lastAssemblerSnapshot) return;
  // Only marked "sent" once background.js actually confirms it - see
  // checkCorpStore()'s comment for why. Plans rarely change, so a dropped
  // send would never get superseded by a later, different snapshot - the
  // poll loop would just keep matching "already sent" with nothing saved.
  browser.runtime
    .sendMessage({ type: "fsc-assembler-scrape", items })
    .then(() => { lastAssemblerSnapshot = snapshot; })
    .catch(() => {});
}

// R&D Office > Select Research Plan: every research plan in the game,
// researched or not, each row showing its name, an "Lv.N" badge once
// researched, the Research Skill it needs, and progress if it's being
// researched. No recipes here - this is where locked plans come from, so the
// Assembly tab can list them (marked locked) before the Assembly Facility
// ever shows them. Opened via an empty slot's "Select Plan" button.
const RESEARCH_PANEL_TITLE = "Select Research Plan";
let lastResearchSnapshot = null;

function researchPanel() {
  for (const h3 of document.querySelectorAll("h3")) {
    if (h3.textContent.trim() === RESEARCH_PANEL_TITLE) return h3.parentElement;
  }
  return null;
}

// The row for a plan name: the outermost ancestor that still contains only
// this one <h4>, so no layout classes are needed to find it.
function researchRowFor(h4, panel) {
  let row = h4;
  while (row.parentElement && row.parentElement !== panel && row.parentElement.querySelectorAll("h4").length === 1) {
    row = row.parentElement;
  }
  return row;
}

function scrapeResearchPlans() {
  const panel = researchPanel();
  if (!panel) return [];
  const plans = [];
  for (const h4 of panel.querySelectorAll("h4")) {
    const name = h4.textContent.trim();
    if (!name) continue;
    let level = 0;
    let skillRequired = null;
    let progress = null;
    let active = false;
    for (const el of researchRowFor(h4, panel).querySelectorAll("span, p, div")) {
      if (el.children.length > 0) continue;
      const text = el.textContent.trim();
      const lv = text.match(/^Lv\.?\s*(\d+)$/i);
      if (lv) level = parseInt(lv[1], 10);
      const skill = text.match(/^Requires Research Skill Level\s*(\d+)$/i);
      if (skill) skillRequired = parseInt(skill[1], 10);
      if (/^\d+\s*\/\s*\d+%$/.test(text)) progress = text.replace(/\s+/g, "");
      if (text === "Active") active = true;
    }
    plans.push({ name, level, skillRequired, progress, active });
  }
  return plans;
}

function checkResearchPlans() {
  const plans = scrapeResearchPlans();
  reportScreenRead("the R&D research plans", plans.length === 0 && !!researchPanel(), plans.length > 0);
  if (plans.length === 0) return;
  const snapshot = JSON.stringify(plans);
  if (snapshot === lastResearchSnapshot) return;
  // See checkCorpStore()'s comment for why this is only marked sent once
  // background.js confirms it.
  browser.runtime
    .sendMessage({ type: "fsc-research-scrape", plans })
    .then(() => { lastResearchSnapshot = snapshot; })
    .catch(() => {});
}

// Blueprint Store (Promenade > Blueprint Store): a list of every blueprint
// the station sells, each card showing name, ship class, build limit and
// an "OWNED (N copies)" badge when the player has it - plus a detail panel
// for whichever card is selected, with its "Resource Requirements" (the
// materials to manufacture one). The list feeds ownership for every
// blueprint; the detail panel feeds the recipe of the one being viewed.
// The Starship Blueprint Store (on planets) is the same layout with a few
// differences: prices in "CR", "OWNED (N)" with no "copies", no build limit
// or Manufacturing Skill on the cards, and a "Level Req" / "Ship Value" /
// "Build Limit: N uses" in the detail panel instead. Auxiliary Systems
// (repairers and shield projectors) is the regular layout under its own title.
// Module stores are titled by manufacturer ("Kriton Blueprints"), so any
// title ending in " Blueprints" counts; their cards say "Builds: N" for the
// build limit and "Eng Lvl N" for the Engineering needed to fit the module.
// Some planet stores are titled by maker only ("Sabre Shield Systems") with
// the " Blueprints" in the subtitle under it ("Mercenur - Shield
// Blueprints"), so that counts too.
const BLUEPRINT_STORE_TITLES = ["Blueprint Store", "Starship Blueprint Store", "Auxiliary Systems"];

function isBlueprintStoreTitle(text) {
  return BLUEPRINT_STORE_TITLES.includes(text) || /\sBlueprints$/.test(text);
}

// The category in the <p> subtitle under a store's title <h3> - "Shield"
// from "Mercenur - Shield Blueprints", "Ship Module" from "... - Ship
// Module Blueprints" - or null when there's no such subtitle.
function storeCategory(h3) {
  const subtitle = h3.nextElementSibling;
  if (!subtitle || subtitle.tagName !== "P") return null;
  const match = subtitle.textContent.trim().match(/(?:^|\s-\s)([^-]*?)\s+Blueprints$/);
  return match ? match[1].trim() : null;
}
let lastBlueprintStoreSnapshot = null;
// "<name>|<status>" of the last recipe notice shown, so the same open
// blueprint isn't announced again when only the store list changes (e.g.
// a price refresh); cleared once no blueprint is open.
let lastRecipeNotice = null;

// The open store's panel, its title ("Starship Blueprint Store"...) and
// subtitle category ("Starship"...), or null - these tell the dashboard
// which store a blueprint came from.
function blueprintStorePanel() {
  for (const h3 of document.querySelectorAll("h3")) {
    // The title <h3> also holds a help button, so match on its own text.
    const title = h3.firstChild ? h3.firstChild.textContent.trim() : "";
    const category = title ? storeCategory(h3) : null;
    if (title && (isBlueprintStoreTitle(title) || category)) {
      return { panel: h3.closest("[data-panel-open]") || h3.parentElement.parentElement.parentElement, title, category };
    }
  }
  return null;
}

// Outermost ancestor still holding only this one <h3> - a list card, the
// detail panel, or the title bar, depending on which <h3> it started from.
function outermostSingleH3(h3, panel) {
  let el = h3;
  while (el.parentElement && el.parentElement !== panel && el.parentElement.querySelectorAll("h3").length === 1) {
    el = el.parentElement;
  }
  return el;
}

function leafTexts(root) {
  const texts = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.children.length === 0 && el.textContent.trim()) texts.push(el.textContent.trim());
  }
  return texts;
}

// "258,000 credits" -> 258000, anything else -> null
function parseCredits(text) {
  const match = (text || "").trim().match(/^([\d,]+)\s*(?:credits|CR)$/i);
  return match ? parseInt(match[1].replace(/,/g, ""), 10) : null;
}

// The store's type filter ("All Module Types" -> "Armor", or "Systems" in
// the Blueprint Store): the type chosen, or null while it's on All. Cards
// don't show their type, so a blueprint's type is only known while the list
// is filtered to one - background.js keeps it once learnt. The class filter
// ("All Classes" -> "Miner") is a separate <select>, told apart by its first
// option.
function storeTypeFilter(panel) {
  for (const select of panel.querySelectorAll("select")) {
    const first = select.options[0] ? select.options[0].textContent.trim() : "";
    if (!/^All\b/i.test(first) || /^All Classes$/i.test(first)) continue;
    return select.selectedIndex > 0 ? select.options[select.selectedIndex].textContent.trim() : null;
  }
  return null;
}

// Whether the store's list is narrowed down: a filter (type or class) off
// All, or text in its search box.
function storeFiltersActive(panel) {
  if ([...panel.querySelectorAll("select")].some((select) => select.selectedIndex > 0)) return true;
  return [...panel.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')].some((input) => input.value.trim() !== "");
}

function scrapeBlueprintStore() {
  const found = blueprintStorePanel();
  if (!found) return null;
  const panel = found.panel;
  const list = [];
  let detail = null;
  for (const h3 of panel.querySelectorAll("h3")) {
    const name = h3.textContent.replace(/\s+/g, " ").trim();
    if (!name || name === found.title || isBlueprintStoreTitle(name)) continue;
    const block = outermostSingleH3(h3, panel);
    const reqHeading = [...block.querySelectorAll("h4")].find((h4) => /^Resource Requirements$/i.test(h4.textContent.trim()));
    if (reqHeading) {
      // Each requirement row's leaves read: name, type, quantity, price.
      const requirements = {};
      for (const row of reqHeading.nextElementSibling ? reqHeading.nextElementSibling.children : []) {
        const [itemName, , qtyText] = leafTexts(row);
        const qty = parseFloat((qtyText || "").replace(/,/g, ""));
        if (itemName && !Number.isNaN(qty)) requirements[itemName] = qty;
      }
      // Leaves read "Build Cost (today's prices):", "225,700 credits", ...
      const detailTexts = leafTexts(block);
      const creditsAfter = (label) => {
        const i = detailTexts.findIndex((t) => label.test(t));
        return i >= 0 ? parseCredits(detailTexts[i + 1]) : null;
      };
      // "Build Limit:" then "2" or "3 uses", "Ship Value" then "205,000"
      const intAfter = (label) => {
        const i = detailTexts.findIndex((t) => label.test(t));
        const n = i >= 0 ? parseInt((detailTexts[i + 1] || "").replace(/,/g, ""), 10) : NaN;
        return Number.isNaN(n) ? null : n;
      };
      detail = {
        name,
        requirements,
        buildCost: creditsAfter(/^Build Cost/i),
        guideValue: creditsAfter(/^Guide value/i),
        mfgSkill: intAfter(/^Manufacturing Skill:?$/i),
        buildLimit: intAfter(/^Build Limit:?$/i),
        levelReq: intAfter(/^Level Req:?$/i),
        // "Engineering Req:" then "Lvl 1 (You: 28)"
        engReq: (() => {
          const i = detailTexts.findIndex((t) => /^Engineering Req:?$/i.test(t));
          const m = i >= 0 ? (detailTexts[i + 1] || "").match(/Lvl\s*(\d+)/i) : null;
          return m ? parseInt(m[1], 10) : null;
        })(),
        shipValue: intAfter(/^Ship Value:?$/i),
      };
      continue;
    }
    const texts = leafTexts(block);
    // A discounted card shows the base price struck through, then the price
    // actually charged; an undiscounted one would show just the one.
    const prices = texts.map(parseCredits).filter((n) => n !== null);
    if (prices.length === 0) continue;
    const limit = texts.map((t) => t.match(/^(?:Build Limit|Builds):\s*(\d+)$/i)).find(Boolean);
    // Sits beside a wrench icon, so it isn't a leaf - read the span itself.
    const eng = [...block.querySelectorAll("span")].map((el) => el.textContent.trim().match(/^Eng Lvl\s*(\d+)$/i)).find(Boolean);
    const owned = texts.map((t) => t.match(/^OWNED \((\d+)/i)).find(Boolean);
    // The small uppercase badge, beside the name or in the card's footer.
    const badge = block.querySelector("span.uppercase");
    const shipClass = badge ? badge.textContent.trim() : null;
    const discount = texts.map((t) => t.match(/^-(\d+)%$/)).find(Boolean);
    list.push({
      name,
      owned: !!owned,
      copies: owned ? parseInt(owned[1], 10) : 0,
      shipClass,
      buildLimit: limit ? parseInt(limit[1], 10) : null,
      engReq: eng ? parseInt(eng[1], 10) : null,
      price: prices.length ? prices[prices.length - 1] : null,
      basePrice: prices.length ? prices[0] : null,
      discountPct: discount ? parseInt(discount[1], 10) : 0,
    });
  }
  // Whether an open blueprint's materials heading is on screen at all, so
  // materials that stop reading are noticed (see blueprintStoreReadOk()).
  const materialsShown = leafTexts(panel).some((t) => /^Resource Requirements$/i.test(t));
  const storeType = storeTypeFilter(panel);
  // Changing a filter doesn't close the open blueprint, so the panel can
  // still show one whose card the new filter has hidden. Its materials only
  // count when it matches a card in the list showing - otherwise it isn't
  // what the player has selected, so it isn't saved or announced.
  const detailStale = !!detail && !list.some((card) => card.name === detail.name);
  if (detailStale) detail = null;
  // Filters that match nothing leave the list empty, but the game keeps the
  // last blueprint open beside it - nothing to read, so nothing is saved
  // (that old blueprint isn't re-announced) and it isn't an unreadable store.
  if (list.length === 0 && storeFiltersActive(panel)) {
    return { list, detail: null, storeName: found.title, storeCategory: found.category, storeType, materialsShown, nothingListed: true };
  }
  return list.length || detail ? { list, detail, storeName: found.title, storeCategory: found.category, storeType, materialsShown, detailStale } : null;
}

// Read when its cards were, and - with a blueprint's materials on screen -
// those materials too, unless that blueprint is a leftover from before a
// filter change (detailStale), which is skipped on purpose.
function blueprintStoreReadOk(scraped) {
  if (scraped && scraped.nothingListed) return true;
  if (!scraped || scraped.list.length === 0) return false;
  return !scraped.materialsShown || scraped.detailStale || (!!scraped.detail && Object.keys(scraped.detail.requirements).length > 0);
}

function checkBlueprintStore() {
  const scraped = scrapeBlueprintStore();
  reportScreenRead("this blueprint store", !!scraped || !!blueprintStorePanel(), blueprintStoreReadOk(scraped));
  if (!scraped) {
    lastRecipeNotice = null;
    return;
  }
  // Keeps lastRecipeNotice, so clearing the filter with the same blueprint
  // still open doesn't announce it again.
  if (scraped.nothingListed) return;
  const snapshot = JSON.stringify(scraped);
  if (snapshot === lastBlueprintStoreSnapshot) return;
  // See checkCorpStore()'s comment for why this is only marked sent once
  // background.js confirms it.
  browser.runtime
    .sendMessage({ type: "fsc-blueprint-store-scrape", list: scraped.list, detail: scraped.detail, storeName: scraped.storeName, storeCategory: scraped.storeCategory, storeType: scraped.storeType })
    .then((result) => {
      lastBlueprintStoreSnapshot = snapshot;
      if (!result || !result.blueprint) {
        // A skipped leftover blueprint (detailStale) keeps the memory, so
        // clearing the filter with it still open doesn't announce it again.
        if (!scraped.detail && !scraped.detailStale) lastRecipeNotice = null;
        return;
      }
      const notice = `${result.blueprint}|${result.recipeStatus}`;
      if (notice === lastRecipeNotice) return;
      lastRecipeNotice = notice;
      showToast(RECIPE_NOTICES[result.recipeStatus](result.blueprint));
    })
    .catch(() => {});
}

// What the open blueprint's materials turned out to be against what was
// stored - see background.js's handleBlueprintStoreScrape().
const RECIPE_NOTICES = {
  saved: (name) => `${name} Blueprint Saved`,
  updated: (name) => `${name} Blueprint Updated - materials changed`,
  verified: (name) => `${name} Blueprint up to date`,
};

// A short notice at the top of the page, e.g. "Vigilance Blueprint Saved",
// so the player knows the blueprint they're looking at was stored. Its own
// Shadow DOM host keeps the game's CSS off it (and it off the game's); a
// second notice while one is showing replaces it.
const TOAST_MS = 3000;
let toastTimer = null;

function showToast(text, durationMs = TOAST_MS) {
  let host = document.getElementById("fsc-toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "fsc-toast-host";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .fsc-toast {
        position: fixed;
        top: 16px;
        left: 50%;
        z-index: 2147483647;
        transform: translate(-50%, -8px);
        max-width: calc(100vw - 32px);
        padding: 8px 16px;
        background: #0f172a;
        color: #e2e8f0;
        border: 1px solid #22d3ee;
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        font: 600 13px system-ui, -apple-system, "Segoe UI", sans-serif;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s, transform 0.2s;
      }
      .fsc-toast.fsc-visible {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    `;
    const toast = document.createElement("div");
    toast.className = "fsc-toast";
    shadow.append(style, toast);
    document.documentElement.appendChild(host);
  }
  const toast = host.shadowRoot.querySelector(".fsc-toast");
  toast.textContent = text;
  // Forces a style flush so the fade-in runs even on a freshly made host.
  void toast.offsetWidth;
  toast.classList.add("fsc-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("fsc-visible"), durationMs);
}

// "Can't read this screen" notices. Every reader above finds its screen by
// title text, which a redesign rarely changes, and then reads the contents
// by layout, which it often does. So a screen whose title is on the page
// while nothing could be read from it has most likely been redesigned, and
// the player is told instead of the sync just going quiet. Only after
// UNREADABLE_POLLS polls in a row, so a screen still loading its contents
// doesn't trip it, and only once until that screen closes or reads again.
const UNREADABLE_POLLS = 2;
const UNREADABLE_NOTICE_MS = 8000;
const unreadablePolls = new Map();
const unreadableNoticeShown = new Set();

function reportScreenRead(screen, open, readOk) {
  if (!open || readOk) {
    unreadablePolls.delete(screen);
    unreadableNoticeShown.delete(screen);
    return;
  }
  const polls = (unreadablePolls.get(screen) || 0) + 1;
  unreadablePolls.set(screen, polls);
  if (polls < UNREADABLE_POLLS || unreadableNoticeShown.has(screen)) return;
  unreadableNoticeShown.add(screen);
  console.warn(`[Forged Space Shipping Manifest] ${screen} is open but nothing could be read from it.`);
  showToast(`Shipping Manifest can't read ${screen} - the game may have changed this screen. Your saved data is unchanged.`, UNREADABLE_NOTICE_MS);
}

// A leaf element (no child elements) whose text is exactly `text`.
function findLeafText(selector, text) {
  for (const el of document.querySelectorAll(selector)) {
    if (el.childElementCount === 0 && el.textContent.trim() === text) return el;
  }
  return null;
}

// Character Skills window (the graduation-cap "Skills" button): a card per
// skill, each an <h4> name with a "Level N" line beside it. Only the
// Manufacturing and Engineering levels are read, so the Blueprints tab can
// flag blueprints the player can't run (or modules they can't fit) without
// the player typing them in. The Captain
// level comes from the top HUD bar instead ("Captain" over "Level 41"),
// which is always on screen; starship blueprints' "Level Req" is checked
// against it. The same bar gives the ship's Cargo and Ore Hold capacities,
// which set the mining trip size.
const SKILLS_PANEL_TITLE = "Character Skills";
let lastSkillsSnapshot = null;

function scrapeSkillLevel(skillName) {
  const title = [...document.querySelectorAll("h2")].find((h2) => h2.textContent.trim() === SKILLS_PANEL_TITLE);
  if (!title) return null;
  for (const h4 of document.querySelectorAll("h4")) {
    if (h4.textContent.trim() !== skillName) continue;
    const level = (h4.parentElement.textContent || "").match(/Level\s*(\d+)/i);
    if (level) return parseInt(level[1], 10);
  }
  return null;
}

// The HUD bar's "Cargo 0/150" and, on ships that have one, "Ore Hold
// 0/2000" - label span followed by a "used/capacity" span. Returns the
// capacities ({cargo, oreHold}, oreHold null when the ship has none), or
// null when the HUD isn't on screen, so a hidden HUD never reads as "no
// Ore Hold".
function scrapeShipHolds() {
  const capacityAfter = (label) => {
    for (const span of document.querySelectorAll("span")) {
      if (span.textContent.trim() !== label || !span.nextElementSibling) continue;
      const m = span.nextElementSibling.textContent.trim().match(/^[\d,]+\s*\/\s*([\d,]+)$/);
      if (m) return parseInt(m[1].replace(/,/g, ""), 10);
    }
    return null;
  };
  const cargo = capacityAfter("Cargo");
  if (cargo === null) return null;
  return { cargo, oreHold: capacityAfter("Ore Hold") };
}

function scrapeCaptainLevel() {
  for (const span of document.querySelectorAll("span")) {
    if (span.textContent.trim() !== "Captain" || !span.nextElementSibling) continue;
    const level = span.nextElementSibling.textContent.trim().match(/^Level\s*(\d+)$/i);
    if (level) return parseInt(level[1], 10);
  }
  return null;
}

// overlay-setup.js once loaded (see the import at the bottom): the Manifest
// Setup window, and the session reminder told here when storage and skills
// have been read and when the player is in the game.
let setupWindows = null;

function checkSkills() {
  const manufacturing = scrapeSkillLevel("Manufacturing");
  const engineering = scrapeSkillLevel("Engineering");
  const captain = scrapeCaptainLevel();
  const holds = scrapeShipHolds();
  // Manufacturing and Engineering are on the Ship Skills tab only, so the
  // window counts as read when any skill card on the open tab reads the same
  // way (a name with "Level N" beside it).
  const skillsWindowOpen = !!findLeafText("h2", SKILLS_PANEL_TITLE);
  const skillsRead =
    manufacturing !== null || engineering !== null || [...document.querySelectorAll("h4")].some((h4) => /Level\s*\d+/i.test(h4.parentElement.textContent || ""));
  reportScreenRead("Character Skills", skillsWindowOpen, skillsRead);
  if (setupWindows) {
    if (manufacturing !== null || engineering !== null) setupWindows.noteRead("skills");
    // The top bar is only on screen once the player is in the game.
    if (captain !== null || holds !== null) setupWindows.noteInGame();
  }
  if (manufacturing === null && engineering === null && captain === null && holds === null) return;
  const snapshot = JSON.stringify([manufacturing, engineering, captain, holds]);
  if (snapshot === lastSkillsSnapshot) return;
  // See checkCorpStore()'s comment for why this is only marked sent once
  // background.js confirms it.
  browser.runtime
    .sendMessage({ type: "fsc-skills-scrape", manufacturing, engineering, captain, holds })
    .then(() => { lastSkillsSnapshot = snapshot; })
    .catch(() => {});
}

// Systems Lexicon: a static reference/help panel ("Quick reference guide
// for Forged Space gameplay"), not live game state - Manufacturing category,
// "Planet Types & Resources" topic. Unlike storage/Corp Store/Assembler
// Plans (all open during normal play, scraped continuously), this is a rare,
// deliberate action - a player has to open Systems Lexicon, pick
// Manufacturing, and click to expand this one topic - so js/tab-planets.js
// has its own hint telling players that's what triggers a sync.
//
// Each topic on this screen is a <button> (its label is the only text node
// inside, since its icon/chevron SVGs carry none) immediately followed, ONLY
// while expanded, by a sibling <div> holding the topic's content - same
// "find by header text, then scope to what follows" approach as
// findIndigoPanel() above, just via a live DOM relationship (nextElementSibling)
// instead of a fixed panel lookup, since Lexicon topics don't have IDs.
// Confirmed via live inspection (not the assumed/fixed gradient/border
// classes every topic row shares, which aren't unique to this one topic).
const LEXICON_PLANET_TOPIC_LABEL = "Planet Types & Resources";
// bg-slate-800/50's "/" needs an attribute-contains selector, not an
// escaped class selector - same reasoning as STORAGE_ROW_SELECTOR/
// INDIGO_ROW_SELECTOR above.
const LEXICON_PLANET_LIST_SELECTOR = 'div[class*="bg-slate-800/50"][class*="space-y-2"]';
const LEXICON_POLL_MS = 2000;

let lastLexiconPlanetsSnapshot = null;

function findExpandedLexiconTopicContent(topicLabel) {
  for (const btn of document.querySelectorAll("button")) {
    if (btn.textContent.trim() !== topicLabel) continue;
    return btn.nextElementSibling || null; // null = this topic exists but isn't expanded right now
  }
  return null; // topic button not found at all (Lexicon closed, or a different category selected)
}

// "Arid worlds with mineral-rich sands. Resources: Cinderstone, Ferric Sand,
// Kethite Glass, Xenocrete Powder." -> description + 4 resource names. NOT
// consistently formatted in-game - some entries omit the "Resources: "
// prefix and/or the trailing period (confirmed live: Gas World and the new
// Toxic entry both do) - split on the first ". " (description/resources
// boundary, which every observed entry has exactly once) rather than
// assuming a fixed prefix/suffix.
function parseLexiconPlanetEntry(nameText, paragraphText) {
  const idx = paragraphText.indexOf(". ");
  if (idx === -1) return null;
  const description = paragraphText.slice(0, idx + 1).trim();
  const resourcesPart = paragraphText.slice(idx + 2).trim().replace(/^Resources:\s*/i, "").replace(/\.$/, "");
  const resources = resourcesPart.split(",").map((s) => s.trim()).filter(Boolean);
  return resources.length > 0 ? { name: nameText.trim(), description, resources } : null;
}

function scrapeLexiconPlanetTypes() {
  const content = findExpandedLexiconTopicContent(LEXICON_PLANET_TOPIC_LABEL);
  if (!content) return [];
  const listEl = content.querySelector(LEXICON_PLANET_LIST_SELECTOR);
  if (!listEl) return [];
  const items = [];
  listEl.querySelectorAll(":scope > div").forEach((row) => {
    const nameEl = row.querySelector("span");
    const descEl = row.querySelector("p");
    if (!nameEl || !descEl) return;
    const parsed = parseLexiconPlanetEntry(nameEl.textContent, descEl.textContent);
    if (parsed) items.push(parsed);
  });
  return items;
}

function checkLexiconPlanets() {
  const items = scrapeLexiconPlanetTypes();
  reportScreenRead("the Lexicon's planet types", items.length === 0 && !!findExpandedLexiconTopicContent(LEXICON_PLANET_TOPIC_LABEL), items.length > 0);
  if (items.length === 0) return;
  const snapshot = JSON.stringify(items);
  if (snapshot === lastLexiconPlanetsSnapshot) return;
  // Only marked "sent" once background.js confirms it - see
  // checkCorpStore()'s comment for why. Matters even more here than for
  // Assembler Plans: this topic is only in the DOM at all while a player
  // has it manually expanded, a rare moment - a dropped send has no
  // guarantee of a timely retry the way a continuously-open screen would get.
  browser.runtime
    .sendMessage({ type: "fsc-lexicon-planets-scrape", planetTypes: items })
    .then(() => { lastLexiconPlanetsSnapshot = snapshot; })
    .catch(() => {});
}

const pollIntervalIds = [
  setInterval(checkStorage, STORAGE_POLL_MS),
  setInterval(checkCorpStore, CORP_POLL_MS),
  setInterval(checkAssemblerPlans, ASSEMBLER_POLL_MS),
  setInterval(checkResearchPlans, ASSEMBLER_POLL_MS),
  setInterval(checkBlueprintStore, ASSEMBLER_POLL_MS),
  setInterval(checkSkills, ASSEMBLER_POLL_MS),
  setInterval(checkLexiconPlanets, LEXICON_POLL_MS),
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
  document.getElementById("fsc-toast-host")?.remove();
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

  // The "Manifest Setup" checklist window - shown only while setup isn't
  // finished or skipped (see overlay-setup.js). After the overlay, whose
  // drag code it reuses.
  return import(browser.runtime.getURL("js/overlay-setup.js")).then((setup) => {
    if (!isExtensionContextValid()) return;
    setup.initSetupPanel();
    setupWindows = setup;
  });
}).catch((err) => {
  // Without this, a failure here (e.g. a module missing from manifest.json's
  // web_accessible_resources) throws an unhandled rejection that shows up in
  // the console but leaves no trace of what broke on-page - the overlay just
  // silently never appears.
  console.error("Forged Space Shipping Manifest: failed to load the Manifest overlay or the Manifest Setup window.", err);
});
