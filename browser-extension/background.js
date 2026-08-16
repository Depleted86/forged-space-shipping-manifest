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
// invocations.
//
// The old GET /to-mine.json polling loop that used to live here is gone:
// the Manifest overlay (js/overlay-manifest.js, injected by content.js
// directly into the game page) reads storage.local's `toMineData` key
// directly (content scripts have storage access, so no relay is needed),
// and the dashboard's Plan a Build tab writes that key on every
// calculation.
//
// The Manifest view is no longer a separate browser window at all - it used
// to be (popup.html/popup.js, now removed), staying "on top" of the game
// only via the OS window manager's own always-on-top, which isn't a real
// WebExtension capability (browser.windows has no such option, on any
// browser, by design) and so only worked on setups where the user's own
// window manager happened to provide it. It's now an in-page overlay
// rendered directly into the game page at the highest CSS stacking level
// (see content.js/js/overlay-manifest.js) - guaranteed to render above the
// game everywhere, no window-manager cooperation needed. The toolbar icon
// toggles that overlay's visibility on whichever forgedspace.com tab is
// open (see action.onClicked below) rather than opening/focusing a window.
// The dashboard is reached via its own "Dashboard →" button on the
// overlay, which opens dashboard.html as a completely ordinary new tab
// (see handleOpenDashboard()) - no more popup-type window, no more
// same-window navigation between the two, so none of the resize-timing
// problems that came with that model apply anymore either.

import "./js/browser-compat.js";
import { Catalog } from "./js/catalog.js";
import { applyItemsToInventory } from "./js/inventory-classify.js";
import { AssemblyPlan, entriesToTotals, expandCommodities, harvesterTotals, planMining, toStorableCorpData, toStorableToMineData } from "./js/calc-engine.js";
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

// Toggles the Manifest overlay on whichever forgedspace.com tab is open -
// finds one via a host-permission-scoped tabs.query() (no "tabs" permission
// needed: an extension can always see full tab info, url included, for any
// tab matching a host it already has permission for), focuses it, and
// messages its content script to flip the overlay's visibility (see
// content.js's onMessage listener / overlay-manifest.js's
// toggleManifestOverlay()). If no game tab is open at all, there's nothing
// to toggle - the overlay only exists inside that page - so this opens one
// instead of silently doing nothing; the player may need one more click
// once it's finished loading to actually reveal the overlay, since
// reliably auto-showing it the instant a brand new tab's content script
// finishes injecting isn't achievable without either a listener that can
// get lost across an MV3 service-worker restart (dynamically-added
// tabs.onUpdated listeners aren't guaranteed to survive that the way
// top-level ones are) or added storage-flag bookkeeping - not worth the
// complexity for what's just a "click once more" inconvenience.
browser.action.onClicked.addListener(async () => {
  const tabs = await browser.tabs.query({ url: "https://forgedspace.com/*" });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await browser.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
    await browser.tabs.sendMessage(tab.id, { type: "fsc-toggle-overlay" }).catch(() => {});
    return;
  }
  await browser.tabs.create({ url: "https://forgedspace.com/" });
});

// The Manifest overlay's "Dashboard →" button (a content script can't call
// browser.tabs directly, so it messages this instead - see content.js's
// onMessage listener). Focuses an already-open dashboard tab if one
// exists, rather than piling up duplicates on repeated clicks.
async function handleOpenDashboard() {
  const dashboardUrl = browser.runtime.getURL("dashboard.html");
  const tabs = await browser.tabs.query({ url: dashboardUrl });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await browser.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url: dashboardUrl });
}

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

  const blueprints = await storage.loadBlueprints();
  const assemblyPlans = await storage.loadAssemblyPlans();
  const corpInventory = await storage.loadCorpInventory();
  const corpHaveOverrides = await storage.loadCorpHaveOverrides();
  const settings = await storage.loadSettings();
  const cargoCapacity = Number(settings.cargo_capacity || 600);

  const oreChoices = {};
  for (const [item, oreName] of Object.entries(settings.ore_choices || {})) {
    const ore = catalog.findOre(oreName);
    if (ore) oreChoices[item] = ore;
  }

  const totals = entriesToTotals(blueprints, entries);
  const { expanded } = expandCommodities(catalog, totals, assemblyPlans, { other: corpInventory });
  await storage.saveCorpToMineData(toStorableCorpData(catalog, assemblyPlans, oreChoices, expanded, corpInventory, cargoCapacity, corpHaveOverrides));
}

// The previously-calculated plan (toMineData) was computed against the OLD
// inventory, so it's now stale. dashboard.js has its own storage.onChanged
// listener that recalculates when the Plan a Build tab notices an inventory
// change, but that only fires while the dashboard page is actually open -
// and the dashboard is now always a separate, ordinary tab a player has to
// deliberately open (see js/overlay-manifest.js), so it's very often NOT
// open during normal play. This headless recalculation is what keeps the
// in-page Manifest overlay's numbers correct in that (common) case. Mirrors
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

  const blueprints = await storage.loadBlueprints();
  const assemblyPlans = await storage.loadAssemblyPlans();
  const inventory = await storage.loadInventory(catalog);
  const pendingRefining = await storage.loadPendingRefining();
  const settings = await storage.loadSettings();
  const maxHarvesters = Number(settings.max_harvesters || 4);
  const harvesterSlots = await storage.loadHarvesterSlots(maxHarvesters);
  const cargoCapacity = Number(settings.cargo_capacity || 600);

  const totals = entriesToTotals(blueprints, entries);
  const { expanded, assemblyHours } = expandCommodities(catalog, totals, assemblyPlans, inventory, 20, settings.item_acquisition_mode);

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
// Assembly-produced, so this only ever writes assemblyPlans, never
// blueprints (see tab-blueprints.js's own header comment - Blueprints stay
// hand-entered only; a separate Item Database scrape for those was
// explored and deliberately shelved as more complicated than it's worth).
// Only touches assemblyPlans actually present in this scrape - anything
// not scraped this round (e.g. a hand-entered Assembly Plan for something
// outside this database) is left completely alone. For items that ARE
// scraped, this is treated as authoritative: requirements no longer
// present in the scraped ingredient list are pruned, so a plan stays in
// sync if Coops changes it in a future update rather than silently
// accumulating stale entries.
async function handleAssemblerScrape(items) {
  const assemblyPlans = await storage.loadAssemblyPlans();
  for (const item of items || []) {
    if (!item || !item.name) continue;
    const plan = assemblyPlans[item.name] || new AssemblyPlan(item.name, item.ratePerHour || 1);
    plan.ratePerHour = item.ratePerHour || plan.ratePerHour || 1;
    const scrapedReqs = item.requirements || {};
    for (const [reqName, qty] of Object.entries(scrapedReqs)) plan.setRequirement(reqName, qty);
    for (const existingName of Object.keys(plan.requirements)) {
      if (!(existingName in scrapedReqs)) plan.setRequirement(existingName, 0);
    }
    plan.captainLevel = item.captainLevel ?? null;
    assemblyPlans[item.name] = plan;
  }
  await storage.saveAssemblyPlans(assemblyPlans);
  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
}

// Lets the in-page Manifest overlay (js/overlay-manifest.js) set exactly
// how many batches of an ore are currently started/pending refining,
// without needing the full dashboard open - an absolute SET (typed
// number), not an increment, to match the real workflow: type the count
// when you start a run, then reset it back to 0 once you've collected the
// output and are between runs. Same underlying pendingRefining storage key
// and semantics as the dashboard's own Inventory/Plan a Build tab controls
// (see tab-inventory.js's applyLocalPendingDeduction(), mirrored here since
// the overlay has no `app` state to call that against directly).
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
// (content.js/js/overlay-manifest.js) care about the actual response value,
// only that the message succeeded - see their own `.catch(() => {})`.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;
  let handled;
  if (msg.type === "fsc-storage-scrape") handled = handleStorageScrape(msg.items);
  else if (msg.type === "fsc-corp-store-scrape") handled = handleCorpStoreScrape(msg.items);
  else if (msg.type === "fsc-assembler-scrape") handled = handleAssemblerScrape(msg.items);
  else if (msg.type === "fsc-set-pending-batches") handled = handleSetPendingBatches(msg.oreName, msg.batches);
  else if (msg.type === "fsc-open-dashboard") handled = handleOpenDashboard();
  else return undefined;
  // sendResponse() itself can throw if the sender's port is already gone
  // (e.g. the game tab got closed in the moment between sending this and
  // the handler finishing) - wrapped so that edge case is just silently
  // ignored rather than becoming an unhandled rejection, same as the
  // senders' own `.catch(() => {})` already treats a failed send.
  const respond = () => { try { sendResponse(); } catch { /* sender gone, nothing to respond to */ } };
  handled.then(respond).catch(respond);
  return true;
});
