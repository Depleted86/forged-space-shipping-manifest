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
// (app.last_plan_result); here it must be persisted since the toolbar
// popup (popup.js) reads it independently of whichever context computed it.

import { Recipe, AssemblyRecipe, Inventory } from "./calc-engine.js";

export const DEFAULT_SETTINGS = {
  cargo_capacity: 600,
  ore_choices: {},
  max_harvesters: 4,
};

const KEYS = {
  recipes: "recipes",
  inventory: "inventory",
  settings: "settings",
  harvesters: "harvesters",
  pendingRefining: "pendingRefining",
  assemblyRecipes: "assemblyRecipes",
  builds: "builds",
  toMineData: "toMineData",
  inventorySyncMeta: "inventorySyncMeta",
};

async function getKey(key, fallback) {
  const result = await browser.storage.local.get(key);
  return key in result ? result[key] : fallback;
}

async function setKey(key, value) {
  await browser.storage.local.set({ [key]: value });
}

export async function loadRecipes() {
  const raw = await getKey(KEYS.recipes, {});
  const recipes = {};
  for (const [name, reqs] of Object.entries(raw)) {
    const recipe = new Recipe(name);
    for (const [itemName, qty] of Object.entries(reqs)) recipe.setRequirement(itemName, qty);
    recipes[name] = recipe;
  }
  return recipes;
}

export async function saveRecipes(recipes) {
  const raw = {};
  for (const [name, recipe] of Object.entries(recipes)) raw[name] = { ...recipe.requirements };
  await setKey(KEYS.recipes, raw);
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

// { commodityName: AssemblyRecipe } - how each Commodity is produced at the
// Assembly.
export async function loadAssemblyRecipes() {
  const raw = await getKey(KEYS.assemblyRecipes, {});
  const assemblyRecipes = {};
  for (const [outputItem, entry] of Object.entries(raw)) {
    const recipe = new AssemblyRecipe(outputItem, entry.rate_per_hour ?? 1);
    for (const [itemName, qty] of Object.entries(entry.requirements || {})) recipe.setRequirement(itemName, qty);
    assemblyRecipes[outputItem] = recipe;
  }
  return assemblyRecipes;
}

export async function saveAssemblyRecipes(assemblyRecipes) {
  const raw = {};
  for (const [outputItem, recipe] of Object.entries(assemblyRecipes)) {
    raw[outputItem] = { rate_per_hour: recipe.ratePerHour, requirements: { ...recipe.requirements } };
  }
  await setKey(KEYS.assemblyRecipes, raw);
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
// tab-plan.js's toStorableToMineData()). Consumed by the toolbar popup
// (popup.js).
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
