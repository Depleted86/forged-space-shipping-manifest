// Planning engine - JS port of models.py's Recipe/AssemblyRecipe/Inventory/
// PlanResult classes and its expand_commodities/find_consolidation_opportunities/
// harvester_totals/pending_refining_output/plan_mining functions.
//
// Preserves exact semantics of the Python original, verified against
// golden-master fixtures captured from the live Python app (see test/).

// An item/build with requirements, keyed by plain item name.
//
// An item name can be a refined material (e.g. "Iron Ore"), a raw ore
// consumed directly/unrefined (e.g. "Thracium"), or a resource outside the
// ore catalog entirely (e.g. an uncatalogued planetary resource) - the
// planner classifies each name at plan time via Catalog.classify().
export class Recipe {
  constructor(name) {
    this.name = name;
    this.requirements = {}; // { itemName: qtyPerUnit }
  }

  setRequirement(itemName, qty) {
    if (qty <= 0) {
      delete this.requirements[itemName];
    } else {
      this.requirements[itemName] = qty;
    }
  }

  scaled(multiplier) {
    const out = {};
    for (const [name, qty] of Object.entries(this.requirements)) {
      out[name] = qty * multiplier;
    }
    return out;
  }
}

// How a Commodity is produced at the Assembly. Unlike ore refining (discrete
// batches), Assembly is a continuous rate: the facility makes `ratePerHour`
// units of `outputItem` per hour, each unit costing `requirements` (per-unit
// resource cost, not per-batch). Keyed by the commodity name it produces, so
// the planner can look it up automatically whenever that commodity shows up
// as a need.
export class AssemblyRecipe {
  constructor(outputItem, ratePerHour) {
    this.outputItem = outputItem;
    this.ratePerHour = ratePerHour;
    this.requirements = {}; // { itemName: qtyPerUnitOfOutput }
  }

  setRequirement(itemName, qty) {
    if (qty <= 0) {
      delete this.requirements[itemName];
    } else {
      this.requirements[itemName] = qty;
    }
  }
}

// What the player currently has on hand.
export class Inventory {
  constructor() {
    this.rawOre = new Map(); // Ore -> qty
    this.refined = new Map(); // Material -> qty
    this.other = {}; // { itemName: qty } - items outside the ore/material catalog
  }

  rawQty(ore) {
    return this.rawOre.get(ore) || 0;
  }

  refinedQty(material) {
    return this.refined.get(material) || 0;
  }
}

export class PlanResult {
  constructor() {
    this.itemNeed = {}; // itemName -> amount still needed after inventory
    this.itemKind = {}; // itemName -> 'material' | 'ore' | 'planet_resource' | 'unknown'
    this.materialOreChoice = new Map(); // itemName -> Ore chosen to source it from
    this.oreTargetRefined = new Map(); // Ore -> refined amount it must yield (max across assigned materials)
    this.oreDirectRaw = new Map(); // Ore -> raw units needed for direct (unrefined) use, summed
    this.oreRawNeeded = new Map(); // Ore -> total raw ore units required (before stored-raw offset)
    this.oreToMine = new Map(); // Ore -> raw ore units still left to mine (after stored-raw offset)
    this.planetHint = {}; // itemName -> list of planet type names that offer it
    this.harvestRate = {}; // itemName -> total configured harvester rate (units/hour)
    this.harvestHours = {}; // itemName -> hours needed at current rate (null if rate is 0)
    this.unresolved = {}; // itemName -> amount needed with no known source at all
    this.pendingCredit = {}; // itemName -> refined amount credited from in-progress refining batches
    this.pendingBatches = {}; // oreName -> batches currently in progress (echoed for display)
    this.assemblyHours = {}; // commodity itemName -> hours to produce via Assembly (null if rate unknown; echoed for display)
    this.totalRawToMine = 0;
    this.trips = 0;
  }
}

// Cascades Commodity (unknown-kind) needs through their AssemblyRecipe,
// merging the per-unit input cost (scaled by however many units are still
// needed) into the requirements pool, repeating until no further expansion
// happens (inputs can themselves be commodities needing their own assembly)
// or maxPasses is hit (guards against a circular recipe chain rather than
// hanging).
//
// Returns { expanded, assemblyHours } where assemblyHours is
// { commodityName: hours|null } for every commodity that got expanded (null
// if its recipe has no known rate yet) - used by the planner to mark it
// "resolved via Assembly" instead of unresolved, and by the UI to show an
// hours-to-produce estimate against that item.
export function expandCommodities(catalog, requirements, assemblyRecipes, inventory, maxPasses = 20) {
  assemblyRecipes = assemblyRecipes || {};
  const expanded = { ...requirements };
  const assemblyHours = {};
  const alreadyExpandedNeed = {}; // name -> need amount already cascaded, so growing demand across passes only adds the delta

  for (let pass = 0; pass < maxPasses; pass++) {
    let expandedAny = false;
    for (const name of Object.keys(expanded)) {
      const [kind] = catalog.classify(name);
      if (kind !== "unknown") continue;
      const recipe = assemblyRecipes[name];
      if (!recipe) continue;
      const have = inventory.other[name] || 0;
      const need = Math.max(0.0, expanded[name] - have);
      const prevNeed = alreadyExpandedNeed[name] || 0.0;
      if (need <= prevNeed) continue;
      const delta = need - prevNeed;
      alreadyExpandedNeed[name] = need;
      assemblyHours[name] = recipe.ratePerHour > 0 ? need / recipe.ratePerHour : null;
      for (const [inputName, qtyPerUnit] of Object.entries(recipe.requirements)) {
        expanded[inputName] = (expanded[inputName] || 0.0) + qtyPerUnit * delta;
      }
      expandedAny = true;
    }
    if (!expandedAny) break;
  }

  return { expanded, assemblyHours };
}

// needed_materials: { materialName: Set<buildName> } - materials with
// outstanding need, and which build(s) need them.
// currentOreChoices: { materialName: Ore } - source currently chosen per
// material.
//
// Mining one ore yields all 3 of its outputs at once (see planMining), so if
// two DIFFERENT builds each need a material that happens to be one of the
// same ore's outputs, mining that ore once covers both - but only if
// they're not already unified on it. Returns a list of
// { ore, covered: Material[], builds: Set<string> } for such opportunities,
// most-builds-covered first.
export function findConsolidationOpportunities(catalog, neededMaterials, currentOreChoices) {
  const suggestions = [];
  for (const ore of catalog.ores.values()) {
    const covered = ore.outputs.filter((m) => neededMaterials[m.name]);
    if (covered.length < 2) continue;
    const builds = new Set();
    for (const m of covered) {
      for (const b of neededMaterials[m.name]) builds.add(b);
    }
    if (builds.size < 2) continue; // only interesting when it actually spans multiple builds
    if (covered.every((m) => currentOreChoices[m.name] === ore)) continue; // already consolidated
    suggestions.push({ ore, covered, builds });
  }
  suggestions.sort((a, b) => b.builds.size - a.builds.size || b.covered.length - a.covered.length);
  return suggestions;
}

// slots: [{ resource: string|null, rate: number }] (fixed-size harvester
// roster). Returns { resourceName: totalRatePerHour }.
export function harvesterTotals(slots) {
  const totals = {};
  for (const slot of slots) {
    const resource = slot.resource;
    if (resource) {
      totals[resource] = (totals[resource] || 0.0) + (slot.rate || 0);
    }
  }
  return totals;
}

// pendingBatches: { oreName: number } batches of that ore currently being
// refined (already committed, not yet complete). Returns
// { materialName: number } total output credited across all 3 of each ore's
// outputs - refining is atomic, so starting N batches commits to all 3
// outputs at once, not just the one you had in mind.
export function pendingRefiningOutput(catalog, pendingBatches) {
  const bonus = {};
  for (const [oreName, batches] of Object.entries(pendingBatches || {})) {
    const ore = catalog.findOre(oreName);
    if (!ore || batches <= 0) continue;
    const outputAmount = batches * ore.refinedQ;
    for (const material of ore.outputs) {
      bonus[material.name] = (bonus[material.name] || 0.0) + outputAmount;
    }
  }
  return bonus;
}

// requirements: { itemName: number } total units needed (pre-inventory).
// oreChoices: { materialName: Ore } which ore to source each refined
//   material from, when it has more than one possible source.
// harvesterRates: { planetResourceName: number } total active harvester rate
//   (units/hour) currently assigned to gather that resource (see
//   harvesterTotals() to derive this from harvester slots).
// pendingBatches: { oreName: number } batches of that ore already started
//   refining (raw ore already committed and deducted from `inventory` by the
//   game itself, output not yet in inventory). Credited against
//   refined-material need only - it can't satisfy a raw-ore-used-directly
//   requirement, since that ore is being irreversibly converted, not kept
//   raw. The raw-ore side needs no separate accounting for this: `stored`
//   already reflects the deduction once synced.
// assemblyHours: { commodityName: number|null } hours needed at the Assembly
//   to cover that commodity's need (see expandCommodities()). `requirements`
//   should already include whatever those hours' per-unit inputs cascaded
//   into - this param just tells planMining those commodities aren't
//   actually unresolved.
//
// A raw ore consumed directly is additive across requirements (each use
// destroys that much raw ore). A refined material's need is consolidated per
// source ore via max(), since mining once yields all 3 of that ore's outputs
// simultaneously - the two effects are combined per ore (raw ore mined =
// enough to cover direct raw use AND feed the refining target). Planetary
// resources aren't mined in batches at all - they accrue at a steady
// rate/hour from assigned harvesters, so they get an hours-needed estimate
// instead of a raw-ore/trips figure. Assembly output works the same way as
// harvesting: a rate/hour, not a batch.
export function planMining(catalog, requirements, inventory, oreChoices, cargoCapacity, harvesterRates = null, pendingBatches = null, assemblyHours = null) {
  const result = new PlanResult();
  harvesterRates = harvesterRates || {};
  assemblyHours = assemblyHours || {};
  result.pendingBatches = { ...(pendingBatches || {}) };
  result.assemblyHours = { ...assemblyHours };
  const pendingBonus = pendingRefiningOutput(catalog, pendingBatches);

  for (const [name, totalQty] of Object.entries(requirements)) {
    const [kind, obj] = catalog.classify(name);
    result.itemKind[name] = kind;

    let have;
    if (kind === "material") {
      const credit = pendingBonus[name] || 0.0;
      result.pendingCredit[name] = credit;
      const havePlain = inventory.refinedQty(obj);
      have = havePlain + credit;
    } else if (kind === "ore") {
      have = inventory.rawQty(obj);
    } else {
      have = inventory.other[name] || 0;
    }

    const need = Math.max(0.0, totalQty - have);
    result.itemNeed[name] = need;

    if (kind === "material") {
      // Ore-side consolidation uses the need AFTER pending credit. The game
      // deducts an ore's raw stock the moment batches are submitted to
      // refining - by the time that's synced, `stored` already reflects it,
      // so crediting the pending output here too (via the post-credit need)
      // is the only place it should count. Using the pre-credit need here
      // would double-subtract: once via a lower `stored`, again via an
      // inflated raw-need floor.
      if (need <= 0) continue;
      const ore = oreChoices[name] || (obj.sources.length ? obj.sources[0] : null);
      if (ore === null || ore === undefined) {
        result.unresolved[name] = need;
        continue;
      }
      result.materialOreChoice.set(name, ore);
      result.oreTargetRefined.set(ore, Math.max(result.oreTargetRefined.get(ore) || 0.0, need));
    } else if (kind === "ore") {
      if (totalQty <= 0) continue;
      // Full amount, NOT reduced by `have` here: stored raw ore is a single
      // fungible pool shared with the refining need on this same ore (see
      // below), and can only be subtracted once, globally - subtracting it
      // here too would credit it twice.
      result.oreDirectRaw.set(obj, (result.oreDirectRaw.get(obj) || 0.0) + totalQty);
    } else if (kind === "planet_resource") {
      if (need <= 0) continue;
      result.planetHint[name] = obj.planetTypes.map((pt) => pt.name);
      const rate = harvesterRates[name] || 0.0;
      result.harvestRate[name] = rate;
      result.harvestHours[name] = rate > 0 ? need / rate : null;
    } else {
      if (need > 0 && !(name in assemblyHours)) {
        result.unresolved[name] = need;
      }
    }
  }

  pendingBatches = pendingBatches || {};
  const oresInvolved = new Set([...result.oreTargetRefined.keys(), ...result.oreDirectRaw.keys()]);
  for (const [oreName, batches] of Object.entries(pendingBatches)) {
    const ore = catalog.findOre(oreName);
    if (ore && batches > 0) oresInvolved.add(ore);
  }
  for (const ore of oresInvolved) {
    // `stored` already reflects any pending batches' raw-ore cost (the game
    // deducts it from stock the moment batches are submitted), and
    // oreTargetRefined above was already computed net of pending credit - so
    // stored is subtracted exactly once, here, with no extra reconciliation
    // needed for pending batches.
    const rawForRefining = result.oreTargetRefined.has(ore) ? ore.rawNeededFor(result.oreTargetRefined.get(ore)) : 0.0;
    const rawForDirect = result.oreDirectRaw.get(ore) || 0.0;
    const rawNeeded = rawForRefining + rawForDirect;
    result.oreRawNeeded.set(ore, rawNeeded);
    const stored = inventory.rawQty(ore);
    const toMine = Math.max(0.0, rawNeeded - stored);
    result.oreToMine.set(ore, toMine);
  }

  result.totalRawToMine = [...result.oreToMine.values()].reduce((a, b) => a + b, 0);
  result.trips = cargoCapacity > 0 ? Math.ceil(result.totalRawToMine / cargoCapacity) : 0;
  return result;
}

// Scales a Recipe's per-unit requirements by qty, or adds a flat ad-hoc
// material qty directly. Port of gui.py's _entries_to_totals. Lives here
// (rather than in tab-plan.js, its only caller until 2026-08-09) so it can
// also be imported by background.js's headless plan recalculation without
// pulling any DOM-touching UI module into the service worker context -
// this function only ever touches the plain `recipes` map passed in, never
// the DOM.
export function entriesToTotals(recipes, entries) {
  const totals = {};
  for (const [kind, name, qty] of entries) {
    if (kind === "recipe") {
      const recipe = recipes[name];
      if (!recipe) continue;
      for (const [item, itemQty] of Object.entries(recipe.scaled(qty))) {
        totals[item] = (totals[item] || 0) + itemQty;
      }
    } else {
      totals[name] = (totals[name] || 0) + qty;
    }
  }
  return totals;
}

// PlanResult (Ore/Material Map keys) -> the plain JSON shape the floating
// "To Mine" window (popup.js) expects, matching the old bridge_server.py's
// build_payload exactly. Moved here alongside entriesToTotals for the same
// DOM-free-importability reason.
export function toStorableToMineData(result, cargoCapacity) {
  if (!result) return { available: false, ores: [] };
  const ores = [];
  for (const [ore, toMine] of result.oreToMine.entries()) {
    if (toMine <= 0) continue;
    const trips = cargoCapacity > 0 ? Math.ceil(toMine / cargoCapacity) : 0;
    ores.push({ name: ore.name, law: ore.law, to_mine: Math.round(toMine * 10) / 10, trips, value_cr: Math.round(toMine * ore.value) });
  }
  ores.sort((a, b) => b.to_mine - a.to_mine);
  return {
    available: true,
    cargo_capacity: cargoCapacity,
    total_raw_to_mine: Math.round(result.totalRawToMine * 10) / 10,
    trips: result.trips,
    ores,
  };
}
