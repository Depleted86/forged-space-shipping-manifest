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
import { AssemblyPlan, Blueprint, entriesToTotals, expandCommodities, harvesterTotals, itemResourceBreakdown, planMining, toStorableCorpData, toStorableToMineData } from "./js/calc-engine.js";
import * as storage from "./js/storage.js";

const catalog = new Catalog();
// Fire-and-forget - applies whatever's already been scraped from the
// Systems Lexicon on top of the static baseline (see catalog.js's
// applyScrapedPlanetTypes() comment). A message arriving in the brief
// window before this resolves would just see the static baseline, same as
// before this feature existed - not worth blocking message handling on.
storage.loadScrapedPlanetTypes().then((scraped) => catalog.applyScrapedPlanetTypes(scraped));

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
// complete: content.js saw the whole storage list (search box empty, row
// count matching the window's "N items" badge), so it replaces the stored
// inventory - an item used up entirely drops to 0. Otherwise (a search is
// filtering it, or the count didn't match) it's merged: the items shown are
// updated and everything else keeps its last count, since replacing would
// zero whatever the filter hid. The Inventory tab's "Clear stored
// inventory" resets the list by hand if it ever drifts.
async function handleStorageScrape(items, complete) {
  const inventory = await storage.loadInventory(catalog);
  const itemsDict = {};
  if (!complete) {
    for (const [ore, qty] of inventory.rawOre) itemsDict[ore.name] = qty;
    for (const [material, qty] of inventory.refined) itemsDict[material.name] = qty;
    Object.assign(itemsDict, inventory.other);
  }
  for (const item of items || []) {
    if (item && item.name && item.quantity !== null && item.quantity !== undefined) {
      itemsDict[String(item.name)] = Number(item.quantity);
    }
  }
  const { matched, unmatched } = applyItemsToInventory(catalog, inventory, itemsDict);
  await storage.saveInventory(inventory);
  await storage.saveInventorySyncStatus({ syncedAt: new Date().toISOString(), matched, unmatched });
  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
  await recalculateManifestSelection();
  await recalculateManifestCorpSelection();
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
  await recalculateManifestCorpSelection();
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

// Corp-view counterpart to recalculateManifestSelection() below, mirroring
// this function's own math almost exactly (same corp inventory/settings
// inputs, same expandCommodities()->toStorableCorpData() pipeline), but
// sourcing requirements from whichever Blueprint or Build Order the
// overlay's OWN Corp-view dropdown has selected (storage.js's
// manifestCorpSelection) instead of the dashboard Corp tab's
// activeCorpBuildName - independent for the exact same reason
// recalculateManifestSelection() is independent of the dashboard's Plan a
// Build tab (see manifestCorpSelection's own storage.js comment). Still
// uses the GLOBAL settings.ore_choices, same as
// recalculateActiveBuildCorpData() above - no per-selection ore choices for
// Corp, since its Refined section has no ore picker at all (see
// storage.js's manifestCorpSelection comment for why).
async function recalculateManifestCorpSelection() {
  const selection = await storage.loadManifestCorpSelection();
  if (!selection) {
    await storage.saveManifestCorpToMineData({ available: false, items: [], refined: [] });
    return;
  }

  const blueprints = await storage.loadBlueprints();
  let totals;
  if (selection.type === "blueprint") {
    const blueprint = blueprints[selection.name];
    if (!blueprint) {
      await storage.saveManifestCorpToMineData({ available: false, items: [], refined: [] });
      return;
    }
    // Always previewed at 1x - same as the personal selector's Blueprint
    // mode, confirmed with the user there, no reason for Corp to differ.
    totals = blueprint.scaled(1);
  } else {
    const builds = await storage.loadBuilds();
    const entries = builds[selection.name];
    if (!entries || entries.length === 0) {
      await storage.saveManifestCorpToMineData({ available: false, items: [], refined: [] });
      return;
    }
    totals = entriesToTotals(blueprints, entries);
  }

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

  const { expanded } = expandCommodities(catalog, totals, assemblyPlans, { other: corpInventory });
  await storage.saveManifestCorpToMineData(toStorableCorpData(catalog, assemblyPlans, oreChoices, expanded, corpInventory, cargoCapacity, corpHaveOverrides));
}

// Lets the in-page Manifest overlay's Corp-view selector dropdown (see
// js/overlay-manifest.js) change which Blueprint or Build Order it's
// tracking, without opening the dashboard - mirrors
// handleSwitchManifestSelection() below exactly, just for the Corp pipeline.
async function handleSwitchManifestCorpSelection(selection) {
  if (!selection || !selection.name || (selection.type !== "build" && selection.type !== "blueprint")) return;
  await storage.saveManifestCorpSelection(selection);
  await recalculateManifestCorpSelection();
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
  // Raw ore goes straight into a dedicated Ore Hold on ships that have one -
  // see storage.js's has_ore_hold/ore_hold_capacity comment. Trips for
  // hauling everything else (Corp Store items - recalculateActiveBuildCorpData()
  // above) deliberately keep using cargo_capacity unconditionally.
  const cargoCapacity = Number((settings.has_ore_hold ? settings.ore_hold_capacity : settings.cargo_capacity) || 600);

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
// scraped from the Assembly Facility's Configure Production list by
// content.js (which only shows plans the player already knows); everything
// on that screen is Assembly-produced, so this only ever writes
// assemblyPlans, never
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
    // Listed at the Assembly Facility means it can be queued, so any
    // "not researched" mark from the R&D list is out of date.
    if (plan.research) plan.research = { ...plan.research, level: Math.max(plan.research.level, item.rdLevel ?? 1) };
    assemblyPlans[item.name] = plan;
  }
  await storage.saveAssemblyPlans(assemblyPlans);
  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
  await recalculateManifestSelection();
  await recalculateManifestCorpSelection();
}

// plans: [{name, level, skillRequired, progress, active}] scraped from the
// R&D Office's "Select Research Plan" list by content.js - every research
// plan in the game, level 0 meaning not researched yet. Plans not already
// known are added with no recipe (the R&D list doesn't show one); the
// Assembly Facility scrape fills it in once the plan unlocks. Each scrape
// refreshes every listed plan's status, so a plan researched since the last
// visit flips from locked to unlocked here. An Active row omits its skill
// line, so the last known skillRequired is kept rather than wiped.
async function handleResearchScrape(plans) {
  const assemblyPlans = await storage.loadAssemblyPlans();
  for (const scraped of plans || []) {
    if (!scraped || !scraped.name) continue;
    const plan = assemblyPlans[scraped.name] || new AssemblyPlan(scraped.name, 1);
    plan.research = {
      level: scraped.level || 0,
      skillRequired: scraped.skillRequired ?? plan.research?.skillRequired ?? null,
      progress: scraped.progress ?? null,
      active: !!scraped.active,
    };
    assemblyPlans[scraped.name] = plan;
  }
  await storage.saveAssemblyPlans(assemblyPlans);
  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
  await recalculateManifestSelection();
  await recalculateManifestCorpSelection();
}

// The Blueprints-tab key for a store name: an existing blueprint saved
// under the exact store name keeps it, otherwise the trailing " Blueprint"
// is dropped so the key reads as the item it builds ("Kinetic Autocannon").
function blueprintKeyFor(storeName, blueprints) {
  if (blueprints[storeName]) return storeName;
  return storeName.replace(/\s+Blueprint$/i, "").trim();
}

// list: [{name, owned, copies, shipClass, buildLimit}] and detail:
// {name, requirements}|null scraped from the Blueprint Store by content.js.
// Every listed blueprint gets its ownership refreshed (added if new, with
// no recipe); the one open in the detail panel gets its recipe replaced
// with the store's, which is authoritative over a hand-entered one.
async function handleBlueprintStoreScrape(list, detail, storeName) {
  const blueprints = await storage.loadBlueprints();
  for (const item of list || []) {
    if (!item || !item.name) continue;
    const key = blueprintKeyFor(item.name, blueprints);
    const blueprint = blueprints[key] || new Blueprint(key);
    // Merged so build cost/guide value from an earlier detail-panel scrape
    // survive a list-only refresh.
    blueprint.store = {
      ...(blueprint.store || {}),
      owned: !!item.owned,
      copies: item.copies || 0,
      shipClass: item.shipClass || null,
      // Starship cards don't show a build limit; keep the detail panel's.
      buildLimit: item.buildLimit ?? blueprint.store?.buildLimit ?? null,
      price: item.price ?? null,
      basePrice: item.basePrice ?? null,
      discountPct: item.discountPct || 0,
      engReq: item.engReq ?? blueprint.store?.engReq ?? null,
      storeName: storeName || blueprint.store?.storeName || null,
    };
    blueprints[key] = blueprint;
  }
  if (detail && detail.name && Object.keys(detail.requirements || {}).length > 0) {
    const key = blueprintKeyFor(detail.name, blueprints);
    const blueprint = blueprints[key] || new Blueprint(key);
    for (const name of Object.keys(blueprint.requirements)) blueprint.setRequirement(name, 0);
    for (const [name, qty] of Object.entries(detail.requirements)) blueprint.setRequirement(name, qty);
    blueprint.store = {
      ...(blueprint.store || {}),
      buildCost: detail.buildCost ?? null,
      guideValue: detail.guideValue ?? null,
      mfgSkill: detail.mfgSkill ?? null,
      shipValue: detail.shipValue ?? null,
      storeName: storeName || blueprint.store?.storeName || null,
    };
    if (detail.engReq != null) blueprint.store.engReq = detail.engReq;
    if (detail.buildLimit != null) blueprint.store.buildLimit = detail.buildLimit;
    // The Starship Blueprint Store's "Level Req" is the Captain level.
    if (detail.levelReq != null) blueprint.captainLevel = detail.levelReq;
    blueprints[key] = blueprint;
  }
  await storage.saveBlueprints(blueprints);
  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
  await recalculateManifestSelection();
  await recalculateManifestCorpSelection();
}

// manufacturing: the player's Manufacturing skill level, scraped from the
// Character Skills window by content.js; captain: their Captain level, from
// the HUD. Either may be null (Skills window closed). Only written when one
// changed, so the dashboard isn't told settings changed on every poll.
// holds: {cargo, oreHold} capacities from the HUD (oreHold null = this ship
// has no Ore Hold), or null when the HUD wasn't on screen. A ship with an
// Ore Hold mines into it, so its capacity becomes the trip size; otherwise
// cargo is. Changing ships changes every trip count, so that recalculates.
async function handleSkillsScrape(manufacturing, engineering, captain, holds) {
  const settings = await storage.loadSettings();
  let changed = false;
  if (Number.isInteger(manufacturing) && manufacturing >= 0 && settings.manufacturing_skill !== manufacturing) {
    settings.manufacturing_skill = manufacturing;
    changed = true;
  }
  if (Number.isInteger(engineering) && engineering >= 0 && settings.engineering_skill !== engineering) {
    settings.engineering_skill = engineering;
    changed = true;
  }
  if (Number.isInteger(captain) && captain > 0 && settings.captain_level !== captain) {
    settings.captain_level = captain;
    changed = true;
  }
  let holdsChanged = false;
  if (holds && Number.isInteger(holds.cargo) && holds.cargo > 0) {
    const hasOreHold = Number.isInteger(holds.oreHold) && holds.oreHold > 0;
    if (settings.cargo_capacity !== holds.cargo) {
      settings.cargo_capacity = holds.cargo;
      holdsChanged = true;
    }
    if (settings.has_ore_hold !== hasOreHold) {
      settings.has_ore_hold = hasOreHold;
      holdsChanged = true;
    }
    if (hasOreHold && settings.ore_hold_capacity !== holds.oreHold) {
      settings.ore_hold_capacity = holds.oreHold;
      holdsChanged = true;
    }
  }
  if (changed || holdsChanged) await storage.saveSettings(settings);
  if (holdsChanged) {
    await recalculateActiveBuildToMineData();
    await recalculateActiveBuildCorpData();
    await recalculateManifestSelection();
    await recalculateManifestCorpSelection();
  }
}

// items: [{name, description, resources}] scraped from the in-game Systems
// Lexicon's Manufacturing > "Planet Types & Resources" panel by content.js.
// Merges into the persisted scrapedPlanetTypes overlay (additive/refresh
// only - see storage.js's own comment on that key) and applies it to this
// module's shared `catalog` so every recalculation function immediately
// sees any newly-scraped planet type. No recalculation triggered here - a
// new/changed planet type can't retroactively change an existing build's
// requirements, and every recalculate*() function already shares this same
// `catalog` instance, so it's simply current the next time any of them run.
async function handleLexiconPlanetsScrape(planetTypes) {
  const scraped = await storage.loadScrapedPlanetTypes();
  for (const item of planetTypes || []) {
    if (!item || !item.name || !item.resources || item.resources.length === 0) continue;
    scraped[item.name] = { description: item.description || "", resources: item.resources };
  }
  await storage.saveScrapedPlanetTypes(scraped);
  await storage.savePlanetSyncStatus({ syncedAt: new Date().toISOString(), count: Object.keys(scraped).length });
  catalog.applyScrapedPlanetTypes(scraped);
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
  await recalculateManifestSelection();
  await recalculateManifestCorpSelection();
}

// Recalculates the in-page Manifest overlay's OWN plan (js/overlay-
// manifest.js), independent of the dashboard's activeBuildName/toMineData -
// see storage.js's manifestSelection/manifestToMineData/manifestOreChoices
// header comments for why this is a fully separate pipeline rather than
// reusing recalculateActiveBuildToMineData() below. Mirrors that function's
// math almost exactly (same inventory/settings/harvester inputs, same
// expandCommodities()->planMining()->toStorableToMineData() pipeline), but
// sources its requirements from whichever Blueprint or Build Order the
// overlay has selected, and its ore choices from manifestOreChoices (keyed
// per-selection) instead of the dashboard's global settings.ore_choices.
async function recalculateManifestSelection() {
  const selection = await storage.loadManifestSelection();
  if (!selection) {
    await storage.saveManifestToMineData({ available: false });
    return;
  }

  const blueprints = await storage.loadBlueprints();
  let totals;
  if (selection.type === "blueprint") {
    const blueprint = blueprints[selection.name];
    if (!blueprint) {
      await storage.saveManifestToMineData({ available: false });
      return;
    }
    // Always previewed at 1x - confirmed with the user, no quantity input
    // for a directly-picked Blueprint (unlike Build Orders, which already
    // carry their own per-entry quantities).
    totals = blueprint.scaled(1);
  } else {
    const builds = await storage.loadBuilds();
    const entries = builds[selection.name];
    if (!entries || entries.length === 0) {
      // Mirrors tab-plan.js's loadBuild(): an empty/nonexistent build must
      // still positively invalidate the previous plan, not just skip
      // recalculating over it and leave stale numbers on screen.
      await storage.saveManifestToMineData({ available: false });
      return;
    }
    totals = entriesToTotals(blueprints, entries);
  }

  const assemblyPlans = await storage.loadAssemblyPlans();
  const inventory = await storage.loadInventory(catalog);
  const settings = await storage.loadSettings();
  const maxHarvesters = Number(settings.max_harvesters || 4);
  const harvesterSlots = await storage.loadHarvesterSlots(maxHarvesters);
  // See recalculateActiveBuildToMineData()'s identical comment above - same
  // Ore Hold override, same reasoning.
  const cargoCapacity = Number((settings.has_ore_hold ? settings.ore_hold_capacity : settings.cargo_capacity) || 600);

  const { expanded, assemblyHours } = expandCommodities(catalog, totals, assemblyPlans, inventory, 20, settings.item_acquisition_mode);

  const selectionKey = storage.manifestSelectionKey(selection);

  const manifestOreChoices = await storage.loadManifestOreChoices();
  const perSelectionChoices = manifestOreChoices[selectionKey] || {};
  const oreChoices = {};
  for (const [item, oreName] of Object.entries(perSelectionChoices)) {
    const ore = catalog.findOre(oreName);
    if (ore) oreChoices[item] = ore;
  }
  // Anything not in perSelectionChoices is simply left out of oreChoices -
  // planMining() already defaults to material.sources[0] on its own, so a
  // freshly-picked Blueprint/Build works with a sensible default before the
  // user ever touches an ore selector.

  // Pending-refining batches are ALSO scoped per-selection here (see
  // storage.js's manifestPendingBatches comment) - deliberately NOT the
  // dashboard's global `pendingRefining` key. A batch started while working
  // Blueprint A shouldn't silently credit Blueprint B's "how many more
  // batches do I need" math just because they share an ore; the raw ore
  // itself is still deducted from the one real shared inventory when the
  // batch is entered (see handleSetManifestPendingBatches()), only the
  // credit toward remaining need is scoped this way.
  const manifestPendingBatches = await storage.loadManifestPendingBatches();
  const pendingBatchesForSelection = manifestPendingBatches[selectionKey] || {};

  const result = planMining(catalog, expanded, inventory, oreChoices, cargoCapacity, harvesterTotals(harvesterSlots), pendingBatchesForSelection, assemblyHours);
  const stored = toStorableToMineData(result, cargoCapacity);
  // Every entry in `stored.assembly` is, by construction, a "Farm" item -
  // expandCommodities() only cascades a commodity into assemblyHours (which
  // is what populates this array) when it ISN'T buy-moded, and a "Buy" item
  // lands in `stored.buy` instead. So the Refined-section-style ore/items
  // breakdown the overlay's Assembly rows show only makes sense here, per
  // item, using the SAME itemResourceBreakdown() the dashboard's Plan a
  // Build tab already uses for its "Item sources" sub-item lines - not a
  // new calculation, just surfaced into a new place.
  for (const item of stored.assembly) {
    item.breakdown = itemResourceBreakdown(catalog, item.name, item.need, assemblyPlans, settings.item_acquisition_mode);
  }
  // stored.buy mixes two different reasons an item ended up here (see
  // toStorableToMineData()'s own comment on that array): deliberately
  // buy-moded, OR no known Assembly Plan exists for it at all. Only the
  // former can meaningfully switch back to "Farm" - flagging which is which
  // here so the overlay only offers that toggle where it would actually do
  // something, rather than a Farm option that silently no-ops because
  // there's nothing to cascade.
  // A plan known only from the R&D list has no recipe yet, so "Farm" has
  // nothing to cascade into either - it counts as no plan here, with the
  // reason passed along for the row to show.
  for (const item of stored.buy) {
    const plan = assemblyPlans[item.name];
    item.has_plan = Boolean(plan && plan.hasRecipe());
    item.no_recipe_reason = plan && !plan.hasRecipe() ? noRecipeReason(plan) : null;
  }
  await storage.saveManifestToMineData(stored);
}

// Why a recipe-less plan can't be farmed yet: the Research Skill level the
// R&D list says it needs ("Research 11 required"), or a generic reason when
// that wasn't shown.
function noRecipeReason(plan) {
  if (!plan.isResearchLocked()) return "no recipe yet";
  const level = plan.research?.skillRequired;
  return level != null ? `Research ${level} required` : "not researched";
}

// Lets the overlay's Assembly/Buy rows toggle an item between "Farm"
// (cascade it through Assembly into its own ore/material ingredients, same
// as the dashboard's "Mine" mode) and "Buy" (leave it as a flat quantity to
// go acquire directly) - the exact same GLOBAL settings.item_acquisition_mode
// map the dashboard's Plan a Build tab's "Item sources" Mine/Buy select
// already reads/writes (see tab-plan.js's buildRequirements()), just
// surfaced as a control here too. Global, not per-selection, unlike
// manifestOreChoices - the user only asked for ore choices to be scoped per
// Blueprint/Build Order, not buy/farm mode, and reusing the existing global
// setting means a choice made here is already exactly what the dashboard
// would show too, with no new storage needed. Recalculates BOTH the
// dashboard's own toMineData and this overlay's manifestToMineData since
// both already read this same global setting (Corp's pipeline doesn't - see
// recalculateActiveBuildCorpData()'s expandCommodities() call, which omits
// buyModes entirely - so it's deliberately not recalculated here).
async function handleSetItemAcquisitionMode(itemName, mode) {
  if (!itemName || (mode !== "buy" && mode !== "mine")) return;
  const settings = await storage.loadSettings();
  settings.item_acquisition_mode = settings.item_acquisition_mode || {};
  if (mode === "buy") settings.item_acquisition_mode[itemName] = "buy";
  else delete settings.item_acquisition_mode[itemName];
  await storage.saveSettings(settings);
  await recalculateActiveBuildToMineData();
  await recalculateManifestSelection();
}

// Lets the in-page Manifest overlay's selector dropdown (see js/overlay-
// manifest.js) change which Blueprint or Build Order it's showing, without
// opening the dashboard.
async function handleSwitchManifestSelection(selection) {
  if (!selection || !selection.name || (selection.type !== "build" && selection.type !== "blueprint")) return;
  await storage.saveManifestSelection(selection);
  await recalculateManifestSelection();
}

// Lets the overlay's Refined-section ore `<select>` (added per-material,
// per-selection - see storage.js's manifestOreChoices comment) record a
// choice and immediately see raw-ore/trip numbers recompute.
async function handleSetManifestOreChoice(materialName, oreName) {
  const selection = await storage.loadManifestSelection();
  if (!selection || !materialName || !oreName) return;
  const ore = catalog.findOre(oreName);
  if (!ore) return;
  const manifestOreChoices = await storage.loadManifestOreChoices();
  const key = storage.manifestSelectionKey(selection);
  manifestOreChoices[key] = manifestOreChoices[key] || {};
  manifestOreChoices[key][materialName] = oreName;
  await storage.saveManifestOreChoices(manifestOreChoices);
  await recalculateManifestSelection();
}

// Lets the in-page Manifest overlay's own Batch control (js/overlay-
// manifest.js) set exactly how many batches of an ore are currently
// started, scoped to whichever Blueprint/Build the overlay has selected -
// see storage.js's manifestPendingBatches comment for why this is
// deliberately separate from handleSetPendingBatches() above (the
// dashboard's global, shared pendingRefining). Same absolute-SET semantics
// and the same optimistic raw-ore deduction as that function (the ore is
// genuinely spent from the one real shared inventory regardless of which
// selection's ledger is tracking it) - only the "credit toward remaining
// need" ends up scoped per-selection, via recalculateManifestSelection()
// reading manifestPendingBatches instead of pendingRefining.
async function handleSetManifestPendingBatches(oreName, newBatches) {
  const selection = await storage.loadManifestSelection();
  const ore = catalog.findOre(oreName);
  if (!selection || !ore || Number.isNaN(newBatches) || newBatches < 0) return;

  const manifestPendingBatches = await storage.loadManifestPendingBatches();
  const key = storage.manifestSelectionKey(selection);
  const forSelection = { ...(manifestPendingBatches[key] || {}) };
  const oldBatches = forSelection[oreName] || 0;
  if (newBatches === oldBatches) return;

  if (newBatches > oldBatches) {
    // Same one-directional optimistic deduction as handleSetPendingBatches()
    // - never reversed on a decrease, since a real sync is what actually
    // confirms the ore is genuinely spent going forward.
    const inventory = await storage.loadInventory(catalog);
    const rawDelta = (newBatches - oldBatches) * ore.batch;
    const current = inventory.rawOre.get(ore) || 0;
    inventory.rawOre.set(ore, Math.max(0, current - rawDelta));
    await storage.saveInventory(inventory);
  }

  if (newBatches <= 0) delete forSelection[oreName];
  else forSelection[oreName] = newBatches;
  if (Object.keys(forSelection).length > 0) manifestPendingBatches[key] = forSelection;
  else delete manifestPendingBatches[key];
  await storage.saveManifestPendingBatches(manifestPendingBatches);

  // Inventory changed, so every pipeline that reads it needs a refresh - not
  // just this overlay's own selection.
  await recalculateActiveBuildToMineData();
  await recalculateActiveBuildCorpData();
  await recalculateManifestSelection();
  await recalculateManifestCorpSelection();
}

// Lets the in-page Manifest overlay's "Mark Complete" button (js/overlay-
// manifest.js) declare the currently-selected Blueprint/Build Order done:
// clears its own per-selection batch counts and ore-source picks (see
// storage.js's manifestPendingBatches/manifestOreChoices), then deselects so
// the overlay falls back to its empty state instead of showing numbers for a
// selection whose tracking data was just wiped. Deliberately never touches
// the underlying Blueprint or Build Order itself - unlike the dashboard's
// own "Mark Build Complete" (tab-plan.js), which deletes the build, this is
// scoped entirely to the overlay's own tracking data, never the saved plan.
// Never reverses any raw-ore inventory deduction already applied by past
// batch entries, matching handleSetManifestPendingBatches()'s one-directional
// policy above.
async function handleMarkManifestSelectionComplete() {
  const selection = await storage.loadManifestSelection();
  if (!selection) return;
  const key = storage.manifestSelectionKey(selection);

  const manifestPendingBatches = await storage.loadManifestPendingBatches();
  if (key in manifestPendingBatches) {
    delete manifestPendingBatches[key];
    await storage.saveManifestPendingBatches(manifestPendingBatches);
  }

  const manifestOreChoices = await storage.loadManifestOreChoices();
  if (key in manifestOreChoices) {
    delete manifestOreChoices[key];
    await storage.saveManifestOreChoices(manifestOreChoices);
  }

  await storage.saveManifestSelection(null);
  await recalculateManifestSelection();
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
  if (msg.type === "fsc-storage-scrape") handled = handleStorageScrape(msg.items, msg.complete === true);
  else if (msg.type === "fsc-corp-store-scrape") handled = handleCorpStoreScrape(msg.items);
  else if (msg.type === "fsc-assembler-scrape") handled = handleAssemblerScrape(msg.items);
  else if (msg.type === "fsc-research-scrape") handled = handleResearchScrape(msg.plans);
  else if (msg.type === "fsc-blueprint-store-scrape") handled = handleBlueprintStoreScrape(msg.list, msg.detail, msg.storeName);
  else if (msg.type === "fsc-skills-scrape") handled = handleSkillsScrape(msg.manufacturing, msg.engineering, msg.captain, msg.holds);
  else if (msg.type === "fsc-lexicon-planets-scrape") handled = handleLexiconPlanetsScrape(msg.planetTypes);
  else if (msg.type === "fsc-set-pending-batches") handled = handleSetPendingBatches(msg.oreName, msg.batches);
  else if (msg.type === "fsc-switch-manifest-selection") handled = handleSwitchManifestSelection(msg.selection);
  else if (msg.type === "fsc-set-manifest-ore-choice") handled = handleSetManifestOreChoice(msg.materialName, msg.oreName);
  else if (msg.type === "fsc-set-manifest-pending-batches") handled = handleSetManifestPendingBatches(msg.oreName, msg.batches);
  else if (msg.type === "fsc-mark-manifest-selection-complete") handled = handleMarkManifestSelectionComplete();
  else if (msg.type === "fsc-set-item-acquisition-mode") handled = handleSetItemAcquisitionMode(msg.itemName, msg.mode);
  else if (msg.type === "fsc-switch-manifest-corp-selection") handled = handleSwitchManifestCorpSelection(msg.selection);
  else if (msg.type === "fsc-refresh-manifest-corp-selection") handled = recalculateManifestCorpSelection();
  // Manual refresh button (js/overlay-manifest.js) - recalculateManifestSelection()
  // only otherwise runs off the 3 scrape/pending-batch triggers above plus
  // this overlay's own selection/ore-choice/mode changes, so anything
  // changed purely on the DASHBOARD side (cargo capacity, inventory edited
  // by hand, a Blueprint/Build Order's contents, assemblyPlans edited
  // outside the Assembler Plans scraper) has no other path to reach the
  // overlay's cached manifestToMineData - there's no browser.storage.onChanged
  // listener here reacting to those keys generally. This is the deliberate,
  // narrow fix: a manual re-run using whatever's currently in storage, not a
  // new blanket auto-refresh listener.
  else if (msg.type === "fsc-refresh-manifest-selection") handled = recalculateManifestSelection();
  else if (msg.type === "fsc-open-dashboard") handled = handleOpenDashboard();
  else return undefined;
  // sendResponse() itself can throw if the sender's port is already gone
  // (e.g. the game tab got closed in the moment between sending this and
  // the handler finishing) - wrapped so that edge case is just silently
  // ignored rather than becoming an unhandled rejection, same as the
  // senders' own `.catch(() => {})` already treats a failed send.
  const respond = () => { try { sendResponse(); } catch { /* sender gone, nothing to respond to */ } };
  // A handler failing used to be swallowed here with no trace - the page
  // then counted the scrape as delivered and never resent it, so the
  // Manifest silently went stale. Logged now (background console).
  handled.then(respond).catch((err) => {
    console.error(`Forged Space Shipping Manifest: "${msg.type}" failed.`, err);
    respond();
  });
  return true;
});
