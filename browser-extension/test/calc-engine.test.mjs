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
import { Inventory, planMining, expandCommodities, findConsolidationOpportunities, harvesterTotals, pendingRefiningOutput, AssemblyPlan, itemResourceBreakdown, mergeTransferData, transferConflicts } from "../js/calc-engine.js";

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
  const assemblyPlans = {};
  for (const [output, def] of Object.entries(fx.assembly_recipes)) {
    const plan = new AssemblyPlan(output, def.rate_per_hour);
    for (const [item, qty] of Object.entries(def.requirements)) plan.setRequirement(item, qty);
    assemblyPlans[output] = plan;
  }
  const inventory = new Inventory();
  inventory.other = { ...fx.inventory_other };

  const { expanded, assemblyHours } = expandCommodities(catalog, fx.requirements, assemblyPlans, inventory);
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

// Assembly runs: the game's Rate (units/hour) is the output of one run, and
// the listed ingredients are the cost of that one run - not per unit.
function circuitBoardPlans() {
  const boards = new AssemblyPlan("Circuit Boards", 5);
  boards.setRequirement("Copper Ore", 1);
  const panel = new AssemblyPlan("Control Panel", 1);
  panel.setRequirement("Circuit Boards", 3);
  const relay = new AssemblyPlan("Relay", 1);
  relay.setRequirement("Circuit Boards", 3);
  return { "Circuit Boards": boards, "Control Panel": panel, Relay: relay };
}

test("assembly runs: 5 Circuit Boards = 1 run's ingredients, 6 rounds up to 2 runs", () => {
  const catalog = new Catalog();
  const plans = circuitBoardPlans();
  let { expanded, assemblyHours } = expandCommodities(catalog, { "Circuit Boards": 5 }, plans, new Inventory());
  assert.equal(expanded["Copper Ore"], 1);
  assert.equal(assemblyHours["Circuit Boards"], 1);
  ({ expanded, assemblyHours } = expandCommodities(catalog, { "Circuit Boards": 6 }, plans, new Inventory()));
  assert.equal(expanded["Copper Ore"], 2);
  assert.equal(assemblyHours["Circuit Boards"], 2);
});

test("assembly runs: shared sub-assembly rounds its combined demand once, in plan and breakdown alike", () => {
  const catalog = new Catalog();
  const plans = circuitBoardPlans();
  // 2 boards via each path = 4 total -> 1 run. Rounding per path instead
  // would wrongly give ceil(2/5) + ceil(2/5) = 2 runs.
  plans["Control Panel"].setRequirement("Circuit Boards", 2);
  plans.Relay.setRequirement("Circuit Boards", 2);
  const console_ = new AssemblyPlan("Console", 1);
  console_.setRequirement("Control Panel", 1);
  console_.setRequirement("Relay", 1);
  plans.Console = console_;

  const { expanded } = expandCommodities(catalog, { Console: 1 }, plans, new Inventory());
  assert.equal(expanded["Circuit Boards"], 4);
  assert.equal(expanded["Copper Ore"], 1);
  const rows = itemResourceBreakdown(catalog, "Console", 1, plans, {});
  assert.deepEqual(rows.map((r) => [r.name, r.need]), [["Copper Ore", 1]]);
});

test("R&D-only plan (no recipe yet) stays a flat need instead of expanding to nothing", () => {
  const catalog = new Catalog();
  const plan = new AssemblyPlan("Platinum Chips", 1);
  plan.research = { level: 0, skillRequired: 11, progress: null, active: false };
  assert.equal(plan.isResearchLocked(), true);
  assert.equal(plan.hasRecipe(), false);
  const { expanded, assemblyHours } = expandCommodities(catalog, { "Platinum Chips": 27 }, { "Platinum Chips": plan }, new Inventory());
  assert.deepEqual(expanded, { "Platinum Chips": 27 });
  assert.deepEqual(assemblyHours, {});
  assert.deepEqual(itemResourceBreakdown(catalog, "Platinum Chips", 27, { "Platinum Chips": plan }, {}), []);
});

test("mergeTransferData: into an empty browser, everything carries over", () => {
  const incoming = {
    blueprints: { "Defense Shield Z1": { requirements: { Kelsalt: 10 } } },
    assemblyPlans: { "Graviton Emitter": { rate_per_hour: 2, requirements: { "Inert Gas": 5 } } },
    builds: { 1: [["blueprint", "Defense Shield Z1", 2]], 2: [["item", "Kelsalt", 500]] },
    buildLabels: { 2: "Outpost Run" },
    activeBuildName: "1",
    activeCorpBuildName: "2",
    corpHaveOverrides: { Kelsalt: 100 },
  };
  const { data, counts } = mergeTransferData({}, incoming);
  assert.deepEqual(counts, { blueprints: 1, assemblyPlans: 1, builds: 2, buildsSkipped: 0, harvesters: 0, planetTypes: 0 });
  assert.deepEqual(data.builds, incoming.builds);
  assert.deepEqual(data.buildLabels, { 2: "Outpost Run" });
  assert.equal(data.activeBuildName, "1");
  assert.equal(data.activeCorpBuildName, "2");
  assert.deepEqual(data.corpHaveOverrides, { Kelsalt: 100 });
});

test("mergeTransferData: keeps what's here, renumbers clashing builds, skips duplicates", () => {
  const current = {
    blueprints: { "Defense Shield Z1": { requirements: { Kelsalt: 12 } } },
    builds: { 1: [["item", "Jasper Ore", 50]], 2: [["item", "Kelsalt", 500]] },
    buildLabels: { 2: "Outpost Run" },
    activeBuildName: "1",
    activeCorpBuildName: null,
    corpHaveOverrides: { Kelsalt: 7 },
  };
  const incoming = {
    blueprints: { "Defense Shield Z1": { requirements: { Kelsalt: 10 } }, "Civilian Basic Shield Generator": { requirements: { Kelsalt: 3 } } },
    builds: { 1: [["blueprint", "Defense Shield Z1", 2]], 3: [["item", "Kelsalt", 500]] },
    buildLabels: { 1: "Shields", 3: "Outpost Run" },
    activeBuildName: "3",
    activeCorpBuildName: "1",
    corpHaveOverrides: { Kelsalt: 100, "Inert Gas": 4 },
  };
  const { data, counts } = mergeTransferData(current, incoming);
  assert.deepEqual(counts, { blueprints: 1, assemblyPlans: 0, builds: 1, buildsSkipped: 1, harvesters: 0, planetTypes: 0 });
  assert.deepEqual(data.blueprints["Defense Shield Z1"], { requirements: { Kelsalt: 12 } });
  assert.ok(data.blueprints["Civilian Basic Shield Generator"]);
  // Incoming build 1 clashes with the one here, so it lands on the lowest free id.
  assert.deepEqual(data.builds["3"], [["blueprint", "Defense Shield Z1", 2]]);
  assert.equal(data.buildLabels["3"], "Shields");
  assert.equal(Object.keys(data.builds).length, 3);
  assert.equal(data.activeBuildName, "1");
  assert.equal(data.activeCorpBuildName, "3");
  assert.deepEqual(data.corpHaveOverrides, { Kelsalt: 7, "Inert Gas": 4 });
  // Importing the same file again adds nothing.
  const again = mergeTransferData(data, incoming);
  assert.deepEqual(again.counts, { blueprints: 0, assemblyPlans: 0, builds: 0, buildsSkipped: 2, harvesters: 0, planetTypes: 0 });
});

test("mergeTransferData: harvester roster, planet types and hand-set settings", () => {
  const incoming = {
    harvesters: [{ resource: "Zephyr Flux", rate: 40 }, { resource: null, rate: 0 }, { resource: "Terraglass", rate: 30 }],
    scrapedPlanetTypes: { Ice: { resources: ["Glacite Ore"] }, Lava: { resources: ["Magmite"] } },
    planetSyncMeta: { syncedAt: "2026-11-01T00:00:00Z", count: 2 },
    settings: { max_harvesters: 3, ore_choices: { "Kallycite Ore": "Nylonite", Iron: "Hematite" }, item_acquisition_mode: { Gears: "buy" }, cargo_capacity: 999 },
  };
  // A fresh browser: empty roster of 4, one planet type already read, its own ore choice and cargo.
  const current = {
    harvesters: [{ resource: null, rate: 0 }, { resource: null, rate: 0 }, { resource: null, rate: 0 }, { resource: null, rate: 0 }],
    scrapedPlanetTypes: { Ice: { resources: ["Glacite Ore", "Frostite"] } },
    settings: { max_harvesters: 4, ore_choices: { Iron: "Magnetite" }, cargo_capacity: 60 },
  };
  const { data, counts } = mergeTransferData(current, incoming);
  assert.equal(counts.harvesters, 2);
  assert.equal(counts.planetTypes, 1);
  assert.deepEqual(data.harvesters, incoming.harvesters);
  assert.equal(data.settings.max_harvesters, 3);
  assert.equal(data.settings.cargo_capacity, 60);
  assert.deepEqual(data.settings.ore_choices, { "Kallycite Ore": "Nylonite", Iron: "Magnetite" });
  assert.deepEqual(data.settings.item_acquisition_mode, { Gears: "buy" });
  assert.deepEqual(data.scrapedPlanetTypes.Ice, { resources: ["Glacite Ore", "Frostite"] });
  assert.ok(data.scrapedPlanetTypes.Lava);
  assert.deepEqual(data.planetSyncMeta, incoming.planetSyncMeta);
  // A roster already in use here is left alone.
  const kept = mergeTransferData({ harvesters: [{ resource: "White Iron", rate: 40 }], settings: { max_harvesters: 1 } }, incoming);
  assert.equal(kept.counts.harvesters, 0);
  assert.deepEqual(kept.data.harvesters, [{ resource: "White Iron", rate: 40 }]);
  assert.equal(kept.data.settings.max_harvesters, 1);
});

test("transferConflicts + replace: harvester roster and ore/buy choices", () => {
  const current = {
    harvesters: [{ resource: "White Iron", rate: 40 }, { resource: null, rate: 0 }],
    settings: { max_harvesters: 2, ore_choices: { Iron: "Magnetite", Copper: "Malachite" }, item_acquisition_mode: { Gears: "craft" } },
  };
  const incoming = {
    harvesters: [{ resource: "Zephyr Flux", rate: 40 }, { resource: "Terraglass", rate: 30 }, { resource: null, rate: 0 }],
    settings: { max_harvesters: 3, ore_choices: { Iron: "Hematite", Copper: "Malachite", Tin: "Cassiterite" }, item_acquisition_mode: { Gears: "buy" } },
  };
  assert.deepEqual(transferConflicts(current, incoming), { harvesters: true, choices: ["Iron", "Gears"] });
  // Same roster and choices: nothing to ask.
  assert.deepEqual(transferConflicts(current, current), { harvesters: false, choices: [] });
  // Empty roster here: no question, the file's is just used.
  assert.equal(transferConflicts({ harvesters: [], settings: {} }, incoming).harvesters, false);

  const skipped = mergeTransferData(current, incoming).data;
  assert.deepEqual(skipped.harvesters, current.harvesters);
  assert.equal(skipped.settings.max_harvesters, 2);
  assert.deepEqual(skipped.settings.ore_choices, { Iron: "Magnetite", Copper: "Malachite", Tin: "Cassiterite" });
  assert.equal(skipped.settings.item_acquisition_mode.Gears, "craft");

  const allowed = mergeTransferData(current, incoming, { harvesters: true, choices: true });
  assert.deepEqual(allowed.data.harvesters, incoming.harvesters);
  assert.equal(allowed.data.settings.max_harvesters, 3);
  assert.equal(allowed.counts.harvesters, 2);
  assert.deepEqual(allowed.data.settings.ore_choices, { Iron: "Hematite", Copper: "Malachite", Tin: "Cassiterite" });
  assert.equal(allowed.data.settings.item_acquisition_mode.Gears, "buy");
});

test("mergeTransferData: fills materials for blueprints only seen in a store list", () => {
  const current = {
    blueprints: {
      "Antimatter Chamber": { requirements: {}, captain_level: null, store: { storeName: "Blueprint Store", owned: true, price: 900, buildCost: null } },
      Hawk: { requirements: { Iron: 12 }, captain_level: 5, store: { storeName: "Starship Blueprint Store" } },
    },
    assemblyPlans: { "Circuit Boards": { rate_per_hour: 5, requirements: {}, captain_level: null, research: null } },
  };
  const incoming = {
    blueprints: {
      "Antimatter Chamber": { requirements: { Kelsalt: 40, "Inert Gas": 10 }, captain_level: 12, store: { storeName: "Blueprint Store", owned: false, price: 1000, buildCost: 5000 } },
      Hawk: { requirements: { Iron: 10 }, captain_level: 5, store: {} },
      Legacy: { Copper: 3 },
    },
    assemblyPlans: { "Circuit Boards": { rate_per_hour: 5, requirements: { Copper: 2 }, captain_level: 3, research: null } },
  };
  const { data, counts } = mergeTransferData(current, incoming);
  assert.equal(counts.blueprints, 2);
  assert.equal(counts.assemblyPlans, 1);
  const ac = data.blueprints["Antimatter Chamber"];
  assert.deepEqual(ac.requirements, { Kelsalt: 40, "Inert Gas": 10 });
  assert.equal(ac.captain_level, 12);
  // This browser's live store info wins; gaps are filled from the file.
  assert.equal(ac.store.owned, true);
  assert.equal(ac.store.price, 900);
  assert.equal(ac.store.buildCost, 5000);
  assert.deepEqual(data.blueprints.Hawk.requirements, { Iron: 12 });
  assert.deepEqual(data.blueprints.Legacy, { Copper: 3 });
  assert.deepEqual(data.assemblyPlans["Circuit Boards"].requirements, { Copper: 2 });
  assert.equal(data.assemblyPlans["Circuit Boards"].captain_level, 3);
});
