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
  // Some ships have a dedicated Ore Hold, separate from general cargo space
  // - raw ore mined goes straight into that instead of the normal cargo
  // hold. When true, mining/refining trip counts (planMining()/
  // toStorableToMineData() in calc-engine.js) are computed against
  // ore_hold_capacity instead of cargo_capacity - everything else (Assembly
  // items, Corp Store hauling trips) keeps using cargo_capacity exactly as
  // before, since only raw ore actually goes into the Ore Hold.
  has_ore_hold: false,
  ore_hold_capacity: 600,
  // The player's Manufacturing Skill, read from the Character Skills window - flags
  // blueprints that need more than this (store.mfgSkill). null = not set.
  manufacturing_skill: null,
  // The player's Captain level, read from the game's HUD - flags blueprints
  // whose captainLevel is above it. null = not seen yet.
  captain_level: null,
  // The player's Engineering skill, read from the Character Skills window -
  // compared with a module blueprint's store.engReq (needed to fit it).
  engineering_skill: null,
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
  scrapedPlanetTypes: "scrapedPlanetTypes",
  planetSyncMeta: "planetSyncMeta",
  activeBuildName: "activeBuildName",
  corpInventory: "corpInventory",
  corpToMineData: "corpToMineData",
  activeCorpBuildName: "activeCorpBuildName",
  corpHaveOverrides: "corpHaveOverrides",
  manifestSelection: "manifestSelection",
  manifestToMineData: "manifestToMineData",
  manifestOreChoices: "manifestOreChoices",
  manifestCorpSelection: "manifestCorpSelection",
  manifestCorpToMineData: "manifestCorpToMineData",
  manifestPendingBatches: "manifestPendingBatches",
  buildLabels: "buildLabels",
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
    blueprint.store = (entry && entry.requirements && entry.store) || null;
    blueprints[name] = blueprint;
  }
  return blueprints;
}

export async function saveBlueprints(blueprints) {
  const raw = {};
  for (const [name, blueprint] of Object.entries(blueprints)) {
    raw[name] = { requirements: { ...blueprint.requirements }, captain_level: blueprint.captainLevel ?? null, store: blueprint.store ?? null };
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
    plan.research = entry.research ?? null;
    assemblyPlans[outputItem] = plan;
  }
  return assemblyPlans;
}

export async function saveAssemblyPlans(assemblyPlans) {
  const raw = {};
  for (const [outputItem, plan] of Object.entries(assemblyPlans)) {
    raw[outputItem] = { rate_per_hour: plan.ratePerHour, requirements: { ...plan.requirements }, captain_level: plan.captainLevel ?? null, research: plan.research ?? null };
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

// { [planetTypeName]: { description, resources: [resourceName, ...] } } -
// scraped from the in-game Systems Lexicon's Manufacturing > "Planet Types &
// Resources" panel (see content.js's checkLexiconPlanets()), applied on top
// of the static PLANET_TYPES baseline (js/planets-data.js) via
// Catalog.applyScrapedPlanetTypes() rather than replacing it - see that
// method's comment for why. Additive/merge-only: background.js's
// handleLexiconPlanetsScrape() only ever adds or refreshes entries here,
// never removes one that a later scrape happens not to include.
export async function loadScrapedPlanetTypes() {
  return getKey(KEYS.scrapedPlanetTypes, {});
}

export async function saveScrapedPlanetTypes(scraped) {
  await setKey(KEYS.scrapedPlanetTypes, scraped);
}

// { syncedAt: ISOString, count: number } - same purpose as
// inventorySyncMeta above, but for the Planets tab's own sync-status line.
// Unlike inventory, this sync is player-initiated (opening the Lexicon
// panel in-game is a deliberate, rare action, not something that happens
// during normal play) - the Planets tab's hint text tells the player how to
// trigger it.
export async function loadPlanetSyncStatus() {
  return getKey(KEYS.planetSyncMeta, null);
}

export async function savePlanetSyncStatus(meta) {
  await setKey(KEYS.planetSyncMeta, meta);
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

// Which Blueprint or Build Order the in-page Manifest overlay's own
// dropdown (js/overlay-manifest.js) currently has selected -
// `{ type: "build"|"blueprint", name: string } | null`. Deliberately
// separate from `activeBuildName` above (the dashboard's Plan a Build tab
// selection) - the overlay needs to be able to point at a bare Blueprint,
// which has no equivalent concept in the dashboard's build-tracking model,
// and keeping the two fully independent avoids the dashboard's own headless
// recalculation (which only ever knows about saved Builds) silently
// clobbering an overlay Blueprint preview on the next inventory sync.
export async function loadManifestSelection() {
  return getKey(KEYS.manifestSelection, null);
}

export async function saveManifestSelection(selection) {
  await setKey(KEYS.manifestSelection, selection);
}

// The Manifest overlay's own computed plan, in the same shape
// toStorableToMineData() produces - kept in a key separate from `toMineData`
// (the dashboard's) for the same reason as manifestSelection above. Consumed
// by js/overlay-manifest.js's render(), same as `toMineData` used to be.
export async function loadManifestToMineData() {
  return getKey(KEYS.manifestToMineData, { available: false });
}

export async function saveManifestToMineData(data) {
  await setKey(KEYS.manifestToMineData, data);
}

// { "<type>:<name>": { materialName: oreName } } - per-selection source-ore
// preferences for the Manifest overlay's Refined section, keyed by
// manifestSelectionKey() below. Deliberately per-Blueprint/per-Build-Order
// rather than global (unlike settings.ore_choices, which the dashboard's
// Plan a Build tab uses) - the user wants e.g. Build 1 and Build 2 to be
// able to prefer different source ores for the same shared material without
// fighting over one global setting.
export async function loadManifestOreChoices() {
  return getKey(KEYS.manifestOreChoices, {});
}

export async function saveManifestOreChoices(choices) {
  await setKey(KEYS.manifestOreChoices, choices);
}

// Shared by background.js and overlay-manifest.js so the two never drift on
// how a selection maps to a manifestOreChoices key.
export function manifestSelectionKey(selection) {
  return selection ? `${selection.type}:${selection.name}` : null;
}

// Corp-view counterparts to manifestSelection/manifestToMineData above - the
// Manifest overlay's OWN Blueprint/Build Order pick for its Corp view,
// independent of the dashboard's Corp tab (`activeCorpBuildName`/
// `corpToMineData`) for the exact same reason the personal ones are
// independent of activeBuildName/toMineData - see manifestSelection's own
// comment. No corp equivalent of manifestOreChoices - the Corp view's
// Refined section has no per-material ore picker (always editable:false,
// see js/overlay-manifest.js's renderRefinedRow()), so it keeps using the
// same global settings.ore_choices the dashboard's Corp tab already does -
// not something this feature changes.
export async function loadManifestCorpSelection() {
  return getKey(KEYS.manifestCorpSelection, null);
}

export async function saveManifestCorpSelection(selection) {
  await setKey(KEYS.manifestCorpSelection, selection);
}

export async function loadManifestCorpToMineData() {
  return getKey(KEYS.manifestCorpToMineData, { available: false, items: [], refined: [] });
}

export async function saveManifestCorpToMineData(data) {
  await setKey(KEYS.manifestCorpToMineData, data);
}

// { "<type>:<name>": { oreName: batchCount } } - per-selection pending-
// refining batch counts for the Manifest overlay's Batch controls, keyed by
// manifestSelectionKey() exactly like manifestOreChoices above. Deliberately
// separate from the global `pendingRefining` key the dashboard's Inventory/
// Plan a Build tabs use - a real batch already started for Blueprint A
// shouldn't silently credit Blueprint B's own "how many more batches do I
// need" math just because they happen to share an ore, which is what a
// single global counter caused (2026-08-29 - user confirmed this was
// actively misleading them). The raw-ore quantity ITSELF is still deducted
// from the one real shared inventory when a batch count is entered here
// (see background.js's handleSetManifestPendingBatches()) - only the
// "credit toward remaining need" is scoped per-selection, since the ore is
// genuinely spent regardless of which selection's ledger is tracking it.
export async function loadManifestPendingBatches() {
  return getKey(KEYS.manifestPendingBatches, {});
}

export async function saveManifestPendingBatches(batches) {
  await setKey(KEYS.manifestPendingBatches, batches);
}

// { buildId: customLabel } - an optional player-chosen display name for a
// saved Build Order, set via tab-plan.js's "Rename Build..." button. The
// underlying build is still stored/keyed/sorted by its auto-assigned integer
// string id (see tab-plan.js's nextBuildNumber()) everywhere else
// (app.builds, activeBuildName, manifestSelection, etc.) - this is purely a
// cosmetic overlay so a build id absent from this map just displays as
// "Build <id>" exactly as before. Kept as its own tiny side-table rather
// than changing what a build's storage key IS, so nothing that already
// depends on build ids being small reused integers (nextBuildNumber's
// lowest-unused-gap reuse, numeric sort order in tab-plan.js/tab-corp.js/
// overlay-manifest.js) has to change.
export async function loadBuildLabels() {
  return getKey(KEYS.buildLabels, {});
}

export async function saveBuildLabels(labels) {
  await setKey(KEYS.buildLabels, labels);
}
