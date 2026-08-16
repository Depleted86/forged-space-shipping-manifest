// browser.storage.local persistence - JS port of storage.py, one storage key
// per JSON file the Python app used. Objects reference each other by name in
// storage; loading re-resolves those names back into the shared Ore/Material
// objects from a Catalog, exactly like the Python original.
//
// Two settings from storage.py's DEFAULT_SETTINGS have no analog here and
// are deliberately dropped: `downloads_dir` (no filesystem access from an
// extension) and `auto_refresh_enabled`/`refresh_interval_seconds` (those
// governed the CSV-polling schedule; the extension's inventory sync is
// event-driven off the game's own DOM via content.js's fixed, already
// performance-tuned poll, not a user-configurable schedule).
//
// One new key with no Python analog: `toMineData`, holding the last computed
// plan result. In Python this only ever lived in-memory
// (app.last_plan_result); here it must be persisted since the in-page
// Manifest overlay (js/overlay-manifest.js) reads it independently of
// whichever context computed it.

import { Blueprint, AssemblyPlan, Inventory } from "./calc-engine.js";

export const DEFAULT_SETTINGS = {
  cargo_capacity: 600,
  ore_choices: {},
  max_harvesters: 4,
  // { itemName: "buy" } - per-item override for Assembly-produced
  // Commodities, set from the Plan a Build tab's "Item sources" list. Any
  // name absent from this map defaults to "mine" (existing behavior:
  // cascades down into its own raw/refined ingredient needs via
  // expandCommodities()). "buy" skips that cascade for just that one item -
  // it shows up as a flat "buy N of this" quantity instead, for players who
  // choose to acquire that specific part directly (market/corp/trade)
  // rather than personally assemble it - while everything else still mines/
  // assembles normally.
  item_acquisition_mode: {},
};

const KEYS = {
  blueprints: "blueprints",
  inventory: "inventory",
  settings: "settings",
  harvesters: "harvesters",
  pendingRefining: "pendingRefining",
  assemblyPlans: "assemblyPlans",
  builds: "builds",
  toMineData: "toMineData",
  inventorySyncMeta: "inventorySyncMeta",
  activeBuildName: "activeBuildName",
  corpInventory: "corpInventory",
  corpToMineData: "corpToMineData",
  activeCorpBuildName: "activeCorpBuildName",
  corpHaveOverrides: "corpHaveOverrides",
};

// Pre-2026-08-15 key names, from before Recipe/AssemblyRecipe were renamed
// to Blueprint/AssemblyPlan (to match the game's own terminology). Read as a
// one-time fallback in loadBlueprints()/loadAssemblyPlans() below so nobody
// upgrading from an older version loses what they'd already saved - never
// written to again once migrated forward onto the new key.
const LEGACY_KEYS = {
  blueprints: "recipes",
  assemblyPlans: "assemblyRecipes",
};

async function getKey(key, fallback) {
  const result = await browser.storage.local.get(key);
  return key in result ? result[key] : fallback;
}

async function setKey(key, value) {
  await browser.storage.local.set({ [key]: value });
}

// Storage shape changed from a bare { itemName: qty } requirements dict per
// blueprint to a wrapper { requirements: {...}, captain_level } once
// blueprints gained a captainLevel stat - `entry.requirements` (truthy only
// on the new shape, since no real item is ever literally named
// "requirements") tells the two apart, so blueprints saved before that
// change still load correctly.
export async function loadBlueprints() {
  let raw = await getKey(KEYS.blueprints, null);
  if (raw === null) {
    // First load since the rename (see LEGACY_KEYS above) - fall back to
    // whatever was saved under the old "recipes" key, then persist it
    // forward under the new key so this only ever runs once.
    raw = await getKey(LEGACY_KEYS.blueprints, {});
    if (Object.keys(raw).length > 0) await setKey(KEYS.blueprints, raw);
  }
  const blueprints = {};
  for (const [name, entry] of Object.entries(raw)) {
    const blueprint = new Blueprint(name);
    const reqs = entry && entry.requirements ? entry.requirements : entry;
    for (const [itemName, qty] of Object.entries(reqs || {})) blueprint.setRequirement(itemName, qty);
    blueprint.captainLevel = entry && entry.captain_level != null ? entry.captain_level : null;
    blueprints[name] = blueprint;
  }
  return blueprints;
}

export async function saveBlueprints(blueprints) {
  const raw = {};
  for (const [name, blueprint] of Object.entries(blueprints)) {
    raw[name] = { requirements: { ...blueprint.requirements }, captain_level: blueprint.captainLevel ?? null };
  }
  await setKey(KEYS.blueprints, raw);
}

export async function loadInventory(catalog) {
  const inv = new Inventory();
  const raw = await getKey(KEYS.inventory, null);
  if (!raw) return inv;
  for (const [oreName, qty] of Object.entries(raw.raw_ore || {})) {
    const ore = catalog.findOre(oreName);
    if (ore) inv.rawOre.set(ore, qty);
  }
  for (const [matName, qty] of Object.entries(raw.refined || {})) {
    const material = catalog.findMaterial(matName);
    if (material) inv.refined.set(material, qty);
  }
  inv.other = { ...(raw.other || {}) };
  return inv;
}

export async function saveInventory(inventory) {
  const raw = {
    raw_ore: Object.fromEntries([...inventory.rawOre.entries()].map(([ore, qty]) => [ore.name, qty])),
    refined: Object.fromEntries([...inventory.refined.entries()].map(([mat, qty]) => [mat.name, qty])),
    other: { ...inventory.other },
  };
  await setKey(KEYS.inventory, raw);
}

// A fixed list of `maxSlots` harvester slots: [{resource: string|null, rate: number}, ...].
export async function loadHarvesterSlots(maxSlots) {
  let slots = await getKey(KEYS.harvesters, []);
  while (slots.length < maxSlots) slots.push({ resource: null, rate: 0 });
  return slots.slice(0, maxSlots);
}

export async function saveHarvesterSlots(slots) {
  await setKey(KEYS.harvesters, slots);
}

// { oreName: number } - batches of that ore currently being refined (raw
// ore already committed, output not yet reflected in inventory).
export async function loadPendingRefining() {
  return getKey(KEYS.pendingRefining, {});
}

export async function savePendingRefining(pending) {
  await setKey(KEYS.pendingRefining, pending);
}

// { commodityName: AssemblyPlan } - how each Commodity is produced at the
// Assembly.
export async function loadAssemblyPlans() {
  let raw = await getKey(KEYS.assemblyPlans, null);
  if (raw === null) {
    // Same one-time fallback as loadBlueprints() above, for the old
    // "assemblyRecipes" key.
    raw = await getKey(LEGACY_KEYS.assemblyPlans, {});
    if (Object.keys(raw).length > 0) await setKey(KEYS.assemblyPlans, raw);
  }
  const assemblyPlans = {};
  for (const [outputItem, entry] of Object.entries(raw)) {
    const plan = new AssemblyPlan(outputItem, entry.rate_per_hour ?? 1);
    for (const [itemName, qty] of Object.entries(entry.requirements || {})) plan.setRequirement(itemName, qty);
    plan.captainLevel = entry.captain_level != null ? entry.captain_level : null;
    assemblyPlans[outputItem] = plan;
  }
  return assemblyPlans;
}

export async function saveAssemblyPlans(assemblyPlans) {
  const raw = {};
  for (const [outputItem, plan] of Object.entries(assemblyPlans)) {
    raw[outputItem] = { rate_per_hour: plan.ratePerHour, requirements: { ...plan.requirements }, captain_level: plan.captainLevel ?? null };
  }
  await setKey(KEYS.assemblyPlans, raw);
}

// { buildName: [[kind, itemName, qty], ...] } - saved "Plan a Build" entry
// lists, so multiple builds can be tracked and switched between
// independently.
export async function loadBuilds() {
  return getKey(KEYS.builds, {});
}

export async function saveBuilds(builds) {
  await setKey(KEYS.builds, builds);
}

export async function loadSettings() {
  const raw = await getKey(KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...raw };
}

export async function saveSettings(settings) {
  await setKey(KEYS.settings, settings);
}

// The last computed plan result, in the same shape planMining() returns
// (with Ore/Material Map keys flattened to name strings for storage - see
// tab-plan.js's toStorableToMineData()). Consumed by the in-page Manifest
// overlay (js/overlay-manifest.js).
export async function loadToMineData() {
  return getKey(KEYS.toMineData, { available: false });
}

export async function saveToMineData(data) {
  await setKey(KEYS.toMineData, data);
}

// { syncedAt: ISOString, matched: number, unmatched: number } - written by
// background.js whenever it applies a scraped storage snapshot, so the
// Inventory tab can show a "last synced" status line the way gui.py's
// sync_status_var did (there's no manual-refresh button here - the extension
// has no CSV fallback path to trigger, sync is fully automatic).
export async function loadInventorySyncStatus() {
  return getKey(KEYS.inventorySyncMeta, null);
}

export async function saveInventorySyncStatus(meta) {
  await setKey(KEYS.inventorySyncMeta, meta);
}

// Which build (by name, matching a key in `builds`) the Plan a Build tab
// currently has selected, or null for "(unsaved plan)". Persisted (rather
// than kept only in the dashboard's in-memory `app.activeBuildName`) so
// background.js can recompute that build's plan headlessly after a live
// inventory sync, even when the dashboard page isn't open to notice the
// change itself - see recalculateActiveBuildToMineData() in background.js.
export async function loadActiveBuildName() {
  return getKey(KEYS.activeBuildName, null);
}

export async function saveActiveBuildName(name) {
  await setKey(KEYS.activeBuildName, name);
}

// { itemName: quantity } scraped from the corporation's Store screen
// (Offices > Store > Corp Store panel). Deliberately a plain name->qty dict,
// not a classified Inventory like personal storage - corp-store comparisons
// are a flat need-vs-have per named item (see toStorableCorpData()), not run
// through the ore/refining mining pipeline the way personal stock is.
export async function loadCorpInventory() {
  return getKey(KEYS.corpInventory, {});
}

export async function saveCorpInventory(corpInventory) {
  await setKey(KEYS.corpInventory, corpInventory);
}

// The last computed corp-store need/have comparison for the active build, in
// the shape toStorableCorpData() returns. Consumed by the in-page Manifest
// overlay's Corp view (js/overlay-manifest.js).
export async function loadCorpToMineData() {
  return getKey(KEYS.corpToMineData, { available: false, items: [] });
}

export async function saveCorpToMineData(data) {
  await setKey(KEYS.corpToMineData, data);
}

// Which build (by name, matching a key in `builds`) is being tracked
// against the Corp Store, on the Corp tab. Deliberately separate from
// activeBuildName - a corp project (e.g. an Outpost buildout) is usually a
// different thing entirely from whichever build a player has personally
// selected in Plan a Build, so the two selections shouldn't be forced to
// track each other.
export async function loadActiveCorpBuildName() {
  return getKey(KEYS.activeCorpBuildName, null);
}

// { itemName: qty } - a SHARED (not personal) manually-reported "known
// total have," set inline in the Corp tab's main comparison table and
// distributed to other players via Export/Import CSV (see
// toStorableCorpData()'s `haveOverrides` param in calc-engine.js). Exists
// for a corp-mate with visibility a live scrape can't provide - e.g.
// someone holding a large stash on a "bank alt" they swept deposits into -
// to report the real total so everyone else's shortfall reflects it, not
// just whatever their own limited Corp Store view happens to show. When
// set for an item, this takes precedence over the live corpInventory
// balance for that item entirely (it's presumed more authoritative, coming
// from someone who actually checked); items absent from this dict fall
// back to that live balance exactly as before.
export async function loadCorpHaveOverrides() {
  return getKey(KEYS.corpHaveOverrides, {});
}

export async function saveCorpHaveOverrides(haveOverrides) {
  await setKey(KEYS.corpHaveOverrides, haveOverrides);
}

export async function saveActiveCorpBuildName(name) {
  await setKey(KEYS.activeCorpBuildName, name);
}
