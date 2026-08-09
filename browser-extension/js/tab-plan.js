// Plan a Build tab - the most complex tab. Port of gui.py's _build_plan_tab
// and its ~30 handler methods: multi-build tracking with auto-numbered
// reused-gap IDs, a two-stage requirements pipeline
// (entriesToTotals -> expandCommodities), single-build vs all-builds
// calculation modes (the latter enabling cross-build ore consolidation
// suggestions), a refine-batches modal with live projected-output math, and
// the result tables. On every successful calculation the result is written
// to the `toMineData` storage key - this replaces both
// app.last_plan_result (Python, in-memory only) and bridge_server.py's GET
// handler, since the toolbar popup (popup.js) now reads that key directly.

import { el, clear } from "./dom-helpers.js";
import { planMining, expandCommodities, findConsolidationOpportunities, harvesterTotals, pendingRefiningOutput } from "./calc-engine.js";
import * as storage from "./storage.js";
import { applyLocalPendingDeduction } from "./tab-inventory.js";

function formatHours(hours) {
  return `${hours.toFixed(1)}h (${(hours / 24).toFixed(1)} days)`;
}

// Scales a Recipe's per-unit requirements by qty, or adds a flat ad-hoc
// material qty directly. Shared by single-build and all-builds paths, port
// of gui.py's _entries_to_totals.
export function entriesToTotals(app, entries) {
  const totals = {};
  for (const [kind, name, qty] of entries) {
    if (kind === "recipe") {
      const recipe = app.recipes[name];
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

// list of [oreName, batches] for every pending-refining ore whose outputs
// include `materialName`. Port of gui.py's _pending_credit_contributors.
export function pendingCreditContributors(app, materialName) {
  const out = [];
  for (const [oreName, batches] of Object.entries(app.pendingRefining)) {
    if (batches <= 0) continue;
    const ore = app.catalog.findOre(oreName);
    if (ore && ore.outputs.some((m) => m.name === materialName)) out.push([oreName, batches]);
  }
  return out;
}

// PlanResult (Ore/Material Map keys) -> the plain JSON shape popup.js's
// To-Mine list expects, matching bridge_server.py's build_payload exactly.
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

export function initPlanTab(app, container) {
  let planEntries = []; // [[kind, name, qty], ...] - scratch list, tied to active build
  let planSourceSelects = {}; // itemName -> <select> element (material source choice)

  // ============================ Build selector ============================
  const buildSelect = el("select", {}, [el("option", { value: "", text: "(unsaved plan)" })]);
  const buildStatus = el("div", { class: "status-text" });

  function refreshBuildCombo() {
    clear(buildSelect);
    buildSelect.appendChild(el("option", { value: "", text: "(unsaved plan)" }));
    for (const name of Object.keys(app.builds).sort((a, b) => Number(a) - Number(b))) {
      buildSelect.appendChild(el("option", { value: name, text: `Build ${name}`, selected: name === app.activeBuildName ? "" : undefined }));
    }
    buildSelect.value = app.activeBuildName || "";
  }

  function nextBuildNumber() {
    const used = new Set(Object.keys(app.builds).map(Number).filter((n) => Number.isInteger(n)));
    let n = 1;
    while (used.has(n)) n++;
    return String(n);
  }

  async function saveActiveBuild() {
    if (!app.activeBuildName) return;
    app.builds[app.activeBuildName] = planEntries.map((e) => [...e]);
    await storage.saveBuilds(app.builds);
  }

  async function newBuild() {
    const name = nextBuildNumber();
    app.builds[name] = [];
    await storage.saveBuilds(app.builds);
    refreshBuildCombo();
    await loadBuild(name);
  }

  async function deleteBuild() {
    if (!app.activeBuildName) return;
    if (!confirm(`Delete build "${app.activeBuildName}"? This does not touch pending refining or inventory.`)) return;
    delete app.builds[app.activeBuildName];
    await storage.saveBuilds(app.builds);
    app.activeBuildName = null;
    refreshBuildCombo();
    buildStatus.textContent = "No build selected - changes here won't be saved for later.";
    await clearPlan();
  }

  async function markBuildComplete() {
    if (!app.activeBuildName) return;
    const result = app.lastPlanResult;
    let involved = new Set();
    if (result) {
      involved = new Set([...result.oreTargetRefined.keys(), ...result.oreDirectRaw.keys()]);
      for (const [item, need] of Object.entries(result.itemNeed)) {
        if ((result.itemKind[item] !== "material") || need > 0) continue;
        for (const [oreName] of pendingCreditContributors(app, item)) {
          const ore = app.catalog.findOre(oreName);
          if (ore) involved.add(ore);
        }
      }
    }
    const names = [...involved].map((o) => o.name);
    const msg = names.length
      ? `Mark build "${app.activeBuildName}" complete? This clears pending refining batches for: ${names.join(", ")}.`
      : `Mark build "${app.activeBuildName}" complete? No recent calculation exists, so nothing will be auto-cleared from pending refining.`;
    if (!confirm(msg)) return;

    for (const ore of involved) delete app.pendingRefining[ore.name];
    await storage.savePendingRefining(app.pendingRefining);
    if (app.refreshHooks.inventory) app.refreshHooks.inventory();

    delete app.builds[app.activeBuildName];
    await storage.saveBuilds(app.builds);
    app.activeBuildName = null;
    refreshBuildCombo();
    buildStatus.textContent = "No build selected - changes here won't be saved for later.";
    await clearPlan();
  }

  async function loadBuild(name) {
    if (!name || !app.builds[name]) return;
    app.activeBuildName = name;
    planEntries = app.builds[name].map((e) => [...e]);
    buildSelect.value = name;
    buildStatus.textContent = `Editing build "${name}" - changes save automatically.`;
    renderEntriesList();
    clear(resultMatTbody);
    clear(resultOreTbody);
    summaryText.textContent = "";
    missingAssemblyWarning.textContent = "";
    app.lastPlanResult = null;
    await buildRequirements();
    if (Object.keys(app.planBaseRequirements).length > 0) await calculatePlan();
  }

  buildSelect.addEventListener("change", () => {
    if (buildSelect.value) loadBuild(buildSelect.value);
  });

  // ============================ Sync status row ============================
  const syncStatus = el("div", { class: "status-text" });
  async function renderSyncStatus() {
    const meta = await storage.loadInventorySyncStatus();
    syncStatus.textContent = meta
      ? `Inventory last synced ${new Date(meta.syncedAt).toLocaleTimeString()} — ${meta.matched} matched, ${meta.unmatched} other items.`
      : "No inventory sync yet - open the storage screen in-game to sync.";
  }

  // ============================ Add-to-plan controls ============================
  const recipeSelect = el("select", {});
  const recipeQtyInput = el("input", { type: "text", value: "1", style: "width:70px" });
  function refreshPlanRecipeCombo() {
    clear(recipeSelect);
    for (const name of Object.keys(app.recipes).sort()) recipeSelect.appendChild(el("option", { value: name, text: name }));
  }

  async function addRecipeToPlan() {
    const name = recipeSelect.value;
    const qty = parseFloat(recipeQtyInput.value);
    if (!name || Number.isNaN(qty)) {
      alert("Choose a recipe and enter a numeric quantity.");
      return;
    }
    planEntries.push(["recipe", name, qty]);
    renderEntriesList();
    await saveActiveBuild();
  }

  const itemDatalistId = "plan-item-datalist";
  const itemDatalist = el("datalist", { id: itemDatalistId }, app.catalog.allItemNames().map((n) => el("option", { value: n })));
  const materialInput = el("input", { type: "text", list: itemDatalistId, placeholder: "Item name" });
  const materialQtyInput = el("input", { type: "text", value: "0", style: "width:70px" });

  async function addMaterialToPlan() {
    const name = materialInput.value.trim();
    const qty = parseFloat(materialQtyInput.value);
    if (!name || Number.isNaN(qty)) {
      alert("Enter an item name and a numeric quantity.");
      return;
    }
    planEntries.push(["material", name, qty]);
    renderEntriesList();
    await saveActiveBuild();
  }

  // ============================ Plan items list ============================
  const entriesSelect = el("select", { size: "6", class: "list-select" });
  function renderEntriesList() {
    clear(entriesSelect);
    planEntries.forEach(([kind, name, qty], i) => {
      const label = kind === "recipe" ? `Recipe: ${name} x${qty}` : `Material: ${name} x${qty}`;
      entriesSelect.appendChild(el("option", { value: String(i), text: label }));
    });
  }

  async function removePlanItem() {
    const idx = entriesSelect.value;
    if (idx === "") return;
    planEntries.splice(Number(idx), 1);
    renderEntriesList();
    await saveActiveBuild();
  }

  async function clearPlan() {
    planEntries = [];
    renderEntriesList();
    await saveActiveBuild();
    clear(sourcesContainer);
    planSourceSelects = {};
    app.planBaseRequirements = {};
    app.planRequirements = {};
    clear(resultMatTbody);
    clear(resultOreTbody);
    summaryText.textContent = "";
    missingAssemblyWarning.textContent = "";
    app.lastPlanResult = null;
    // Without this, the toolbar's "To Mine" popup keeps showing whatever
    // was last calculated even after the build it came from was deleted,
    // completed, or explicitly cleared here - stale, potentially
    // mine-the-wrong-thing-misleading data with nothing on screen
    // indicating it's out of date.
    await storage.saveToMineData({ available: false });
  }

  // ============================ Item sources ============================
  const sourcesContainer = el("div");

  async function buildRequirements() {
    const totals = entriesToTotals(app, planEntries);
    app.planBaseRequirements = totals;
    const { expanded, assemblyHours } = expandCommodities(app.catalog, totals, app.assemblyRecipes, app.inventory);
    app.planRequirements = expanded;

    clear(sourcesContainer);
    planSourceSelects = {};

    const pendingBonus = pendingRefiningOutput(app.catalog, app.pendingRefining);
    const names = Object.keys(expanded).sort();
    let anyShown = false;
    for (const name of names) {
      const [kind, obj] = app.catalog.classify(name);
      const have = kind === "material" ? app.inventory.refinedQty(obj) : kind === "ore" ? app.inventory.rawQty(obj) : app.inventory.other[name] || 0;
      const pendingCredit = kind === "material" ? pendingBonus[name] || 0 : 0;
      const need = Math.max(0, expanded[name] - have - pendingCredit);
      if (need <= 0) continue;
      anyShown = true;

      let row;
      if (kind === "material") {
        const select = el(
          "select",
          {},
          obj.sources.map((o) => el("option", { value: o.name, text: o.name }))
        );
        const savedChoice = app.settings.ore_choices?.[name];
        select.value = obj.sources.some((o) => o.name === savedChoice) ? savedChoice : obj.sources[0]?.name || "";
        planSourceSelects[name] = select;
        row = el("div", { class: "field-row" }, [
          el("label", { text: `${name} (refined, need ${need.toFixed(1)}${pendingCredit > 0 ? `, +${pendingCredit} pending` : ""}):` }),
          select,
        ]);
      } else if (kind === "ore") {
        row = el("div", { class: "field-row" }, [el("label", { text: `${name} (raw ore, used directly, need ${need.toFixed(1)})` })]);
      } else if (kind === "planet_resource") {
        const rate = (harvesterTotals(app.harvesterSlots)[name]) || 0;
        const hoursText = rate > 0 ? formatHours(need / rate) : "no harvesters assigned";
        row = el("div", { class: "field-row" }, [
          el("label", { class: "status-ok", text: `${name} — found on: ${obj.planetTypes.map((p) => p.name).join(", ")} — need ${need.toFixed(1)} — ${hoursText}` }),
        ]);
      } else if (name in assemblyHours) {
        const hours = assemblyHours[name];
        const hoursText = hours !== null ? formatHours(hours) : "rate unknown";
        row = el("div", { class: "field-row" }, [el("label", { class: "status-ok", text: `${name} (Assembly) — need ${need.toFixed(1)} — ${hoursText}` })]);
      } else {
        row = el("div", { class: "field-row" }, [
          el("label", { class: "status-warn", text: `${name} (commodity, need ${need.toFixed(1)}) — no known ore/planet/assembly source, tracked from inventory only` }),
        ]);
      }
      sourcesContainer.appendChild(row);
    }
    if (!anyShown) {
      sourcesContainer.appendChild(el("div", { class: "status-ok", text: "Nothing needed beyond what's already in inventory." }));
    }
  }

  // ============================ Calculate ============================
  const cargoInput = el("input", { type: "text", value: String(app.settings.cargo_capacity) });

  const resultMatTbody = el("tbody");
  const resultMatTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Item", "Kind", "Need", "Have", "Pending", "Still Need", "Source"].map((h) => el("th", { text: h })))]),
    resultMatTbody,
  ]);

  const resultOreTbody = el("tbody");
  const resultOreTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Ore", "Law", "Build", "Raw Needed", "Stored", "Pending Batches", "To Mine", "Trips", "Value (cr)"].map((h) => el("th", { text: h })))]),
    resultOreTbody,
  ]);

  const missingAssemblyWarning = el("div", { class: "status-warn" });
  const summaryText = el("div", { class: "summary-text" });
  const pendingBatchesForOreInput = el("input", { type: "text", value: "0", style: "width:70px" });
  let selectedOreForPending = null;

  function sourceLabelFor(result, name, kind, obj) {
    if (result.materialOreChoice.has(name)) return result.materialOreChoice.get(name).name;
    if (kind === "ore") return "(direct)";
    if (kind === "planet_resource") {
      const hours = result.harvestHours[name];
      const rate = result.harvestRate[name] || 0;
      const hoursText = hours !== null && hours !== undefined ? formatHours(hours) : "no harvesters assigned";
      return `${(obj.planetTypes || []).map((p) => p.name).join(", ")} (${rate}/hr, ${hoursText})`;
    }
    if (name in result.assemblyHours) {
      const h = result.assemblyHours[name];
      return `Assembly (${h !== null ? h.toFixed(1) + "h" : "rate unknown"})`;
    }
    if (name in result.unresolved) return "(no known source)";
    return "-";
  }

  function renderItemsNeeded(requirements, result) {
    clear(resultMatTbody);
    for (const name of Object.keys(requirements).sort()) {
      const [kind, obj] = app.catalog.classify(name);
      const have = kind === "material" ? app.inventory.refinedQty(obj) : kind === "ore" ? app.inventory.rawQty(obj) : app.inventory.other[name] || 0;
      const pending = result.pendingCredit[name] || 0;
      const stillNeed = result.itemNeed[name] || 0;
      const source = sourceLabelFor(result, name, kind, obj);
      let displayName = name;
      if (kind === "unknown" && name in result.assemblyHours) displayName = `${name} (Assembly)`;

      const row = el("tr", { "data-item": name }, [
        el("td", { text: displayName }),
        el("td", { text: app.kindLabel(name) }),
        el("td", { text: String(requirements[name]) }),
        el("td", { text: String(have) }),
        el("td", { text: String(pending) }),
        el("td", { text: stillNeed.toFixed(1) }),
        el("td", { text: source }),
      ]);
      row.addEventListener("click", () => {
        for (const r of resultMatTbody.querySelectorAll("tr")) r.classList.remove("selected");
        row.classList.add("selected");
      });
      resultMatTbody.appendChild(row);
    }
  }

  function oreBuildLabels(result, contributors) {
    const labels = new Map();
    if (!contributors) return labels;
    const addAll = (ore, itemName) => {
      const builds = contributors[itemName];
      if (!builds) return;
      if (!labels.has(ore)) labels.set(ore, new Set());
      for (const b of builds) labels.get(ore).add(b);
    };
    for (const [item, ore] of result.materialOreChoice.entries()) addAll(ore, item);
    for (const [ore] of result.oreDirectRaw.entries()) addAll(ore, ore.name);
    return labels;
  }

  function renderOreToMine(result, cargoCapacity, contributors, fallbackLabel) {
    clear(resultOreTbody);
    const labels = oreBuildLabels(result, contributors);
    let totalValue = 0;
    const entries = [...result.oreToMine.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ore, toMine] of entries) {
      const batches = app.pendingRefining[ore.name] || 0;
      const trips = cargoCapacity > 0 ? Math.ceil(toMine / cargoCapacity) : 0;
      const value = toMine * ore.value;
      totalValue += value;
      const buildLabel = labels.has(ore) ? [...labels.get(ore)].sort().join(", ") : fallbackLabel;
      const row = el("tr", { "data-ore": ore.name }, [
        el("td", { text: ore.name }),
        el("td", { text: String(ore.law) }),
        el("td", { text: buildLabel }),
        el("td", { text: (result.oreRawNeeded.get(ore) || 0).toFixed(1) }),
        el("td", { text: String(app.inventory.rawQty(ore)) }),
        el("td", { text: String(batches) }),
        el("td", { text: toMine.toFixed(1) }),
        el("td", { text: String(trips) }),
        el("td", { text: value.toFixed(0) }),
      ]);
      row.addEventListener("click", () => {
        for (const r of resultOreTbody.querySelectorAll("tr")) r.classList.remove("selected");
        row.classList.add("selected");
        selectedOreForPending = ore.name;
        pendingBatchesForOreInput.value = String(app.pendingRefining[ore.name] || 0);
      });
      resultOreTbody.appendChild(row);
    }
    return totalValue;
  }

  function updateMissingAssemblyWarning(result) {
    const names = Object.keys(result.unresolved).filter((n) => app.catalog.classify(n)[0] === "unknown");
    missingAssemblyWarning.textContent = names.length
      ? `${names.length} commodity item(s) have no known source: ${names.join(", ")}`
      : "";
  }

  async function calculatePlan() {
    if (Object.keys(app.planBaseRequirements).length === 0) {
      alert("Click 'Build Requirements' first.");
      return;
    }
    const cargoCapacity = parseFloat(cargoInput.value);
    if (Number.isNaN(cargoCapacity) || cargoCapacity <= 0) {
      alert("Cargo capacity must be a positive number.");
      return;
    }

    const { expanded, assemblyHours } = expandCommodities(app.catalog, app.planBaseRequirements, app.assemblyRecipes, app.inventory);
    app.planRequirements = expanded;

    const oreChoices = {};
    app.settings.ore_choices = app.settings.ore_choices || {};
    for (const [item, select] of Object.entries(planSourceSelects)) {
      const ore = app.catalog.findOre(select.value);
      if (ore) {
        oreChoices[item] = ore;
        app.settings.ore_choices[item] = ore.name;
      }
    }
    app.settings.cargo_capacity = cargoCapacity;
    await storage.saveSettings(app.settings);

    const result = planMining(app.catalog, app.planRequirements, app.inventory, oreChoices, cargoCapacity, harvesterTotals(app.harvesterSlots), app.pendingRefining, assemblyHours);

    renderItemsNeeded(app.planRequirements, result);
    const totalValue = renderOreToMine(result, cargoCapacity, null, app.activeBuildName || "(unsaved plan)");
    updateMissingAssemblyWarning(result);
    app.lastPlanResult = result;
    await storage.saveToMineData(toStorableToMineData(result, cargoCapacity));

    summaryText.textContent = `Total raw ore to mine: ${result.totalRawToMine.toFixed(1)} (≈${Math.round(totalValue).toLocaleString()} cr)   |   Cargo capacity: ${cargoCapacity}   |   Trips needed: ${result.trips}`;
  }

  async function computeAllBuildsRequirements() {
    const combined = {};
    const contributors = {}; // itemName -> Set(buildName)
    for (const [buildName, entries] of Object.entries(app.builds)) {
      const totals = entriesToTotals(app, entries);
      const { expanded } = expandCommodities(app.catalog, totals, app.assemblyRecipes, app.inventory);
      for (const [item, qty] of Object.entries(expanded)) {
        combined[item] = (combined[item] || 0) + qty;
        if (!contributors[item]) contributors[item] = new Set();
        contributors[item].add(buildName);
      }
    }
    return { combined, contributors };
  }

  async function calculateAllBuilds() {
    const { combined, contributors } = await computeAllBuildsRequirements();
    if (Object.keys(combined).length === 0) {
      alert("No builds have any items in their plan yet.");
      return;
    }
    const cargoCapacity = parseFloat(cargoInput.value);
    if (Number.isNaN(cargoCapacity) || cargoCapacity <= 0) {
      alert("Cargo capacity must be a positive number.");
      return;
    }
    app.settings.cargo_capacity = cargoCapacity; // echoed for toStorableToMineData below, not persisted here (matches gui.py's _calculate_all_builds)

    const oreChoices = {};
    for (const [item, oreName] of Object.entries(app.settings.ore_choices || {})) {
      const ore = app.catalog.findOre(oreName);
      if (ore) oreChoices[item] = ore;
    }
    const { assemblyHours } = expandCommodities(app.catalog, combined, app.assemblyRecipes, app.inventory);
    const result = planMining(app.catalog, combined, app.inventory, oreChoices, cargoCapacity, harvesterTotals(app.harvesterSlots), app.pendingRefining, assemblyHours);

    app.planRequirements = combined;
    renderItemsNeeded(combined, result);
    const totalValue = renderOreToMine(result, cargoCapacity, contributors, "");
    app.lastPlanResult = result;
    await storage.saveToMineData(toStorableToMineData(result, cargoCapacity));

    const neededMaterials = {};
    for (const [item, need] of Object.entries(result.itemNeed)) {
      if (result.itemKind[item] === "material" && need > 0 && contributors[item]) neededMaterials[item] = contributors[item];
    }
    const opportunities = findConsolidationOpportunities(app.catalog, neededMaterials, oreChoices);
    if (opportunities.length > 0) showConsolidationSuggestions(opportunities);

    updateMissingAssemblyWarning(result);
    summaryText.textContent = `ALL BUILDS — Total raw ore to mine: ${result.totalRawToMine.toFixed(1)} (≈${Math.round(totalValue).toLocaleString()} cr)   |   Cargo capacity: ${cargoCapacity}   |   Trips needed: ${result.trips}`;
  }

  function showConsolidationSuggestions(opportunities) {
    const rows = opportunities.map((s) => {
      const applyBtn = el("button", {
        text: "Apply",
        onclick: async () => {
          app.settings.ore_choices = app.settings.ore_choices || {};
          for (const m of s.covered) app.settings.ore_choices[m.name] = s.ore.name;
          await storage.saveSettings(app.settings);
          alert(`Applied: ${s.covered.map((m) => m.name).join(", ")} will now source from ${s.ore.name}. Recalculate to see the effect.`);
        },
      });
      return el("div", { class: "field-row" }, [
        el("span", { text: `Mine ${s.ore.name} to cover ${s.covered.map((m) => m.name).join(", ")} — needed by ${[...s.builds].sort().join(", ")}` }),
        applyBtn,
      ]);
    });
    const closeBtn = el("button", { text: "Close" });
    const overlay = el("div", { class: "modal-overlay" }, [
      el("div", { class: "modal-box" }, [el("h3", { text: "Consolidation opportunities" }), ...rows, closeBtn]),
    ]);
    closeBtn.addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
  }

  async function updatePendingForSelectedOre() {
    if (!selectedOreForPending) return;
    const ore = app.catalog.findOre(selectedOreForPending);
    const batches = parseInt(pendingBatchesForOreInput.value, 10);
    if (!ore || Number.isNaN(batches)) {
      alert("Select an ore row and enter a whole number of batches.");
      return;
    }
    const oldBatches = app.pendingRefining[ore.name] || 0;
    await applyLocalPendingDeduction(app, ore, oldBatches, batches);
    if (batches <= 0) delete app.pendingRefining[ore.name];
    else app.pendingRefining[ore.name] = batches;
    await storage.savePendingRefining(app.pendingRefining);
    if (app.refreshHooks.inventory) app.refreshHooks.inventory();
    await calculatePlan();
  }

  // ============================ Refine dialog ============================
  function openRefineDialog() {
    const row = resultMatTbody.querySelector("tr.selected");
    if (!row) {
      alert("Select an item in the Items Needed table first.");
      return;
    }
    const itemName = row.dataset.item;
    const [kind, material] = app.catalog.classify(itemName);
    if (kind !== "material" || material.sources.length === 0) {
      alert("Refining only applies to refined materials with a known source ore.");
      return;
    }
    const stillNeed = (app.lastPlanResult && app.lastPlanResult.itemNeed[itemName]) || 0;

    const oreSelect = el("select", {}, material.sources.map((o) => el("option", { value: o.name, text: o.name })));
    const batchesInput = el("input", { type: "text", value: "1", style: "width:70px" });
    const infoText = el("div", { class: "status-text" });

    function updateInfo() {
      const ore = app.catalog.findOre(oreSelect.value);
      const batches = parseInt(batchesInput.value, 10) || 0;
      const rawNeeded = batches * ore.batch;
      const stored = app.inventory.rawQty(ore);
      const shortfall = Math.max(0, rawNeeded - stored);
      const refinedOut = batches * ore.refinedQ;
      infoText.textContent = `${batches} batch(es) of ${ore.name}: needs ${rawNeeded} raw (have ${stored}, short ${shortfall}) -> yields ${refinedOut} of each output.`;
    }

    function suggestBatches() {
      const ore = app.catalog.findOre(oreSelect.value);
      batchesInput.value = String(Math.max(1, Math.ceil(stillNeed / ore.refinedQ)));
      updateInfo();
    }

    oreSelect.addEventListener("change", suggestBatches);
    batchesInput.addEventListener("input", updateInfo);

    const confirmBtn = el("button", {
      text: "Confirm",
      onclick: async () => {
        const ore = app.catalog.findOre(oreSelect.value);
        const batches = parseInt(batchesInput.value, 10);
        if (Number.isNaN(batches) || batches <= 0) {
          alert("Enter a positive whole number of batches.");
          return;
        }
        const oldBatches = app.pendingRefining[ore.name] || 0;
        const newBatches = oldBatches + batches; // additive, not a replace
        await applyLocalPendingDeduction(app, ore, oldBatches, newBatches);
        app.pendingRefining[ore.name] = newBatches;
        await storage.savePendingRefining(app.pendingRefining);
        if (app.refreshHooks.inventory) app.refreshHooks.inventory();
        overlay.remove();
        await calculatePlan();
      },
    });
    const cancelBtn = el("button", { text: "Cancel", onclick: () => overlay.remove() });

    const overlay = el("div", { class: "modal-overlay" }, [
      el("div", { class: "modal-box" }, [
        el("h3", { text: `Refine ${itemName}` }),
        el("div", { class: "status-text", text: `Still need: ${stillNeed.toFixed(1)}` }),
        el("div", { class: "field-row" }, [el("label", { text: "Ore:" }), oreSelect]),
        el("div", { class: "field-row" }, [el("label", { text: "Batches:" }), batchesInput]),
        infoText,
        el("div", { class: "toolbar" }, [confirmBtn, cancelBtn]),
      ]),
    ]);
    document.body.appendChild(overlay);
    suggestBatches();
  }

  // ============================ Layout ============================
  container.appendChild(
    el("div", {}, [
      el("div", { class: "toolbar" }, [
        buildSelect,
        el("button", { text: "New Build...", onclick: newBuild }),
        el("button", { class: "danger", text: "Delete Build", onclick: deleteBuild }),
        el("button", { text: "Mark Build Complete", onclick: markBuildComplete }),
      ]),
      buildStatus,
      syncStatus,
      el("h3", { class: "section-title", text: "Add to plan" }),
      el("div", { class: "toolbar" }, [recipeSelect, recipeQtyInput, el("button", { text: "Add Recipe to Plan", onclick: addRecipeToPlan })]),
      el("div", { class: "toolbar" }, [materialInput, materialQtyInput, el("button", { text: "Add Item to Plan", onclick: addMaterialToPlan })]),
      itemDatalist,
      el("h3", { class: "section-title", text: "Plan items" }),
      entriesSelect,
      el("div", { class: "toolbar" }, [
        el("button", { text: "Remove Selected", onclick: removePlanItem }),
        el("button", { text: "Build Requirements", onclick: buildRequirements }),
        el("button", { text: "Clear Plan", onclick: clearPlan }),
      ]),
      el("h3", { class: "section-title", text: "Item sources" }),
      sourcesContainer,
      el("h3", { class: "section-title", text: "Calculate" }),
      el("div", { class: "toolbar" }, [
        el("label", { text: "Cargo capacity:" }),
        cargoInput,
        el("button", { text: "Calculate Plan", onclick: calculatePlan }),
        el("button", { text: "Calculate All Builds", onclick: calculateAllBuilds }),
      ]),
      el("h3", { class: "section-title", text: "Items Needed" }),
      el("div", { class: "scroll-table" }, [resultMatTable]),
      el("div", { class: "toolbar" }, [el("button", { text: "Refine Selected...", onclick: openRefineDialog })]),
      el("h3", { class: "section-title", text: "Ore to Mine" }),
      el("div", { class: "scroll-table" }, [resultOreTable]),
      el("div", { class: "toolbar" }, [
        el("label", { text: "Batches refining:" }),
        pendingBatchesForOreInput,
        el("button", { text: "Set for Selected Ore", onclick: updatePendingForSelectedOre }),
      ]),
      missingAssemblyWarning,
      summaryText,
    ])
  );

  refreshBuildCombo();
  refreshPlanRecipeCombo();
  renderEntriesList();
  renderSyncStatus();

  app.refreshHooks.planRecipeCombo = refreshPlanRecipeCombo;
  app.refreshHooks.planCargoCapacity = (cargo) => { cargoInput.value = String(cargo); };
  app.refreshHooks.plan = async () => {
    renderSyncStatus();
    if (Object.keys(app.planRequirements).length > 0) await calculatePlan();
  };
}
