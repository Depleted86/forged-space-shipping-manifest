// Planning engine - JS port of models.py's Recipe/AssemblyRecipe/Inventory/
// PlanResult classes and its expand_commodities/find_consolidation_opportunities/
// harvester_totals/pending_refining_output/plan_mining functions. Recipe and
// AssemblyRecipe are named Blueprint and AssemblyPlan here - renamed on
// 2026-08-15 to match the game's own terminology - but the Python names are
// left as-is above since that app is deleted and this comment is now purely
// historical lineage.
//
// Preserves exact semantics of the Python original, verified against
// golden-master fixtures captured from the live Python app (see test/).

// An item/build with requirements, keyed by plain item name.
//
// An item name can be a refined material (e.g. "Iron Ore"), a raw ore
// consumed directly/unrefined (e.g. "Thracium"), or a resource outside the
// ore catalog entirely (e.g. an uncatalogued planetary resource) - the
// planner classifies each name at plan time via Catalog.classify().
export class Blueprint {
  constructor(name) {
    this.name = name;
    this.requirements = {}; // { itemName: qtyPerUnit }
    // Informational only - the Captain Level needed to build this at the
    // Assembler, straight from the game's own Assembler Plans screen. Never
    // read by any planning/calculation code (unlike R&D, which the game
    // itself gates the "R&D Unlocked" list by); just displayed as a stat so
    // the player can judge for themselves whether they can queue it yet.
    this.captainLevel = null;
    // From the game's Blueprint Store (see background.js's
    // handleBlueprintStoreScrape()), or null for a hand-entered blueprint
    // never seen there: { owned, copies, shipClass, buildLimit, price,
    // basePrice, discountPct, buildCost, guideValue, mfgSkill } - credits,
    // and the Manufacturing Skill needed to run it (detail panel only).
    // Display-only - an unowned blueprint still counts in planning.
    this.store = null;
  }

  setRequirement(itemName, qty) {
    if (qty <= 0) {
      delete this.requirements[itemName];
    } else {
      this.requirements[itemName] = qty;
    }
  }

  // A blueprint added from the store list has no materials until it's
  // opened in the store's detail panel.
  hasRecipe() {
    return Object.keys(this.requirements).length > 0;
  }

  scaled(multiplier) {
    const out = {};
    for (const [name, qty] of Object.entries(this.requirements)) {
      out[name] = qty * multiplier;
    }
    return out;
  }
}

// Ship-class filtering for the long, store-fed blueprint lists (Blueprints
// tab, Plan a Build, Manifest overlay). A class is the store's badge
// ("Frigate", "Cruiser", "Miner"...); hand-entered blueprints have none and
// are grouped under NO_SHIP_CLASS. "" means no filter.
export const NO_SHIP_CLASS = "__none__";

export function blueprintShipClasses(blueprints) {
  const all = Object.values(blueprints);
  const classes = [...new Set(all.map((b) => b.store?.shipClass).filter(Boolean))].sort();
  if (all.some((b) => !b.store?.shipClass)) classes.push(NO_SHIP_CLASS);
  return classes;
}

export function inShipClass(blueprint, wanted) {
  const c = blueprint?.store?.shipClass;
  return !wanted || (wanted === NO_SHIP_CLASS ? !c : c === wanted);
}

export function shipClassLabel(value) {
  return value === "" ? "All classes" : value === NO_SHIP_CLASS ? "(no class)" : value;
}

// Which store a blueprint came from, as a dropdown group heading. Store
// titles follow no single pattern ("Blueprint Store", "Kriton Blueprints",
// "Sabre Shield Systems"), so the category in the store's subtitle
// ("Mercenur - Shield Blueprints") decides it; a category not listed in
// STORE_CATEGORY_GROUPS gets its own group ("Weapon" -> "Weapons").
// Blueprints saved before the category was recorded fall back to the store
// title, or to what only that store shows (Ship Value, Engineering to fit),
// until the store is opened again; hand-entered ones go under "Other".
export const STORE_GROUPS = ["Blueprints", "Ships", "Auxiliary Systems", "Modules", "Shields", "Other"];

const STORE_CATEGORY_GROUPS = {
  Manufacturing: "Blueprints",
  Starship: "Ships",
  Auxiliary: "Auxiliary Systems",
  "Ship Module": "Modules",
  Shield: "Shields",
};

export function blueprintStoreGroup(blueprint) {
  const st = blueprint?.store;
  const category = st?.storeCategory;
  if (category) return STORE_CATEGORY_GROUPS[category] || `${category}s`;
  const name = st?.storeName;
  if (name === "Blueprint Store") return "Blueprints";
  if (name === "Starship Blueprint Store") return "Ships";
  if (name === "Auxiliary Systems") return "Auxiliary Systems";
  if (name && /\bShield\b/.test(name)) return "Shields";
  if (name) return "Modules";
  if (st?.shipValue != null) return "Ships";
  if (st?.engReq != null) return "Modules";
  return "Other";
}

// names (already sorted however the caller wants) split into
// [[group, names], ...]: one group per store group, in STORE_GROUPS order -
// any new store category's group just before "Other" - and within it one
// per type learnt from the store's type filter ("Blueprints › Systems"),
// alphabetically, with that store's not-yet-typed blueprints after under
// the plain store group name. Empty groups are left out.
export function groupBlueprintNames(names, blueprints) {
  const byGroup = new Map();
  for (const name of names) {
    const base = blueprintStoreGroup(blueprints[name]);
    const type = blueprints[name]?.store?.storeType || null;
    const key = type ? `${base} › ${type}` : base;
    if (!byGroup.has(key)) byGroup.set(key, { base, type, names: [] });
    byGroup.get(key).names.push(name);
  }
  const rank = (g) => (g === "Other" ? Infinity : STORE_GROUPS.includes(g) ? STORE_GROUPS.indexOf(g) : STORE_GROUPS.length - 1);
  return [...byGroup]
    .sort(([, a], [, b]) =>
      rank(a.base) - rank(b.base) ||
      a.base.localeCompare(b.base) ||
      (a.type ? 0 : 1) - (b.type ? 0 : 1) ||
      (a.type || "").localeCompare(b.type || "")
    )
    .map(([key, group]) => [key, group.names]);
}

// After a blueprint's name in every blueprint dropdown when it's only been
// seen in a store's list, never opened there, so its materials aren't known
// yet.
export const UNVIEWED_MARK = "👁";

// How a blueprint reads in every blueprint dropdown: its name, with the
// unviewed mark after. The requirement dot in front comes from markRequirements().
export function blueprintOptionLabel(name, blueprint) {
  return blueprint && !blueprint.hasRecipe() ? `${name} ${UNVIEWED_MARK}` : name;
}

// Hours an Assembly item takes with `assemblers` Assemblers all making it:
// `hours` is its one-hour runs, shared out between them and rounded up to
// whole runs, since a run can't be split. Set per item in the Manifest
// overlay (settings.assembler_counts); 1 when unset. null stays null.
export function assemblyHoursWith(hours, assemblers) {
  if (hours == null) return null;
  const count = Math.max(1, Math.floor(assemblers || 1));
  return count > 1 ? Math.ceil(hours / count) : hours;
}

// Whether a blueprint needs more Manufacturing Skill than the player has
// (read from Character Skills) - false while either isn't known.
export function blueprintSkillTooLow(blueprint, manufacturingSkill) {
  const need = blueprint?.store?.mfgSkill;
  return need != null && manufacturingSkill != null && need > manufacturingSkill;
}

// In front of a blueprint's name in every blueprint dropdown: whether the
// player meets what it needs to build - Manufacturing Skill, or Captain
// level for Starship blueprints. Emoji, since they keep their colour in
// every browser - Firefox ignores option text and background colours in
// these lists.
export const SKILL_OK_MARK = "🟢";
export const SKILL_TOO_LOW_MARK = "🔴";

// Adds the requirement dot to a blueprint dropdown option, and the
// requirements as its tooltip: "MFG Req 18/24" (Manufacturing Skill needed /
// the player's), "Captain Lvl Req 30/42" for Starship blueprints, "?" while
// the player's level isn't known yet. `settings` gives the player's levels
// (manufacturing_skill, captain_level, read from the game). Red when any
// requirement is above the player's level; no dot until every requirement
// can be checked; blueprints with neither requirement are left as they are.
export function markRequirements(option, blueprint, settings) {
  const reqs = [
    ["MFG Req", blueprint?.store?.mfgSkill, settings?.manufacturing_skill],
    ["Captain Lvl Req", blueprint?.captainLevel, settings?.captain_level],
  ].filter(([, need]) => need != null);
  if (reqs.length === 0) return option;
  option.title = reqs.map(([label, need, have]) => `${label} ${need}/${have ?? "?"}`).join(" · ");
  if (reqs.some(([, , have]) => have == null)) return option;
  const tooLow = reqs.some(([, need, have]) => need > have);
  option.textContent = `${tooLow ? SKILL_TOO_LOW_MARK : SKILL_OK_MARK} ${option.textContent}`;
  if (tooLow) option.style.color = "#f87171";
  return option;
}

// Blueprint names in dropdown order: by Manufacturing Skill needed, lowest
// first, then by Captain level needed (Starship blueprints), then by name -
// those with neither known yet after the rest.
export function sortBlueprintNamesBySkill(names, blueprints) {
  const skillOf = (name) => blueprints[name]?.store?.mfgSkill ?? Infinity;
  const captainOf = (name) => blueprints[name]?.captainLevel ?? Infinity;
  return [...names].sort((a, b) => skillOf(a) - skillOf(b) || captainOf(a) - captainOf(b) || a.localeCompare(b));
}

export const BLUEPRINT_LIST_LEGEND = `${SKILL_OK_MARK} / ${SKILL_TOO_LOW_MARK} = your Manufacturing Skill (Captain level for ships) is / isn't high enough - hover for the requirement. ${UNVIEWED_MARK} = seen in a store but not opened yet - click it in the store to save its materials.`;

// Shown wherever a blueprint with no materials yet is picked - the game
// only shows a recipe once the blueprint is opened in its store, which is
// what imports it (background.js's handleBlueprintStoreScrape()).
export function blueprintImportHint(blueprint) {
  const store = blueprint?.store?.storeName || "Blueprint Store";
  return `View in the ${store}${/store$/i.test(store) ? "" : " store"} to import it and track the needed resources.`;
}

// How a Commodity is produced at the Assembly. Production happens in
// one-hour runs: each run consumes `requirements` once (the ingredient list
// exactly as the game's Assembly Facility screen lists it) and yields
// `ratePerHour` units of `outputItem` - the game's "Rate (units/hour)"
// column IS the output per run (confirmed with the user 2026-10-30: Circuit
// Boards shows 5/hr, and 1 run's ingredients make 5 boards). Runs can't be
// partial, so building N units takes ceil(N / ratePerHour) runs - see
// runsFor(). Keyed by the commodity name it produces, so the planner can
// look it up automatically whenever that commodity shows up as a need.
export class AssemblyPlan {
  constructor(outputItem, ratePerHour) {
    this.outputItem = outputItem;
    this.ratePerHour = ratePerHour;
    this.requirements = {}; // { itemName: qtyPerRun }
    // See Blueprint.captainLevel above - same informational-only stat, not
    // used by any calculation.
    this.captainLevel = null;
    // R&D status from the game's R&D Office "Select Research Plan" list, or
    // null for plans that aren't R&D-gated (or haven't been seen there):
    // { level, skillRequired, progress, active } - level 0 means not yet
    // researched, so the plan can't be queued at an Assembler. Display-only;
    // a locked plan still counts in planning so players can plan ahead.
    this.research = null;
  }

  isResearchLocked() {
    return this.research != null && this.research.level === 0;
  }

  // A plan seen only on the R&D list has a name but no recipe until the
  // Assembly Facility (or the player) supplies one - it can't be expanded.
  hasRecipe() {
    return Object.keys(this.requirements).length > 0;
  }

  setRequirement(itemName, qty) {
    if (qty <= 0) {
      delete this.requirements[itemName];
    } else {
      this.requirements[itemName] = qty;
    }
  }

  // Whole runs needed to produce `qty` units. A missing/zero rate falls back
  // to 1 unit per run. The epsilon keeps float noise from an upstream
  // multiplication (e.g. 10.000000001) from costing a whole extra run.
  runsFor(qty) {
    if (qty <= 0) return 0;
    const perRun = this.ratePerHour > 0 ? this.ratePerHour : 1;
    return Math.ceil(qty / perRun - 1e-9);
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

// Cascades Commodity (unknown-kind) needs through their AssemblyPlan,
// merging the per-run input cost (scaled by the whole runs needed to cover
// the outstanding units - see AssemblyPlan.runsFor()) into the requirements
// pool, repeating until no further expansion happens (inputs can themselves be commodities needing their own assembly)
// or maxPasses is hit (guards against a circular plan chain rather than
// hanging).
//
// buyModes is an optional { itemName: "buy" } map (per-item, from
// settings.item_acquisition_mode - "mine" is the implicit default for any
// name absent from it) - an item marked "buy" is deliberately NOT cascaded
// into its own ingredient requirements, the same as one with no Assembly
// Plan at all: it stays a flat named quantity in `expanded` (and out of
// `assemblyHours`), for the player to go acquire directly rather than
// build. This is checked fresh for every name encountered on every pass, so
// a Commodity that only surfaces as a NESTED ingredient of some other
// "mine" item (never appearing in the original `requirements`) still gets
// its own buy/mine decision honored the moment it's cascaded in.
//
// Returns { expanded, assemblyHours } where assemblyHours is
// { commodityName: hours|null } for every commodity that got expanded (null
// if its Assembly Plan has no known rate yet) - used by the planner to mark
// it "resolved via Assembly" instead of unresolved, and by the UI to show an
// hours-to-produce estimate against that item.
export function expandCommodities(catalog, requirements, assemblyPlans, inventory, maxPasses = 20, buyModes = null) {
  assemblyPlans = assemblyPlans || {};
  buyModes = buyModes || {};
  const expanded = { ...requirements };
  const assemblyHours = {};
  const alreadyExpandedRuns = {}; // name -> runs already cascaded, so growing demand across passes only adds the delta

  for (let pass = 0; pass < maxPasses; pass++) {
    let expandedAny = false;
    for (const name of Object.keys(expanded)) {
      const [kind] = catalog.classify(name);
      if (kind !== "unknown") continue;
      if (buyModes[name] === "buy") continue;
      const plan = assemblyPlans[name];
      if (!plan || !plan.hasRecipe()) continue;
      const have = inventory.other[name] || 0;
      const need = Math.max(0.0, expanded[name] - have);
      const runs = plan.runsFor(need);
      const prevRuns = alreadyExpandedRuns[name] || 0;
      if (runs <= prevRuns) continue;
      const deltaRuns = runs - prevRuns;
      alreadyExpandedRuns[name] = runs;
      // Each run takes one hour (see AssemblyPlan).
      assemblyHours[name] = plan.ratePerHour > 0 ? runs : null;
      for (const [inputName, qtyPerRun] of Object.entries(plan.requirements)) {
        expanded[inputName] = (expanded[inputName] || 0.0) + qtyPerRun * deltaRuns;
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
//   should already include whatever those hours' per-run inputs cascaded
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

// Scales a Blueprint's per-unit requirements by qty, or adds a flat ad-hoc
// material qty directly. Port of gui.py's _entries_to_totals. Lives here
// (rather than in tab-plan.js, its only caller until 2026-08-09) so it can
// also be imported by background.js's headless plan recalculation without
// pulling any DOM-touching UI module into the service worker context -
// this function only ever touches the plain `blueprints` map passed in,
// never the DOM.
//
// Entry kind is "blueprint" for anything saved going forward, but a build
// saved before the 2026-08-15 Recipe->Blueprint rename may still have
// entries tagged the old way ("recipe") - both are accepted here
// indefinitely so old saved builds keep working without needing a one-time
// rewrite.
export function entriesToTotals(blueprints, entries) {
  const totals = {};
  for (const [kind, name, qty] of entries) {
    if (kind === "blueprint" || kind === "recipe") {
      const blueprint = blueprints[name];
      if (!blueprint) continue;
      for (const [item, itemQty] of Object.entries(blueprint.scaled(qty))) {
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
// for the Item sources sub-category display (see tab-plan.js). Pure
// Assembly Plan multiplication all the way down (NOT netted against
// inventory at each step, unlike expandCommodities()) - `need` is already
// the outstanding amount of the item itself (netted once, by the caller),
// and this exists purely to show what building that many actually costs, in
// full - netting each intermediate ingredient against inventory too would
// just hide rows the player still needs to go mine whenever they happen to
// already have SOME (but not all) of an intermediate ingredient in stock,
// which is the opposite of "list everything that needs to be mined."
// Deliberately independent of the rest of the plan's own totals - this is
// informational attribution for ONE item, not a second pool: the real
// combined Mining/Ore-to-Mine totals (planMining() on the whole plan's
// merged requirements) remain the single source of truth for what to
// actually go mine and how many trips that takes. buyModes is threaded
// through so a nested ingredient the player separately chose "buy" for
// stops cascading here too, matching expandCommodities() itself - it shows
// up as its own flat leaf line instead of being expanded further. Runs
// expandCommodities() itself against an empty inventory (rather than a
// per-path recursive walk) because runs round up: a diamond-shaped plan -
// two ingredients both needing the same sub-assembly - must round that
// sub-assembly's COMBINED demand up to whole runs once, not once per path,
// or this breakdown would disagree with the real plan totals.
export function itemResourceBreakdown(catalog, itemName, need, assemblyPlans, buyModes, maxDepth = 20) {
  const plan = (assemblyPlans || {})[itemName];
  if (!plan || !plan.hasRecipe() || need <= 0) return [];
  const { expanded, assemblyHours } = expandCommodities(catalog, { [itemName]: need }, assemblyPlans, new Inventory(), maxDepth, buyModes);
  // Leaves only - anything that got cascaded into its own ingredients is an
  // intermediate, already represented by those ingredients.
  const totals = {};
  for (const [name, qty] of Object.entries(expanded)) {
    if (!(name in assemblyHours)) totals[name] = qty;
  }

  const rows = Object.entries(totals).map(([name, qty]) => {
    const [kind] = catalog.classify(name);
    return { name, kind, need: Math.round(qty * 10) / 10 };
  });
  rows.sort((a, b) => b.need - a.need);
  return rows;
}

// PlanResult (Ore/Material Map keys) -> the plain JSON shape the in-page
// Manifest overlay (js/overlay-manifest.js) expects, matching the old
// bridge_server.py's build_payload exactly (plus `assembly`, added later).
// Moved here alongside entriesToTotals for the same DOM-free-importability
// reason.
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
  // top of it - see renderRefinedGroups()'s wording in js/overlay-manifest.js.
  const ores = [];
  for (const [ore, toMine] of result.oreToMine.entries()) {
    if (toMine <= 0) continue;
    const trips = cargoCapacity > 0 ? Math.ceil(toMine / cargoCapacity) : 0;
    // How much of to_mine is attributable to refining - a BREAKDOWN, not an
    // additional amount on top of to_mine. Shown inline on the row itself
    // (see renderPersonalRow() in js/overlay-manifest.js) so the connection
    // to the "Refined" section below is obvious at a glance.
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
  // Assembly Plan exists at all, or the player explicitly chose "Buy" for
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
export function toStorableCorpData(catalog, assemblyPlans, oreChoices, totals, corpInventory, cargoCapacity, haveOverrides) {
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
    // commodity with no Assembly Plan) falls into "commodity" rather
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
    } else if (assemblyPlans && assemblyPlans[name]) {
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

// ---- Transfer file (Settings > Move to another browser or PC) ----
// Blueprints, assembly plans, saved builds - personal and corp alike,
// since the Corp tab tracks builds from the same `builds` store - harvester
// slots and Lexicon planet types, carried between browsers as one JSON
// file. Of `settings`, only what's set by hand travels
// (TRANSFER_SETTINGS); cargo and skills are re-read from the game. The keys
// match browser.storage.local's own, so a full Backup & restore export
// imports here too.
export const TRANSFER_FORMAT = "fsc-transfer";
export const TRANSFER_KEYS = ["blueprints", "assemblyPlans", "builds", "buildLabels", "activeBuildName", "activeCorpBuildName", "corpHaveOverrides", "harvesters", "scrapedPlanetTypes", "planetSyncMeta", "settings"];
export const TRANSFER_SETTINGS = ["max_harvesters", "ore_choices", "item_acquisition_mode", "assembler_counts"];

// Merges an imported transfer file into this browser's current data
// (`current` has the same keys) instead of replacing it, so importing into
// a browser that has already picked up a few store blueprints loses
// nothing:
// - Blueprints/assembly plans: names not already here are added. One here
//   with materials was read from the game in this browser, so it's kept;
//   one here without (only seen in a store list) gets the file's materials,
//   keeping this browser's store info.
// - Builds: each is added under its own id when free, otherwise the lowest
//   unused one (the same rule as tab-plan.js's nextBuildNumber()), with its
//   custom name carried along. A build identical to one already here (same
//   name and entries) is skipped, so importing the same file twice doesn't
//   duplicate anything.
// - Active build / active corp build: taken from the file only when none is
//   selected here.
// - Corp "Have" overrides and Lexicon planet types: added for names
//   without one here.
// - Ore choices, buy/craft modes and assembler counts: added for items
//   without one here; with
//   `replace.choices`, the file's win where both have one.
// - Harvester slots: taken from the file, with its slot count, when no slot
//   here has a resource assigned, or with `replace.harvesters` - two rosters
//   don't combine sensibly, so it's one or the other.
// transferConflicts() says which of those the player should be asked about.
// Returns { data, counts } - `data` is the full set of TRANSFER_KEYS to
// write, `counts` what was added/skipped for the status line.
function hasHarvesterAssignments(slots) {
  return (slots || []).some((slot) => slot && slot.resource);
}

// What importing `incoming` would change that the player set by hand here,
// for the Allow/Skip prompts: `harvesters` when both have an assigned
// roster and they differ (slots or slot count), `choices` listing the items
// whose ore choice or buy/craft mode differs. Missing ones are just added,
// so they aren't conflicts.
export function transferConflicts(current, incoming) {
  const here = current.settings || {};
  const there = incoming.settings || {};
  const slotsHere = (current.harvesters || []).slice(0, here.max_harvesters ?? Infinity);
  const slotsThere = (incoming.harvesters || []).slice(0, there.max_harvesters ?? Infinity);
  const harvesters =
    hasHarvesterAssignments(slotsHere) &&
    hasHarvesterAssignments(slotsThere) &&
    (JSON.stringify(slotsHere.map((s) => [s?.resource ?? null, s?.rate ?? 0])) !== JSON.stringify(slotsThere.map((s) => [s?.resource ?? null, s?.rate ?? 0])) ||
      (there.max_harvesters != null && there.max_harvesters !== here.max_harvesters));
  const choices = [];
  for (const field of ["ore_choices", "item_acquisition_mode", "assembler_counts"]) {
    const mine = here[field] || {};
    for (const [item, value] of Object.entries(there[field] || {})) {
      if (item in mine && mine[item] !== value && !choices.includes(item)) choices.push(item);
    }
  }
  return { harvesters, choices };
}

export function mergeTransferData(current, incoming, replace = {}) {
  const blueprints = { ...(current.blueprints || {}) };
  const assemblyPlans = { ...(current.assemblyPlans || {}) };
  const builds = { ...(current.builds || {}) };
  const buildLabels = { ...(current.buildLabels || {}) };
  const counts = { blueprints: 0, assemblyPlans: 0, builds: 0, buildsSkipped: 0, harvesters: 0, planetTypes: 0 };

  // Stored entries are { requirements, ... }; blueprints saved before
  // captain levels were stored are a bare { item: qty } dict (see storage.js).
  const recipeOf = (entry) => (entry && entry.requirements ? entry.requirements : entry) || {};
  const hasMaterials = (entry) => Object.values(recipeOf(entry)).some((qty) => qty > 0);
  const mergeEntries = (target, source, field) => {
    for (const [name, entry] of Object.entries(source || {})) {
      const here = target[name];
      if (!(name in target)) {
        target[name] = entry;
      } else if (!hasMaterials(here) && hasMaterials(entry)) {
        const mine = here && here.requirements ? here : {};
        const theirs = entry.requirements ? entry : { requirements: entry };
        target[name] = { ...theirs, ...mine, requirements: theirs.requirements };
        for (const [key, value] of Object.entries(theirs)) if (target[name][key] == null) target[name][key] = value;
        if (theirs.store && mine.store) target[name].store = { ...theirs.store, ...Object.fromEntries(Object.entries(mine.store).filter(([, v]) => v != null)) };
      } else {
        continue;
      }
      counts[field]++;
    }
  };
  mergeEntries(blueprints, incoming.blueprints, "blueprints");
  mergeEntries(assemblyPlans, incoming.assemblyPlans, "assemblyPlans");

  const buildKey = (label, entries) => JSON.stringify([label ?? null, entries]);
  const existing = new Map(Object.entries(builds).map(([id, entries]) => [buildKey(buildLabels[id], entries), id]));
  const idMap = {}; // incoming id -> id here
  const incomingLabels = incoming.buildLabels || {};
  const ids = Object.keys(incoming.builds || {}).sort((a, b) => Number(a) - Number(b));
  for (const id of ids) {
    const entries = incoming.builds[id];
    const label = incomingLabels[id];
    const key = buildKey(label, entries);
    if (existing.has(key)) {
      idMap[id] = existing.get(key);
      counts.buildsSkipped++;
      continue;
    }
    let newId = id;
    if (newId in builds) {
      let n = 1;
      while (String(n) in builds) n++;
      newId = String(n);
    }
    builds[newId] = entries;
    if (label) buildLabels[newId] = label;
    existing.set(key, newId);
    idMap[id] = newId;
    counts.builds++;
  }

  const settings = { ...(current.settings || {}) };
  const inSettings = incoming.settings || {};
  for (const field of ["ore_choices", "item_acquisition_mode", "assembler_counts"]) {
    if (!inSettings[field]) continue;
    settings[field] = replace.choices ? { ...(settings[field] || {}), ...inSettings[field] } : { ...inSettings[field], ...(settings[field] || {}) };
  }
  let harvesters = current.harvesters || [];
  const incomingHarvesters = incoming.harvesters || [];
  if ((replace.harvesters || !hasHarvesterAssignments(harvesters)) && hasHarvesterAssignments(incomingHarvesters)) {
    harvesters = incomingHarvesters;
    if (inSettings.max_harvesters != null) settings.max_harvesters = inSettings.max_harvesters;
    counts.harvesters = incomingHarvesters.filter((slot) => slot && slot.resource).length;
  }
  const scrapedPlanetTypes = { ...(current.scrapedPlanetTypes || {}) };
  for (const [type, entry] of Object.entries(incoming.scrapedPlanetTypes || {})) {
    if (type in scrapedPlanetTypes) continue;
    scrapedPlanetTypes[type] = entry;
    counts.planetTypes++;
  }

  const pickActive = (here, there) => (here != null && here in builds ? here : (there != null && idMap[there]) || here || null);

  return {
    data: {
      blueprints,
      assemblyPlans,
      builds,
      buildLabels,
      activeBuildName: pickActive(current.activeBuildName, incoming.activeBuildName),
      activeCorpBuildName: pickActive(current.activeCorpBuildName, incoming.activeCorpBuildName),
      corpHaveOverrides: { ...(incoming.corpHaveOverrides || {}), ...(current.corpHaveOverrides || {}) },
      harvesters,
      scrapedPlanetTypes,
      planetSyncMeta: current.planetSyncMeta || (counts.planetTypes ? incoming.planetSyncMeta || null : null),
      settings,
    },
    counts,
  };
}
