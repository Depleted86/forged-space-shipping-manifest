// Golden-master tests: asserts the JS calc engine reproduces outputs
// captured from the live Python app (models.py) exactly, for the scenarios
// in fixtures.json. This is the only oracle for plan_mining's subtle
// double-counting rules (documented in js/calc-engine.js) - keep these
// passing before ever touching the Python originals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Catalog } from "../js/catalog.js";
import { Inventory, planMining, expandCommodities, findConsolidationOpportunities, harvesterTotals, pendingRefiningOutput, AssemblyRecipe } from "../js/calc-engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, "fixtures.json"), "utf8"));

function oreChoicesFromNames(catalog, byName) {
  const out = {};
  for (const [item, oreName] of Object.entries(byName || {})) {
    out[item] = catalog.findOre(oreName);
  }
  return out;
}

// Mirrors the Python harness's serialize_plan_result: Map<Ore|Material, x>
// -> { name: x }, so it can be compared directly against the JSON fixture.
function serializePlanResult(result) {
  const mapToNames = (map) => {
    const out = {};
    for (const [k, v] of map.entries()) out[k.name] = v;
    return out;
  };
  const materialOreChoiceNames = {};
  for (const [k, v] of result.materialOreChoice.entries()) materialOreChoiceNames[k] = v.name;

  return {
    item_need: result.itemNeed,
    item_kind: result.itemKind,
    material_ore_choice: materialOreChoiceNames,
    ore_target_refined: mapToNames(result.oreTargetRefined),
    ore_direct_raw: mapToNames(result.oreDirectRaw),
    ore_raw_needed: mapToNames(result.oreRawNeeded),
    ore_to_mine: mapToNames(result.oreToMine),
    planet_hint: result.planetHint,
    harvest_rate: result.harvestRate,
    harvest_hours: result.harvestHours,
    unresolved: result.unresolved,
    pending_credit: result.pendingCredit,
    pending_batches: result.pendingBatches,
    assembly_hours: result.assemblyHours,
    total_raw_to_mine: result.totalRawToMine,
    trips: result.trips,
  };
}

test("scenario A: empty inventory, mixed item kinds, ore consolidation via max()", () => {
  const fx = fixtures.scenario_a_empty_inventory_consolidation;
  const catalog = new Catalog();
  const inventory = new Inventory();
  const oreChoices = oreChoicesFromNames(catalog, fx.ore_choices);
  const result = planMining(catalog, fx.requirements, inventory, oreChoices, fx.cargo_capacity, fx.harvester_rates, fx.pending_batches, fx.assembly_hours);
  assert.deepEqual(serializePlanResult(result), fx.expected);
});

test("scenario B: partial inventory + pending refining credit", () => {
  const fx = fixtures.scenario_b_partial_inventory_pending_credit;
  const catalog = new Catalog();
  const inventory = new Inventory();
  for (const [oreName, qty] of Object.entries(fx.inventory.raw_ore)) {
    inventory.rawOre.set(catalog.findOre(oreName), qty);
  }
  for (const [matName, qty] of Object.entries(fx.inventory.refined)) {
    inventory.refined.set(catalog.findMaterial(matName), qty);
  }
  inventory.other = { ...fx.inventory.other };

  const oreChoices = oreChoicesFromNames(catalog, fx.ore_choices);
  const result = planMining(catalog, fx.requirements, inventory, oreChoices, fx.cargo_capacity, fx.harvester_rates, fx.pending_batches, fx.assembly_hours);
  assert.deepEqual(serializePlanResult(result), fx.expected);

  const bonus = pendingRefiningOutput(catalog, fx.pending_batches);
  assert.deepEqual(bonus, fx.expected_pending_bonus);
});

test("scenario C: multi-build consolidation opportunities", () => {
  const fx = fixtures.scenario_c_consolidation_opportunities;
  const catalog = new Catalog();
  const neededMaterials = {};
  for (const [name, builds] of Object.entries(fx.needed_materials)) {
    neededMaterials[name] = new Set(builds);
  }
  const currentOreChoices = oreChoicesFromNames(catalog, fx.current_ore_choices);
  const opportunities = findConsolidationOpportunities(catalog, neededMaterials, currentOreChoices);
  const actual = opportunities.map((s) => ({
    ore: s.ore.name,
    covered: s.covered.map((m) => m.name).sort(),
    builds: [...s.builds].sort(),
  }));
  assert.deepEqual(actual, fx.expected);
});

test("scenario D: assembly cascade (two-level expand_commodities) + full plan_mining pipeline", () => {
  const fx = fixtures.scenario_d_assembly_cascade;
  const catalog = new Catalog();
  const assemblyRecipes = {};
  for (const [output, def] of Object.entries(fx.assembly_recipes)) {
    const recipe = new AssemblyRecipe(output, def.rate_per_hour);
    for (const [item, qty] of Object.entries(def.requirements)) recipe.setRequirement(item, qty);
    assemblyRecipes[output] = recipe;
  }
  const inventory = new Inventory();
  inventory.other = { ...fx.inventory_other };

  const { expanded, assemblyHours } = expandCommodities(catalog, fx.requirements, assemblyRecipes, inventory);
  assert.deepEqual(expanded, fx.expected_expanded);
  assert.deepEqual(assemblyHours, fx.expected_assembly_hours);

  const oreChoices = oreChoicesFromNames(catalog, fx.ore_choices);
  const result = planMining(catalog, expanded, inventory, oreChoices, fx.cargo_capacity, null, null, assemblyHours);
  assert.deepEqual(serializePlanResult(result), fx.expected_plan);
});

test("scenario E: zero cargo capacity -> trips is 0, not Infinity/NaN", () => {
  const fx = fixtures.scenario_e_zero_cargo_capacity;
  const catalog = new Catalog();
  const inventory = new Inventory();
  const oreChoices = oreChoicesFromNames(catalog, fx.ore_choices);
  const result = planMining(catalog, fx.requirements, inventory, oreChoices, fx.cargo_capacity);
  assert.deepEqual(serializePlanResult(result), fx.expected);
  assert.equal(result.trips, 0);
});

test("scenario F: material with no ore_choices entry falls back to sources[0]", () => {
  const fx = fixtures.scenario_f_fallback_to_first_source;
  const catalog = new Catalog();
  const inventory = new Inventory();
  const result = planMining(catalog, fx.requirements, inventory, {}, fx.cargo_capacity);
  assert.deepEqual(serializePlanResult(result), fx.expected);
  assert.equal(result.materialOreChoice.get("Iron Ore").name, fx.expected_fallback_ore);
});

test("scenario G: harvesterTotals sums rate per resource, skips idle slots", () => {
  const fx = fixtures.scenario_g_harvester_totals;
  assert.deepEqual(harvesterTotals(fx.slots), fx.expected);
});
