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
    // Informational only - the Captain Level needed to build this at the
    // Assembler, straight from the game's own Assembler Plans screen. Never
    // read by any planning/calculation code (unlike R&D, which the game
    // itself gates the "R&D Unlocked" list by); just displayed as a stat so
    // the player can judge for themselves whether they can queue it yet.
    this.captainLevel = null;
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
    // See Recipe.captainLevel above - same informational-only stat, not used
    // by any calculation.
    this.captainLevel = null;
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
    this.itemHave = {}; // itemName -> amount already on hand (refined qty + pending credit, for materials)
    // Gross (uncredited) counterparts of itemNeed/itemHave for materials -
    // netted against ACTUAL refined inventory only, never against
    // pending-refining credit. itemNeed/itemHave answer "does raw ore need
    // to be mined for this" (correctly crediting batches already
    // committed, so ore already spent isn't asked for again - see
    // oreTargetRefined below); itemNeedGross/itemHaveGross instead answer
    // "has this material actually been collected yet," for display
    // contexts where crediting not-yet-collected output would read as
    // "done" before it really is (see toStorableToMineData()'s Refined
    // section and the batch countdown it drives).
    this.itemNeedGross = {};
    this.itemHaveGross = {};
    this.itemKind = {}; // itemName -> 'material' | 'ore' | 'planet_resource' | 'unknown'
    this.materialOreChoice = new Map(); // itemName -> Ore chosen to source it from
    this.oreTargetRefined = new Map(); // Ore -> refined amount it must yield (max across assigned materials)
    // Gross counterparts of materialOreChoice/oreTargetRefined, built from
    // itemNeedGross instead - drive ONLY the Refined section's display
    // (materials list + "batches remaining" countdown), never the raw-ore-
    // to-mine totals (materialOreChoice/oreTargetRefined stay the credited
    // versions for that, so ore already committed to in-progress batches
    // is never asked for a second time). Populated for every material with
    // a known ore source, even ones the credited version skips entirely
    // because pending credit already brought their credited need to 0 -
    // otherwise a material fully "covered" only by not-yet-collected
    // output would vanish from the Refined section instead of correctly
    // showing as still outstanding.
    this.materialOreChoiceGross = new Map();
    this.oreTargetRefinedGross = new Map();
    this.oreDirectRaw = new Map(); // Ore -> raw units needed for direct (unrefined) use, summed
    this.oreRawNeeded = new Map(); // Ore -> total raw ore units required (before stored-raw offset)
    this.oreToMine = new Map(); // Ore -> raw ore units still left to mine (after stored-raw offset)
    this.oreStored = new Map(); // Ore -> raw ore units currently on hand (echoed for display)
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
// buyModes is an optional { itemName: "buy" } map (per-item, from
// settings.item_acquisition_mode - "mine" is the implicit default for any
// name absent from it) - an item marked "buy" is deliberately NOT cascaded
// into its own ingredient requirements, the same as one with no recipe at
// all: it stays a flat named quantity in `expanded` (and out of
// `assemblyHours`), for the player to go acquire directly rather than
// build. This is checked fresh for every name encountered on every pass, so
// a Commodity that only surfaces as a NESTED ingredient of some other
// "mine" item (never appearing in the original `requirements`) still gets
// its own buy/mine decision honored the moment it's cascaded in.
//
// Returns { expanded, assemblyHours } where assemblyHours is
// { commodityName: hours|null } for every commodity that got expanded (null
// if its recipe has no known rate yet) - used by the planner to mark it
// "resolved via Assembly" instead of unresolved, and by the UI to show an
// hours-to-produce estimate against that item.
export function expandCommodities(catalog, requirements, assemblyRecipes, inventory, maxPasses = 20, buyModes = null) {
  assemblyRecipes = assemblyRecipes || {};
  buyModes = buyModes || {};
  const expanded = { ...requirements };
  const assemblyHours = {};
  const alreadyExpandedNeed = {}; // name -> need amount already cascaded, so growing demand across passes only adds the delta

  for (let pass = 0; pass < maxPasses; pass++) {
    let expandedAny = false;
    for (const name of Object.keys(expanded)) {
      const [kind] = catalog.classify(name);
      if (kind !== "unknown") continue;
      if (buyModes[name] === "buy") continue;
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
    result.itemHave[name] = have;

    if (kind === "material") {
      // Gross tracking - computed unconditionally, independent of the
      // credited `need` below, so a material that's fully covered ONLY
      // because of anticipated pending output (credited need <= 0) still
      // correctly shows as "not actually collected yet" here (see
      // itemNeedGross's own doc comment on PlanResult).
      const haveGross = inventory.refinedQty(obj);
      const needGross = Math.max(0.0, totalQty - haveGross);
      result.itemNeedGross[name] = needGross;
      result.itemHaveGross[name] = haveGross;
      const oreForGross = oreChoices[name] || (obj.sources.length ? obj.sources[0] : null);
      if (oreForGross) {
        result.materialOreChoiceGross.set(name, oreForGross);
        if (needGross > 0) {
          result.oreTargetRefinedGross.set(oreForGross, Math.max(result.oreTargetRefinedGross.get(oreForGross) || 0.0, needGross));
        }
      }

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
    result.oreStored.set(ore, stored);
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

// A standalone, fully-expanded raw-resource breakdown for ONE Assembly item
// on its own - e.g. "Industrial Ioniser" cascaded all the way down to the
// ore/material/nested-Commodity totals it takes to build `need` more units,
// for the Item sources sub-category display (see tab-plan.js). Pure recipe
// multiplication all the way down (NOT netted against inventory at each
// step, unlike expandCommodities()) - `need` is already the outstanding
// amount of the item itself (netted once, by the caller), and this exists
// purely to show what building that many actually costs, in full - netting
// each intermediate ingredient against inventory too would just hide rows
// the player still needs to go mine whenever they happen to already have
// SOME (but not all) of an intermediate ingredient in stock, which is the
// opposite of "list everything that needs to be mined." Deliberately
// independent of the rest of the plan's own totals - this is informational
// attribution for ONE item, not a second pool: the real combined Mining/
// Ore-to-Mine totals (planMining() on the whole plan's merged requirements)
// remain the single source of truth for what to actually go mine and how
// many trips that takes. buyModes is threaded through so a nested
// ingredient the player separately chose "buy" for stops cascading here
// too, matching expandCommodities() itself - it shows up as its own flat
// leaf line instead of being expanded further. A qty-carrying recursive
// walk (not expandCommodities' pass-based loop) so diamond-shaped recipes -
// two different ingredients both needing the same base ore - correctly sum
// instead of only counting the first occurrence; maxDepth guards a circular
// recipe chain the same way expandCommodities' maxPasses does.
export function itemResourceBreakdown(catalog, itemName, need, assemblyRecipes, buyModes, maxDepth = 20) {
  const recipe = (assemblyRecipes || {})[itemName];
  if (!recipe || need <= 0) return [];
  buyModes = buyModes || {};
  const totals = {};
  const walk = (name, qty, depth) => {
    const [kind] = catalog.classify(name);
    const nestedRecipe = kind === "unknown" && buyModes[name] !== "buy" ? assemblyRecipes[name] : null;
    if (nestedRecipe && depth < maxDepth) {
      for (const [inputName, qtyPerUnit] of Object.entries(nestedRecipe.requirements)) walk(inputName, qtyPerUnit * qty, depth + 1);
      return;
    }
    totals[name] = (totals[name] || 0) + qty;
  };
  for (const [inputName, qtyPerUnit] of Object.entries(recipe.requirements)) walk(inputName, qtyPerUnit * need, 1);

  const rows = Object.entries(totals).map(([name, qty]) => {
    const [kind] = catalog.classify(name);
    return { name, kind, need: Math.round(qty * 10) / 10 };
  });
  rows.sort((a, b) => b.need - a.need);
  return rows;
}

// PlanResult (Ore/Material Map keys) -> the plain JSON shape the floating
// Manifest window (popup.js) expects, matching the old bridge_server.py's
// build_payload exactly (plus `assembly`, added later). Moved here alongside
// entriesToTotals for the same DOM-free-importability reason.
export function toStorableToMineData(result, cargoCapacity) {
  if (!result) return { available: false, ores: [], refined: [], assembly: [], planetary: [], buy: [] };
  // Mining/ores is the TOTAL raw ore still needed - direct use AND
  // refining combined, same as it's always been (result.oreToMine).
  // Deliberately NOT split by direct-vs-refining: stored raw ore is one
  // single, shared, fungible pool - it isn't reserved for one purpose or
  // the other, so a refining batch consumes from the exact same stock that
  // "covers" direct use. Netting them separately would tell the player
  // direct use is covered by stock they're about to consume via a refining
  // batch. Refined's raw_needed below is a BREAKDOWN of how much of this
  // same total is attributable to refining, not an additional amount on
  // top of it - see renderRefinedGroups()'s wording in popup.js.
  const ores = [];
  for (const [ore, toMine] of result.oreToMine.entries()) {
    if (toMine <= 0) continue;
    const trips = cargoCapacity > 0 ? Math.ceil(toMine / cargoCapacity) : 0;
    // How much of to_mine is attributable to refining - a BREAKDOWN, not an
    // additional amount on top of to_mine. Shown inline on the row itself
    // (see renderPersonalRow() in popup.js) so the connection to the
    // "Refined" section below is obvious at a glance.
    const refinedPortion = result.oreTargetRefined.has(ore) ? ore.rawNeededFor(result.oreTargetRefined.get(ore)) : 0;
    ores.push({
      name: ore.name,
      law: ore.law,
      to_mine: Math.round(toMine * 10) / 10,
      trips,
      value_cr: Math.round(toMine * ore.value),
      refined_portion: Math.round(refinedPortion * 10) / 10,
    });
  }
  ores.sort((a, b) => b.to_mine - a.to_mine);

  // Refined materials still needed - sub-grouped by which ore was chosen to
  // source them (result.materialOreChoice). Multiple materials can share
  // one ore - refining an ore yields ALL 3 of its outputs at once, which is
  // exactly why oreTargetRefined takes the MAX need across those materials
  // rather than summing them (see planMining()) - so this groups by ore
  // too, rather than listing materials flat with no sourcing context. Each
  // group also carries the batch-tracking fields that used to live on the
  // Mining row for this same ore, now that Mining only covers direct use.
  const refinedGroups = new Map(); // Ore -> group
  const refined = [];
  // Materials list + "remaining_batches" both come from the GROSS maps
  // (itemNeedGross/itemHaveGross/materialOreChoiceGross/oreTargetRefinedGross)
  // - netted only against actual refined inventory, never against pending-
  // refining credit - so a batch that's merely been STARTED (typed into
  // the Manifest popup's batch input) doesn't make this section look more
  // "done" than it really is until the material is actually collected and
  // synced. raw_needed is the one exception: it stays on the CREDITED
  // oreTargetRefined, since that answers a genuinely different question -
  // how much MORE raw ore is left to go mine - and ore already committed
  // to in-progress batches correctly shouldn't be asked for twice.
  for (const [materialName, ore] of result.materialOreChoiceGross.entries()) {
    const need = result.itemNeedGross[materialName] || 0;
    if (need <= 0) continue;
    const have = result.itemHaveGross[materialName] || 0;
    let group = refinedGroups.get(ore);
    if (!group) {
      const targetRefined = result.oreTargetRefined.get(ore) || 0;
      const targetRefinedGross = result.oreTargetRefinedGross.get(ore) || 0;
      const rawNeeded = ore.rawNeededFor(targetRefined);
      const pendingBatches = (result.pendingBatches || {})[ore.name] || 0;
      // How many MORE batches are needed in total, counting only what's
      // actually been collected so far - NOT reduced by batches merely
      // pending/in-progress (see this block's header comment).
      const remainingBatches = ore.refinedQ > 0 ? Math.ceil(targetRefinedGross / ore.refinedQ) : 0;
      group = {
        ore: ore.name,
        law: ore.law,
        raw_needed: Math.round(rawNeeded * 10) / 10,
        pending_batches: pendingBatches,
        remaining_batches: remainingBatches,
        materials: [],
      };
      refinedGroups.set(ore, group);
      refined.push(group);
    }
    group.materials.push({ name: materialName, need: Math.round(need * 10) / 10, have: Math.round(have * 10) / 10 });
  }
  for (const group of refined) group.materials.sort((a, b) => b.need - a.need);
  refined.sort((a, b) => b.raw_needed - a.raw_needed);

  // Commodities resolved via Assembly (see expandCommodities()) rather than
  // mined - result.assemblyHours/result.itemNeed already carry exactly this
  // data, just not previously surfaced into the popup's payload.
  const assembly = [];
  for (const [name, hours] of Object.entries(result.assemblyHours || {})) {
    const need = result.itemNeed[name] || 0;
    if (need <= 0) continue;
    assembly.push({ name, need: Math.round(need * 10) / 10, hours: hours != null ? Math.round(hours * 10) / 10 : null });
  }
  assembly.sort((a, b) => b.need - a.need);

  // Planet-harvested resources (kind "planet_resource") - gathered by
  // assigned harvesters over time rather than mined in batches or produced
  // at the Assembly. result.harvestHours/harvestRate/planetHint/itemNeed
  // already carry this, just not previously surfaced into the popup's
  // payload (same situation assembly was in before it got added above).
  const planetary = [];
  for (const [name, hours] of Object.entries(result.harvestHours || {})) {
    const need = result.itemNeed[name] || 0;
    if (need <= 0) continue;
    planetary.push({
      name,
      need: Math.round(need * 10) / 10,
      hours: hours != null ? Math.round(hours * 10) / 10 : null,
      rate: result.harvestRate[name] || 0,
      planets: result.planetHint[name] || [],
    });
  }
  planetary.sort((a, b) => b.need - a.need);

  // Commodity-kind items left unresolved on purpose - either no known
  // Assembly recipe exists at all, or the player explicitly chose "Buy" for
  // that specific item in Item sources (see expandCommodities()'s buyModes
  // param) - either way, `assembly` above only contains items that WERE
  // cascaded, so result.unresolved's kind:"unknown" entries are exactly the
  // rest: a flat quantity still needed, to go acquire directly instead.
  const buy = [];
  for (const [name, need] of Object.entries(result.unresolved || {})) {
    if (result.itemKind[name] !== "unknown" || need <= 0) continue;
    buy.push({ name, need: Math.round(need * 10) / 10 });
  }
  buy.sort((a, b) => b.need - a.need);

  return {
    available: true,
    cargo_capacity: cargoCapacity,
    total_raw_to_mine: Math.round(result.totalRawToMine * 10) / 10,
    trips: result.trips,
    ores,
    refined,
    buy,
    assembly,
    planetary,
  };
}

// A build's raw requirement totals (from entriesToTotals(), BEFORE ore/
// refining expansion) vs. what's currently sitting in the corp's shared
// Store, for corp-level coordination and farming-trip counting. Deliberately
// flat need-vs-have per named item, not run through planMining()'s ore
// pipeline: corp-store items are already-gathered stock (raw or finished),
// not something to be mined via this player's own harvesters/ore choices -
// the only question is how much of the corp's target is still short, and how
// many farming trips it'd take THIS player to close that gap, using their
// own cargo_capacity (see js/storage.js - each player has their own, e.g.
// 600 vs. a corp-mate's 2000). Trips are based on the SHORTFALL, not on
// stock already in the Store - this view is for contributing toward a
// shared corp project, not withdrawing from it, so it should never read as
// "go take this many units out."
// oreChoices: { materialName: Ore } - same per-player setting Personal
// mining uses (settings.ore_choices, resolved to Ore objects), applied here
// too so "which ore sources this" reflects THIS player's own configured
// preference even for a shared corp target.
//
// haveOverrides: { itemName: qty } - a SHARED, manually-reported "known
// total have" (storage.js's corpHaveOverrides), for a corp-mate with
// visibility this player's own live corpInventory can't provide (e.g.
// whoever actually holds the "bank alt" a leader sweeps deposits into).
// When present for an item, this REPLACES the live Corp Store balance for
// that item entirely - it's presumed more authoritative than what this
// player can otherwise see. Items absent from this dict fall back to the
// live corpInventory balance unaffected.
export function toStorableCorpData(catalog, assemblyRecipes, oreChoices, totals, corpInventory, cargoCapacity, haveOverrides) {
  const items = [];
  // Refined materials are pulled out of the flat items list into their own
  // ore-sourced grouping, same reasoning as toStorableToMineData()'s
  // "refined" section: multiple materials can share one ore, and refining
  // it yields ALL 3 outputs at once, so the raw ore needed is the MAX
  // shortfall across those materials converted to raw units, not the sum
  // (summing would overstate it - one refining run already covers all 3
  // outputs at the yield ratio).
  const refinedGroups = new Map(); // Ore|"unresolved" -> group
  const refined = [];

  for (const [name, need] of Object.entries(totals || {})) {
    if (need <= 0) continue;
    const have = haveOverrides && name in haveOverrides ? haveOverrides[name] : (corpInventory || {})[name] || 0;
    const shortfall = Math.max(0, need - have);
    // Fully-covered items are dropped entirely, same as personal's
    // oreToMine (toMine<=0 -> skip) - the workflow here is "gather the
    // shortfall, deposit it to the corp," so an item the corp already has
    // enough of isn't actionable and shouldn't clutter the list.
    if (shortfall <= 0) continue;

    const [kind, obj] = catalog.classify(name);

    if (kind === "material") {
      const ore = (oreChoices || {})[name] || (obj.sources.length ? obj.sources[0] : null);
      const groupKey = ore || "unresolved";
      let group = refinedGroups.get(groupKey);
      if (!group) {
        group = { _ore: ore, targetRefined: 0, materials: [] };
        refinedGroups.set(groupKey, group);
        refined.push(group);
      }
      group.targetRefined = Math.max(group.targetRefined, shortfall);
      group.materials.push({ name, need: Math.round(shortfall * 10) / 10, have: Math.round(have * 10) / 10 });
      continue;
    }

    // 4 remaining top-level categories, same split as the Corp tab's
    // "Create Corp Plan" bulk-entry grid (tab-corp.js): Ore, Assembly,
    // Planetary, Commodities. Anything truly unclassifiable (a named
    // commodity with no Assembly recipe) falls into "commodity" rather
    // than being silently dropped.
    let category;
    let law = null;
    let planets = null;
    if (kind === "ore") {
      category = "ore";
      law = obj.law;
    } else if (kind === "planet_resource") {
      category = "planetary";
      planets = obj.planetTypes.map((pt) => pt.name);
    } else if (assemblyRecipes && assemblyRecipes[name]) {
      category = "assembly";
    } else {
      category = "commodity";
    }

    const trips = cargoCapacity > 0 ? Math.ceil(shortfall / cargoCapacity) : 0;
    items.push({
      name,
      need: Math.round(need * 10) / 10,
      have: Math.round(have * 10) / 10,
      shortfall: Math.round(shortfall * 10) / 10,
      trips,
      category,
      // Only "ore" is actually hauled in cargo-hold trips - Assembly output
      // and Planetary resources are contributed if/when you happen to have
      // them, not farmed in a deliberate trip count, so the UI only shows
      // trips for category "ore".
      kind,
      law,
      planets,
    });
  }
  items.sort((a, b) => b.need - a.need);

  for (const group of refined) {
    const ore = group._ore;
    group.ore = ore ? ore.name : "Unknown source";
    group.law = ore ? ore.law : null;
    group.raw_needed = ore ? Math.round(ore.rawNeededFor(group.targetRefined) * 10) / 10 : 0;
    delete group._ore;
    delete group.targetRefined;
    group.materials.sort((a, b) => b.need - a.need);
  }
  refined.sort((a, b) => b.raw_needed - a.raw_needed);

  return { available: true, cargo_capacity: cargoCapacity, items, refined };
}

// Ore first, then Refined (spliced in below, right after Ore since refined
// materials come from ore), then the 3 remaining toStorableCorpData()
// categories - same 5-category split as the Corp tab's "Create Corp Plan"
// grid.
const CORP_CSV_BLOCKS = [
  { label: "Ore", category: "ore" },
  { label: "Assembly", category: "assembly" },
  { label: "Planetary", category: "planetary" },
  { label: "Commodity", category: "commodity" },
];

// RFC 4180-ish quoting: wrap in quotes (doubling any internal quotes)
// whenever the field contains a comma, quote, or newline - item names are
// player/Coops-authored text and can't be assumed comma-free.
function csvField(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// toStorableCorpData()'s result -> a CSV string for corp-mates who'd rather
// work in a spreadsheet than install the extension - laid out as 5 side-
// by-side column blocks, one per category (Ore/Refined/Assembly/Planetary/
// Commodity), each its own [Item, Need, Have, Shortfall] group rather than
// one flat table with a Category column - closer to the kind of spreadsheet
// corps already track these against by hand (see tab-corp.js's "Create
// Corp Plan" grid, which uses the same per-category-column layout). Each
// block's row count is whatever that category actually has - shorter
// blocks are padded with blank cells so every row in the CSV stays the
// same width. Deliberately no Trips column - trips are computed from the
// EXPORTING player's own cargo_capacity (see toStorableCorpData()), so
// it'd be a meaningless or actively misleading number for any corp-mate
// with a different cargo hold reading the file.
export function toCorpCsv(data) {
  const blocks = CORP_CSV_BLOCKS.map(({ label, category }) => ({
    label,
    rows: ((data && data.items) || []).filter((item) => item.category === category).map((item) => [item.name, item.need, item.have, item.shortfall]),
  }));
  const refinedRows = [];
  for (const group of (data && data.refined) || []) {
    for (const material of group.materials) {
      // Refined materials' own `need` field is already the shortfall (see
      // toStorableCorpData() above) - reconstruct the original target so
      // this block's "Need" column means the same thing as every other
      // block's.
      refinedRows.push([material.name, Math.round((material.need + material.have) * 10) / 10, material.have, material.need]);
    }
  }
  blocks.splice(1, 0, { label: "Refined", rows: refinedRows });

  // A blank spacer column between blocks (not before the first or after
  // the last) - purely visual breathing room in a spreadsheet; empty
  // header cells never match parseCorpCsv()'s "*Item"/"*Need" pattern, so
  // they're already ignored on import with no special-casing needed there.
  const header = blocks.flatMap((b, i) => (i > 0 ? ["", `${b.label} Item`, `${b.label} Need`, `${b.label} Have`, `${b.label} Shortfall`] : [`${b.label} Item`, `${b.label} Need`, `${b.label} Have`, `${b.label} Shortfall`]));
  const maxRows = Math.max(0, ...blocks.map((b) => b.rows.length));
  const csvRows = [header];
  for (let i = 0; i < maxRows; i++) {
    csvRows.push(blocks.flatMap((b, bi) => (bi > 0 ? ["", ...(b.rows[i] || ["", "", "", ""])] : b.rows[i] || ["", "", "", ""])));
  }
  return csvRows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

// RFC-4180-ish CSV parser: handles quoted fields (with embedded commas,
// quotes doubled per the standard, and embedded newlines), CRLF or bare LF
// line endings. Returns an array of rows, each row an array of raw string
// cells - no header/type interpretation here, that's parseCorpCsv()'s job.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Inverse of toCorpCsv() - reads a CSV back into { needs, haves }, each a
// flat { itemName: qty } dict, for the Corp tab's Import CSV button.
// toCorpCsv() writes multiple side-by-side "<Category> Item"/"<Category>
// Need"/"<Category> Have" column triples (one per category block) rather
// than one flat set - this pairs up EVERY "*Item" header with whichever
// "*Need"/"*Have" headers share its prefix (case-insensitively, whatever
// comes before the trailing word), so every block gets read regardless of
// which categories are present, how many columns each has, or what order
// they're in. A bare "Item"/"Need"/"Have" set with no prefix (empty string)
// also matches, so a plain single-block CSV - like a corp-mate's stripped-
// down version of the file, or one from an older version of this export -
// still imports correctly. Only "*Item"/"*Need"/"*Have" are read; whatever
// else a corp-mate did to the file (added notes, deleted the Shortfall
// column, re-sorted rows, added/removed entire category blocks) doesn't
// matter. A block needs "*Item" AND "*Need" to contribute to `needs` -
// "*Have" is optional per block (a corp-mate reporting stock might only
// fill in Have for items they actually checked, leaving Need blank, and
// vice versa). Rows with a blank name or non-numeric value are silently
// skipped rather than erroring - a half-edited spreadsheet is the expected
// case, not corrupt data; Need additionally requires a positive value
// (matching the grid's own requirement), Have accepts 0 (a meaningful
// "confirmed none," not the same as "not reported"). Duplicate item names
// (the same item appearing in two blocks, or two exports pasted together)
// sum for `needs`, but take the LAST value seen for `haves` (a running
// total wouldn't make sense for a stock report the way it does for a
// requirement total).
export function parseCorpCsv(text) {
  const rows = parseCsvRows(text || "");
  if (rows.length === 0) return { needs: {}, haves: {} };
  const header = rows[0].map((h) => h.trim());

  const colsByPrefix = (suffix) => {
    const map = new Map();
    const re = new RegExp(`^(.*?)\\s*${suffix}$`, "i");
    header.forEach((h, i) => {
      const match = re.exec(h);
      if (match) map.set(match[1].toLowerCase(), i);
    });
    return map;
  };
  const itemCols = colsByPrefix("item");
  const needCols = colsByPrefix("need");
  const haveCols = colsByPrefix("have");

  const needPairs = []; // [itemCol, needCol]
  const havePairs = []; // [itemCol, haveCol]
  for (const [prefix, itemCol] of itemCols) {
    if (needCols.has(prefix)) needPairs.push([itemCol, needCols.get(prefix)]);
    if (haveCols.has(prefix)) havePairs.push([itemCol, haveCols.get(prefix)]);
  }

  const needs = {};
  const haves = {};
  for (const row of rows.slice(1)) {
    for (const [itemCol, needCol] of needPairs) {
      const name = (row[itemCol] || "").trim();
      const qty = parseFloat(row[needCol]);
      if (!name || Number.isNaN(qty) || qty <= 0) continue;
      needs[name] = (needs[name] || 0) + qty;
    }
    for (const [itemCol, haveCol] of havePairs) {
      const name = (row[itemCol] || "").trim();
      const raw = (row[haveCol] || "").trim();
      if (!name || !raw) continue;
      const qty = parseFloat(raw);
      if (Number.isNaN(qty) || qty < 0) continue;
      haves[name] = qty;
    }
  }
  return { needs, haves };
}
