// MV3 background service worker (not a persistent background page -
// Chrome MV3 requires this, and Firefox's MV3 support follows the same
// service_worker manifest key for a single cross-browser manifest.json).
//
// Classifies a scraped storage-screen snapshot from content.js and writes it
// straight into browser.storage.local, instead of relaying it to the Python
// bridge over HTTP the way the pre-migration version did.
//
// Unlike the old persistent background page, a service worker can be
// terminated by the browser whenever it's idle and restarted later on the
// next event (a message, an action click, etc.) - it does NOT keep running
// in the background the whole time the browser is open. This is fine for
// this file: handleStorageScrape() and the action click handler are both
// pure event-response functions with no reliance on state surviving between
// invocations (see findManifestWindow() below, which deliberately queries
// live window state each time instead of remembering a window id in a
// variable, since any such variable would silently reset to its initial
// value every time the worker restarts).
//
// The old GET /to-mine.json polling loop that used to live here is gone:
// the "Manifest" window (popup.html/popup.js) reads storage.local's
// `toMineData` key directly (extension pages have storage access, so no
// relay was needed), and the dashboard's Plan a Build tab writes that key
// on every calculation.
//
// The toolbar icon opens/focuses a single floating browser window (type:
// "popup"), not an action dropdown - a dropdown always closes on blur/
// outside-click with no way to override that, which didn't fit the user's
// ask for something that stays open and can be dragged beside the game
// window. That SAME window can show either the full dashboard.html or the
// compact popup.html ("Manifest") - popup.js's "Dashboard →" button and
// dashboard.js's "← Manifest" button both just navigate it in place
// (window.location), not open a separate tab.
//
// The toolbar icon opens straight into the DASHBOARD, not the compact
// Manifest view - deliberately, since browser.windows.create() can bake
// the target size in at creation time with no race to worry about, unlike
// resizing an already-open window right before/after a same-window
// navigation (which is exactly what made switching TO the dashboard
// unreliable on Chrome - see popup.js's/dashboard.js's own comments on
// that). A first-time/every-time player lands somewhere they can actually
// see everything and set builds up, then switches to the compact Manifest
// view themselves once ready - that transition (dashboard -> Manifest) has
// popup.js's own resizeToFit() as a reliable, independently-working
// correction step once it loads, so it doesn't have the same problem.

import "./js/browser-compat.js";
import { Catalog } from "./js/catalog.js";
import { applyItemsToInventory } from "./js/inventory-classify.js";
import { AssemblyRecipe, entriesToTotals, expandCommodities, harvesterTotals, planMining, toStorableCorpData, toStorableToMineData } from "./js/calc-engine.js";
import * as storage from "./js/storage.js";

const catalog = new Catalog();

// One-time permission/privacy disclaimer, shown as a new tab the first time
// the extension is installed - NOT on every browser start or on updates
// (details.reason is "install" only once, ever, per install; "update" fires
// on every version bump and "browser_update" on browser upgrades, neither
// of which should re-show this). async + awaited (not fire-and-forget) for
// the same reason as the onMessage listener below - an async listener that
// returns a Promise is one of the recognized ways Chrome keeps an MV3
// service worker alive until it settles, on this and other "extendable"
// events like action.onClicked.
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  await browser.tabs.create({ url: browser.runtime.getURL("welcome.html") });
});

// Matches popup.js's/dashboard.js's own DASHBOARD_WIDTH/HEIGHT - kept as a
// separate copy here too rather than shared/imported, same reasoning as
// dashboard.js's own copy (these files don't otherwise share a module, and
// it's just two numbers).
const DASHBOARD_WIDTH = 1000;
const DASHBOARD_HEIGHT = 700;

// Finds an already-open floating window by looking for a tab pointing at
// EITHER of this extension's own pages - popup.html ("Manifest") or
// dashboard.html, whichever it currently happens to be showing - not by
// remembering a window id, since an in-memory variable wouldn't survive a
// service-worker restart. Reading tab.url for the extension's own pages
// doesn't require the "tabs" permission (only reading OTHER sites' tab
// URLs does).
async function findManifestWindow() {
  const popupUrl = browser.runtime.getURL("popup.html");
  const dashboardUrl = browser.runtime.getURL("dashboard.html");
  const wins = await browser.windows.getAll({ populate: true });
  return wins.find((win) => win.tabs && win.tabs.some((tab) => tab.url === popupUrl || tab.url === dashboardUrl)) || null;
}

browser.action.onClicked.addListener(async () => {
  const existing = await findManifestWindow();
  if (existing) {
    await browser.windows.update(existing.id, { focused: true });
    return;
  }
  // Full dashboard size baked in at creation time - see this file's header
  // comment for why opening straight into dashboard.html (rather than the
  // compact popup.html) is deliberate.
  await browser.windows.create({
    url: browser.runtime.getURL("dashboard.html"),
    type: "popup",
    width: DASHBOARD_WIDTH,
    height: DASHBOARD_HEIGHT,
  });
});

// items: [{name, quantity}, ...] scraped from the storage screen by
// content.js. Classifies against the shared Catalog and merges into
// whatever's currently in storage.local's `inventory` key - the same
// classification logic used to live in inventory_import.py's
// apply_items_to_inventory, called from the Python bridge's POST handler.
async function handleStorageScrape(items) {
  const itemsDict = {};
  for (const item of items || []) {
    if (item && item.name && item.quantity !== null && item.quantity !== undefined) {
      itemsDict[String(item.name)] = Number(item.quantity);
    }
  }
  const inventory = await storage.loadInventory(catalog);
  const { matched, unmatched } = applyItemsToInventory(catalog, inventory, itemsDict);
  await storage.saveInventory(inventory);
  await storage.saveInventorySyncStatus({ syncedAt: new Date().toISOString(), matched, unmatched });
  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
}

// items: [{name, quantity}, ...] scraped from the Corp Store panel by
// content.js. Unlike personal storage, this is stored as a flat name->qty
// dict rather than a classified Inventory - see storage.js's
// loadCorpInventory()/saveCorpInventory() and toStorableCorpData() for why.
async function handleCorpStoreScrape(items) {
  const corpInventory = {};
  for (const item of items || []) {
    if (item && item.name && item.quantity !== null && item.quantity !== undefined) {
      corpInventory[String(item.name)] = Number(item.quantity);
    }
  }
  await storage.saveCorpInventory(corpInventory);
  await recalculateActiveBuildCorpData();
}

// Corp-store counterpart to recalculateActiveBuildToMineData() above, kept
// headless for the same reason (the floating window's Corp view needs fresh
// numbers even when the dashboard isn't open). Reads activeCorpBuildName -
// the build picked on the Corp tab - NOT activeBuildName (Plan a Build's own
// selection); a corp project is usually a different thing entirely from
// whatever a player is personally building. Runs expandCommodities() (same
// as the personal pipeline) so Assembly-produced Commodities in the build
// cascade down into their own ore/material ingredient totals too - a corp
// order for e.g. Graviton Emitters should also surface the Zephyr
// Flux/Geolith Fragments/etc. actually needed to assemble them, not just the
// finished-commodity name. Deliberately stops there rather than running
// planMining()'s further ore-consolidation/raw-ore-need pipeline, since
// corp-store items are compared directly by name at whatever stage they're
// in (raw ore, refined material, or finished commodity - see
// toStorableCorpData()), unlike personal mining which only cares about raw
// ore.
async function recalculateActiveBuildCorpData() {
  const activeCorpBuildName = await storage.loadActiveCorpBuildName();
  if (!activeCorpBuildName) return;
  const builds = await storage.loadBuilds();
  const entries = builds[activeCorpBuildName];
  if (!entries || entries.length === 0) return;

  const recipes = await storage.loadRecipes();
  const assemblyRecipes = await storage.loadAssemblyRecipes();
  const corpInventory = await storage.loadCorpInventory();
  const corpHaveOverrides = await storage.loadCorpHaveOverrides();
  const settings = await storage.loadSettings();
  const cargoCapacity = Number(settings.cargo_capacity || 600);

  const oreChoices = {};
  for (const [item, oreName] of Object.entries(settings.ore_choices || {})) {
    const ore = catalog.findOre(oreName);
    if (ore) oreChoices[item] = ore;
  }

  const totals = entriesToTotals(recipes, entries);
  const { expanded } = expandCommodities(catalog, totals, assemblyRecipes, { other: corpInventory });
  await storage.saveCorpToMineData(toStorableCorpData(catalog, assemblyRecipes, oreChoices, expanded, corpInventory, cargoCapacity, corpHaveOverrides));
}

// The previously-calculated plan (toMineData) was computed against the OLD
// inventory, so it's now stale. dashboard.js has its own storage.onChanged
// listener that recalculates when the Plan a Build tab notices an inventory
// change, but that only fires while the dashboard page is actually open -
// and since switching the floating window back to the compact "Manifest"
// view fully unloads the dashboard (see popup.js/
// dashboard.js's same-window navigation), the dashboard is often NOT open
// during normal play. This headless recalculation is what keeps the
// floating window's numbers correct in that (common) case. Mirrors
// tab-plan.js's calculatePlan() math for a single build, except ore
// choices come from the already-persisted `settings.ore_choices` instead
// of live <select> elements (there's no DOM here) - the same approach
// tab-plan.js's own calculateAllBuilds() already uses.
async function recalculateActiveBuildToMineData() {
  const activeBuildName = await storage.loadActiveBuildName();
  if (!activeBuildName) return;
  const builds = await storage.loadBuilds();
  const entries = builds[activeBuildName];
  if (!entries || entries.length === 0) return;

  const recipes = await storage.loadRecipes();
  const assemblyRecipes = await storage.loadAssemblyRecipes();
  const inventory = await storage.loadInventory(catalog);
  const pendingRefining = await storage.loadPendingRefining();
  const settings = await storage.loadSettings();
  const maxHarvesters = Number(settings.max_harvesters || 4);
  const harvesterSlots = await storage.loadHarvesterSlots(maxHarvesters);
  const cargoCapacity = Number(settings.cargo_capacity || 600);

  const totals = entriesToTotals(recipes, entries);
  const { expanded, assemblyHours } = expandCommodities(catalog, totals, assemblyRecipes, inventory, 20, settings.item_acquisition_mode);

  const oreChoices = {};
  for (const [item, oreName] of Object.entries(settings.ore_choices || {})) {
    const ore = catalog.findOre(oreName);
    if (ore) oreChoices[item] = ore;
  }

  const result = planMining(catalog, expanded, inventory, oreChoices, cargoCapacity, harvesterTotals(harvesterSlots), pendingRefining, assemblyHours);
  await storage.saveToMineData(toStorableToMineData(result, cargoCapacity));
}

// items: [{name, requirements, ratePerHour, captainLevel, rdLevel, rdMet}]
// scraped from the Assembler Plans screen by content.js - both its "All
// Plans" and "R&D Unlocked" filters feed here (the latter already
// pre-filtered to rdMet rows there); everything on that screen is
// Assembly-produced, so this only ever writes assemblyRecipes, never
// recipes (see tab-recipes.js's own header comment - Recipes stay
// hand-entered only; a separate Item Database scrape for those was
// explored and deliberately shelved as more complicated than it's worth).
// Only touches assemblyRecipes actually present in this scrape - anything
// not scraped this round (e.g. a hand-entered recipe for something outside
// this database) is left completely alone. For items that ARE scraped,
// this is treated as authoritative: requirements no longer present in the
// scraped ingredient list are pruned, so a recipe stays in sync if Coops
// changes it in a future update rather than silently accumulating stale
// entries.
async function handleAssemblerScrape(items) {
  const assemblyRecipes = await storage.loadAssemblyRecipes();
  for (const item of items || []) {
    if (!item || !item.name) continue;
    const recipe = assemblyRecipes[item.name] || new AssemblyRecipe(item.name, item.ratePerHour || 1);
    recipe.ratePerHour = item.ratePerHour || recipe.ratePerHour || 1;
    const scrapedReqs = item.requirements || {};
    for (const [reqName, qty] of Object.entries(scrapedReqs)) recipe.setRequirement(reqName, qty);
    for (const existingName of Object.keys(recipe.requirements)) {
      if (!(existingName in scrapedReqs)) recipe.setRequirement(existingName, 0);
    }
    recipe.captainLevel = item.captainLevel ?? null;
    assemblyRecipes[item.name] = recipe;
  }
  await storage.saveAssemblyRecipes(assemblyRecipes);
  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
}

// Lets the Manifest window (popup.js) set exactly how many batches of an
// ore are currently started/pending refining, without needing the full
// dashboard open - an absolute SET (typed number), not an increment, to
// match the real workflow: type the count when you start a run, then reset
// it back to 0 once you've collected the output and are between runs. Same
// underlying pendingRefining storage key and semantics as the dashboard's
// own Inventory/Plan a Build tab controls (see tab-inventory.js's
// applyLocalPendingDeduction(), mirrored here since the popup has no `app`
// state to call that against directly).
async function handleSetPendingBatches(oreName, newBatches) {
  const ore = catalog.findOre(oreName);
  if (!ore || Number.isNaN(newBatches) || newBatches < 0) return;
  const pendingRefining = await storage.loadPendingRefining();
  const oldBatches = pendingRefining[oreName] || 0;
  if (newBatches === oldBatches) return;

  if (newBatches > oldBatches) {
    // Optimistic raw-ore deduction, only ever applied on an increase (ahead
    // of the next live storage sync) - never reversed on a decrease (e.g.
    // resetting back to 0 after collecting), which instead waits for a real
    // sync to correct it. Matches applyLocalPendingDeduction()'s exact
    // behavior.
    const inventory = await storage.loadInventory(catalog);
    const rawDelta = (newBatches - oldBatches) * ore.batch;
    const current = inventory.rawOre.get(ore) || 0;
    inventory.rawOre.set(ore, Math.max(0, current - rawDelta));
    await storage.saveInventory(inventory);
  }

  if (newBatches <= 0) delete pendingRefining[oreName];
  else pendingRefining[oreName] = newBatches;
  await storage.savePendingRefining(pendingRefining);

  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
}

// Returning `true` (and eventually calling sendResponse) - rather than just
// firing the handler and letting the listener return undefined - keeps the
// message port open, which is what tells Chrome's MV3 service worker there's
// still pending async work and it shouldn't be terminated yet. Without this,
// a fire-and-forget handleXxx() call can get cut off mid-await the instant
// this synchronous listener function returns: Chrome considers the message
// "handled" immediately and is free to kill the worker right then, before
// e.g. storage.savePendingRefining() ever actually runs. Firefox's
// background page (see manifest.json's "scripts" fallback, used there
// instead of a real MV3 service worker) doesn't get torn down anywhere near
// as aggressively, which is why this only ever showed up testing on real
// Chrome - a scrape handler dropped this way silently self-corrects on the
// next ~2s poll, but a one-off action like setting a batch count has no
// retry, so losing it here is immediately visible. None of the callers
// (popup.js/content.js) care about the actual response value, only that the
// message succeeded - see their own `.catch(() => {})`.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;
  let handled;
  if (msg.type === "fsc-storage-scrape") handled = handleStorageScrape(msg.items);
  else if (msg.type === "fsc-corp-store-scrape") handled = handleCorpStoreScrape(msg.items);
  else if (msg.type === "fsc-assembler-scrape") handled = handleAssemblerScrape(msg.items);
  else if (msg.type === "fsc-set-pending-batches") handled = handleSetPendingBatches(msg.oreName, msg.batches);
  else return undefined;
  // sendResponse() itself can throw if the sender's port is already gone
  // (e.g. the Manifest popup window got closed in the moment between
  // sending this and the handler finishing) - wrapped so that edge case is
  // just silently ignored rather than becoming an unhandled rejection, same
  // as the senders' own `.catch(() => {})` already treats a failed send.
  const respond = () => { try { sendResponse(); } catch { /* sender gone, nothing to respond to */ } };
  handled.then(respond).catch(respond);
  return true;
});
