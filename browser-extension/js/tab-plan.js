// Plan a Build tab - the most complex tab. Port of gui.py's _build_plan_tab
// and its ~30 handler methods: multi-build tracking with auto-numbered
// reused-gap IDs, a two-stage requirements pipeline
// (entriesToTotals -> expandCommodities), single-build vs all-builds
// calculation modes (the latter enabling cross-build ore consolidation
// suggestions), a refine-batches modal with live projected-output math, and
// the result tables. On every successful calculation the result is written
// to the `toMineData` storage key - this replaces both
// app.last_plan_result (Python, in-memory only) and bridge_server.py's GET
// handler, since the in-page Manifest overlay (js/overlay-manifest.js) now
// reads that key directly.
//
// entriesToTotals() and toStorableToMineData() used to be defined here but
// moved to calc-engine.js (2026-08-09) so background.js can import them for
// headless recalculation - see recalculateActiveBuildToMineData() there.

import { el, clear, selectableRow, enableInlineAutocomplete } from "./dom-helpers.js";
import { planMining, expandCommodities, findConsolidationOpportunities, harvesterTotals, pendingRefiningOutput, entriesToTotals, toStorableToMineData, itemResourceBreakdown } from "./calc-engine.js";
import * as storage from "./storage.js";
import { applyLocalPendingDeduction } from "./tab-inventory.js";

function formatHours(hours) {
  return `${hours.toFixed(1)}h (${(hours / 24).toFixed(1)} days)`;
}

// list of [oreName, batches] for every pending-refining ore whose outputs
// include `materialName`. Port of gui.py's _pending_credit_contributors.
function pendingCreditContributors(app, materialName) {
  const out = [];
  for (const [oreName, batches] of Object.entries(app.pendingRefining)) {
    if (batches <= 0) continue;
    const ore = app.catalog.findOre(oreName);
    if (ore && ore.outputs.some((m) => m.name === materialName)) out.push([oreName, batches]);
  }
  return out;
}

export function initPlanTab(app, container) {
  let planEntries = []; // [[kind, name, qty], ...] - scratch list, tied to active build
  let planSourceSelects = {}; // itemName -> <select> element (material source choice)

  // ============================ Build selector ============================
  // There's deliberately no "(unsaved plan)" option anymore - Build 1 is
  // always the fallback (see ensureBuildOneAndLoad() below), so the
  // dropdown only ever lists real, saved builds.
  const buildSelectLabel = el("label", { for: "plan-build-select", class: "visually-hidden", text: "Active build" });
  const buildSelect = el("select", { id: "plan-build-select" });
  const buildStatus = el("div", { class: "status-text" });

  function refreshBuildCombo() {
    clear(buildSelect);
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

  // ore_choices and item_acquisition_mode (both in app.settings, keyed by
  // item name) never had anything removing entries from them - a name
  // picked once stuck around in settings forever, even after every build
  // that ever needed it was long gone. Not worth pruning on every single
  // item add/remove (a momentarily-removed item might just be getting
  // re-added), but a whole build finishing its lifecycle - deleted or
  // completed - is the natural moment to sweep anything no other
  // surviving build still references. Call AFTER app.builds has already
  // had the build in question removed.
  async function pruneStaleItemSettings() {
    const buyModes = app.settings.item_acquisition_mode || {};
    const stillNeeded = new Set();
    for (const entries of Object.values(app.builds)) {
      const totals = entriesToTotals(app.blueprints, entries);
      for (const name of Object.keys(totals)) stillNeeded.add(name);
      const { expanded } = expandCommodities(app.catalog, totals, app.assemblyPlans, app.inventory, 20, buyModes);
      for (const name of Object.keys(expanded)) stillNeeded.add(name);
    }
    let changed = false;
    for (const name of Object.keys(app.settings.ore_choices || {})) {
      if (!stillNeeded.has(name)) {
        delete app.settings.ore_choices[name];
        changed = true;
      }
    }
    for (const name of Object.keys(buyModes)) {
      if (!stillNeeded.has(name)) {
        delete buyModes[name];
        changed = true;
      }
    }
    if (changed) await storage.saveSettings(app.settings);
  }

  async function deleteBuild() {
    if (!app.activeBuildName) return;
    if (!confirm(`Delete build "${app.activeBuildName}"? This does not touch pending refining or inventory.`)) return;
    delete app.builds[app.activeBuildName];
    await storage.saveBuilds(app.builds);
    await pruneStaleItemSettings();
    // Falls back to Build 1 (recreated fresh if it was the one just
    // deleted) rather than landing in the old "(unsaved plan)" state -
    // there's always a build selected now, never a generic placeholder.
    await ensureBuildOneAndLoad();
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
    await pruneStaleItemSettings();
    // Same fallback as deleteBuild() - see the comment there.
    await ensureBuildOneAndLoad();
  }

  async function loadBuild(name) {
    if (!name || !app.builds[name]) return;
    app.activeBuildName = name;
    await storage.saveActiveBuildName(name);
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
    if (Object.keys(app.planBaseRequirements).length > 0) {
      await calculatePlan();
    } else {
      // Otherwise a build with nothing in it yet (e.g. freshly created)
      // would silently leave whichever OTHER build's numbers were last
      // calculated sitting in toMineData, making the floating "Manifest"
      // window show a plan that has nothing to do with the build now
      // actually selected.
      await storage.saveToMineData({ available: false });
    }
  }

  // Ensures "Build 1" exists (creating it fresh if this is the very first
  // use, or if it was deleted/completed) and loads it - the fallback home
  // base now that there's no more generic "(unsaved plan)" state to fall
  // back to.
  async function ensureBuildOneAndLoad() {
    if (!app.builds["1"]) {
      app.builds["1"] = [];
      await storage.saveBuilds(app.builds);
    }
    refreshBuildCombo();
    await loadBuild("1");
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
  const blueprintSelectLabel = el("label", { for: "plan-blueprint-select", class: "visually-hidden", text: "Blueprint to add" });
  const blueprintSelect = el("select", { id: "plan-blueprint-select" });
  const blueprintQtyLabel = el("label", { for: "plan-blueprint-qty", class: "visually-hidden", text: "Blueprint quantity" });
  const blueprintQtyInput = el("input", { id: "plan-blueprint-qty", type: "text", value: "1", style: "width:70px" });
  function refreshPlanBlueprintCombo() {
    clear(blueprintSelect);
    for (const name of Object.keys(app.blueprints).sort()) blueprintSelect.appendChild(el("option", { value: name, text: name }));
  }

  async function addBlueprintToPlan() {
    const name = blueprintSelect.value;
    const qty = parseFloat(blueprintQtyInput.value);
    if (!name || Number.isNaN(qty) || qty <= 0) {
      alert("Choose a blueprint and enter a positive quantity.");
      return;
    }
    planEntries.push(["blueprint", name, qty]);
    renderEntriesList();
    await saveActiveBuild();
  }

  // Ad-hoc item candidates = every catalog item (ore/material/planet
  // resource) PLUS every Assembly-produced Commodity name - a build can
  // directly need a finished assembled part (e.g. "Graviton Emitters"), not
  // just raw/refined materials, so that name has to be pickable here too.
  // A live callback (not a snapshot array), same reasoning as Assembly's own
  // output-item field in tab-assembly.js: always reflects whatever's
  // currently in app.assemblyPlans, including anything just imported from
  // the Assembler Plans screen.
  function adhocItemCandidates() {
    return [...new Set([...app.catalog.allItemNames(), ...Object.keys(app.assemblyPlans)])];
  }
  const itemDatalistId = "plan-item-datalist";
  const itemDatalist = el("datalist", { id: itemDatalistId }, adhocItemCandidates().map((n) => el("option", { value: n })));
  const materialLabel = el("label", { for: "plan-material-input", class: "visually-hidden", text: "Item name" });
  const materialInput = el("input", { id: "plan-material-input", type: "text", list: itemDatalistId, placeholder: "Item name" });
  enableInlineAutocomplete(materialInput, adhocItemCandidates);
  const materialQtyLabel = el("label", { for: "plan-material-qty", class: "visually-hidden", text: "Item quantity" });
  const materialQtyInput = el("input", { id: "plan-material-qty", type: "text", value: "1", style: "width:70px" });

  async function addMaterialToPlan() {
    const name = materialInput.value.trim();
    const qty = parseFloat(materialQtyInput.value);
    if (!name || Number.isNaN(qty) || qty <= 0) {
      alert("Enter an item name and a positive quantity.");
      return;
    }
    planEntries.push(["material", name, qty]);
    renderEntriesList();
    await saveActiveBuild();
  }

  // ============================ Plan items list ============================
  const entriesSelectLabel = el("label", { for: "plan-entries-select", class: "visually-hidden", text: "Plan items" });
  const entriesSelect = el("select", { id: "plan-entries-select", size: "6", class: "list-select" });
  function renderEntriesList() {
    clear(entriesSelect);
    planEntries.forEach(([kind, name, qty], i) => {
      // "recipe" is the pre-2026-08-15 tag for what's now saved as
      // "blueprint" (see calc-engine.js's entriesToTotals()) - a build saved
      // before that rename can still have old-tagged entries, so both
      // display the same way here.
      const label = kind === "blueprint" || kind === "recipe" ? `Blueprint: ${name} x${qty}` : `Material: ${name} x${qty}`;
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
    if (planEntries.length > 0 && !confirm(`Clear all ${planEntries.length} item(s) from build "${app.activeBuildName}"? This cannot be undone.`)) return;
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
    // Without this, the toolbar's "Manifest" popup keeps showing whatever
    // was last calculated even after the build it came from was deleted,
    // completed, or explicitly cleared here - stale, potentially
    // mine-the-wrong-thing-misleading data with nothing on screen
    // indicating it's out of date.
    await storage.saveToMineData({ available: false });
  }

  // ============================ Item sources ============================
  // "sources-container" makes this a wrapping flex row instead of a plain
  // vertical stack - see dashboard.css. Scoped to this specific container
  // (not the shared .field-row class itself, which many other single-row
  // usages across the dashboard rely on staying full-width/stacked).
  const sourcesContainer = el("div", { class: "sources-container" });

  async function buildRequirements() {
    const totals = entriesToTotals(app.blueprints, planEntries);
    app.planBaseRequirements = totals;
    app.settings.item_acquisition_mode = app.settings.item_acquisition_mode || {};
    const buyModes = app.settings.item_acquisition_mode;
    const { expanded, assemblyHours } = expandCommodities(app.catalog, totals, app.assemblyPlans, app.inventory, 20, buyModes);
    app.planRequirements = expanded;

    clear(sourcesContainer);
    planSourceSelects = {};

    const pendingBonus = pendingRefiningOutput(app.catalog, app.pendingRefining);
    const names = Object.keys(expanded).sort();
    let anyShown = false;
    let sourceRowIndex = 0;
    for (const name of names) {
      const [kind, obj] = app.catalog.classify(name);
      const have = kind === "material" ? app.inventory.refinedQty(obj) : kind === "ore" ? app.inventory.rawQty(obj) : app.inventory.other[name] || 0;
      const pendingCredit = kind === "material" ? pendingBonus[name] || 0 : 0;
      const need = Math.max(0, expanded[name] - have - pendingCredit);
      if (need <= 0) continue;
      anyShown = true;

      if (kind === "material") {
        const selectId = `plan-source-${sourceRowIndex++}`;
        const select = el(
          "select",
          { id: selectId },
          obj.sources.map((o) => el("option", { value: o.name, text: o.name }))
        );
        const savedChoice = app.settings.ore_choices?.[name];
        select.value = obj.sources.some((o) => o.name === savedChoice) ? savedChoice : obj.sources[0]?.name || "";
        planSourceSelects[name] = select;
        sourcesContainer.appendChild(
          el("div", { class: "field-row" }, [
            el("label", { for: selectId, text: `${name} (refined, need ${need.toFixed(1)}${pendingCredit > 0 ? `, +${pendingCredit} pending` : ""}):` }),
            select,
          ])
        );
      } else if (kind === "ore") {
        sourcesContainer.appendChild(
          el("div", { class: "field-row" }, [el("label", { text: `${name} (raw ore, used directly, need ${need.toFixed(1)})` })])
        );
      } else if (kind === "planet_resource") {
        const rate = (harvesterTotals(app.harvesterSlots)[name]) || 0;
        const hoursText = rate > 0 ? formatHours(need / rate) : "no harvesters assigned";
        sourcesContainer.appendChild(
          el("div", { class: "field-row" }, [
            el("label", { class: "status-ok", text: `${name} — found on: ${obj.planetTypes.map((p) => p.name).join(", ")} — need ${need.toFixed(1)} — ${hoursText}` }),
          ])
        );
      } else if (app.assemblyPlans[name]) {
        // Commodity with a known Assembly Plan - per-item choice: "Mine"
        // cascades it into its own ingredient needs (same as always) and
        // shows a sub-category breakdown of the fully-expanded raw
        // resources that costs, right under this row; "Buy" leaves it flat
        // (no cascade, no breakdown) for a player who'd rather acquire that
        // specific part directly. Persisted per item name in
        // settings.item_acquisition_mode - absent means "mine" (the default
        // expandCommodities() already assumes).
        const mode = buyModes[name] === "buy" ? "buy" : "mine";
        const modeSelectId = `plan-item-mode-${sourceRowIndex++}`;
        const modeSelect = el("select", { id: modeSelectId }, [
          el("option", { value: "mine", text: "Mine" }),
          el("option", { value: "buy", text: "Buy" }),
        ]);
        modeSelect.value = mode;
        modeSelect.addEventListener("change", async () => {
          if (modeSelect.value === "buy") buyModes[name] = "buy";
          else delete buyModes[name];
          await storage.saveSettings(app.settings);
          await buildRequirements(); // the whole expansion graph can change, not just this row
        });

        if (mode === "buy") {
          sourcesContainer.appendChild(
            el("div", { class: "field-row" }, [
              el("label", { for: modeSelectId, text: `${name} (assembly, need ${need.toFixed(1)}):` }),
              modeSelect,
            ])
          );
        } else {
          const hours = assemblyHours[name];
          const hoursText = hours != null ? formatHours(hours) : "rate unknown";
          sourcesContainer.appendChild(
            el("div", { class: "field-row" }, [
              el("label", { for: modeSelectId, class: "status-ok", text: `${name} (assembly, need ${need.toFixed(1)}, ${hoursText}):` }),
              modeSelect,
            ])
          );
          // Sub-category: this item's own fully-expanded raw resource
          // breakdown (gross Assembly Plan cost, not netted against
          // inventory - see itemResourceBreakdown() in calc-engine.js) -
          // purely informational attribution, doesn't change the combined
          // Mining totals below (those still merge every "Mine" item's ore
          // needs into one shared pool, same as always).
          for (const sub of itemResourceBreakdown(app.catalog, name, need, app.assemblyPlans, buyModes)) {
            sourcesContainer.appendChild(
              el("div", { class: "field-row source-subitem" }, [el("label", { text: `↳ ${sub.name}: ${sub.need.toFixed(1)}` })])
            );
          }
        }
      } else {
        sourcesContainer.appendChild(
          el("div", { class: "field-row" }, [
            el("label", { class: "status-warn", text: `${name} (commodity, need ${need.toFixed(1)}) — no known ore/planet/assembly source, tracked from inventory only` }),
          ])
        );
      }
    }
    if (!anyShown) {
      sourcesContainer.appendChild(el("div", { class: "status-ok", text: "Nothing needed beyond what's already in inventory." }));
    }
  }

  // ============================ Calculate ============================
  const cargoLabel = el("label", { for: "plan-cargo-input", text: "Cargo capacity:" });
  const cargoInput = el("input", { id: "plan-cargo-input", type: "text", value: String(app.settings.cargo_capacity) });

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
  const pendingBatchesForOreLabel = el("label", { for: "plan-pending-batches-input", text: "Batches refining:" });
  const pendingBatchesForOreInput = el("input", { id: "plan-pending-batches-input", type: "text", value: "0", style: "width:70px" });
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
    if (name in result.unresolved) {
      return (app.settings.item_acquisition_mode || {})[name] === "buy" ? "(buy)" : "(no known source)";
    }
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

      const row = selectableRow(
        { "data-item": name },
        `Select ${displayName}`,
        [
          el("td", { text: displayName }),
          el("td", { text: app.kindLabel(name) }),
          el("td", { text: String(requirements[name]) }),
          el("td", { text: String(have) }),
          el("td", { text: String(pending) }),
          el("td", { text: stillNeed.toFixed(1) }),
          el("td", { text: source }),
        ],
        () => {}
      );
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
      const row = selectableRow(
        { "data-ore": ore.name },
        `Select ${ore.name}`,
        [
          el("td", { text: ore.name }),
          el("td", { text: String(ore.law) }),
          el("td", { text: buildLabel }),
          el("td", { text: (result.oreRawNeeded.get(ore) || 0).toFixed(1) }),
          el("td", { text: String(app.inventory.rawQty(ore)) }),
          el("td", { text: String(batches) }),
          el("td", { text: toMine.toFixed(1) }),
          el("td", { text: String(trips) }),
          el("td", { text: value.toFixed(0) }),
        ],
        () => {
          selectedOreForPending = ore.name;
          pendingBatchesForOreInput.value = String(app.pendingRefining[ore.name] || 0);
        }
      );
      resultOreTbody.appendChild(row);
    }
    return totalValue;
  }

  function updateMissingAssemblyWarning(result) {
    // Items the player explicitly chose "Buy" for (per-item, in Item
    // sources) are unresolved on purpose - they show up in the Buy section
    // instead, not as a warning here. Only warn about a Commodity that's
    // unresolved because no Assembly Plan exists for it at all yet.
    const buyModes = app.settings.item_acquisition_mode || {};
    const names = Object.keys(result.unresolved).filter((n) => app.catalog.classify(n)[0] === "unknown" && buyModes[n] !== "buy");
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

    const buyModes = app.settings.item_acquisition_mode || {};
    const { expanded, assemblyHours } = expandCommodities(app.catalog, app.planBaseRequirements, app.assemblyPlans, app.inventory, 20, buyModes);
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
    const buyModes = app.settings.item_acquisition_mode || {};
    const combined = {};
    const contributors = {}; // itemName -> Set(buildName)
    for (const [buildName, entries] of Object.entries(app.builds)) {
      const totals = entriesToTotals(app.blueprints, entries);
      const { expanded } = expandCommodities(app.catalog, totals, app.assemblyPlans, app.inventory, 20, buyModes);
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
    const buyModes = app.settings.item_acquisition_mode || {};
    const { assemblyHours } = expandCommodities(app.catalog, combined, app.assemblyPlans, app.inventory, 20, buyModes);
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
    if (!ore || Number.isNaN(batches) || batches < 0) {
      alert("Select an ore row and enter a whole number of batches (0 or more).");
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

    const oreSelect = el("select", { id: "refine-ore-select" }, material.sources.map((o) => el("option", { value: o.name, text: o.name })));
    const batchesInput = el("input", { id: "refine-batches-input", type: "text", value: "1", style: "width:70px" });
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
        el("div", { class: "field-row" }, [el("label", { for: "refine-ore-select", text: "Ore:" }), oreSelect]),
        el("div", { class: "field-row" }, [el("label", { for: "refine-batches-input", text: "Batches:" }), batchesInput]),
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
        buildSelectLabel,
        buildSelect,
        el("button", { text: "New Build...", onclick: newBuild }),
        el("button", { class: "danger", text: "Delete Build", onclick: deleteBuild }),
        el("button", { text: "Mark Build Complete", onclick: markBuildComplete }),
      ]),
      buildStatus,
      syncStatus,
      el("h3", { class: "section-title", text: "Add to plan" }),
      el("div", { class: "toolbar" }, [blueprintSelectLabel, blueprintSelect, blueprintQtyLabel, blueprintQtyInput, el("button", { text: "Add Blueprint to Plan", onclick: addBlueprintToPlan })]),
      el("div", { class: "toolbar" }, [materialLabel, materialInput, materialQtyLabel, materialQtyInput, el("button", { text: "Add Item to Plan", onclick: addMaterialToPlan })]),
      itemDatalist,
      el("h3", { class: "section-title", text: "Plan items" }),
      entriesSelectLabel,
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
        cargoLabel,
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
        pendingBatchesForOreLabel,
        pendingBatchesForOreInput,
        el("button", { text: "Set for Selected Ore", onclick: updatePendingForSelectedOre }),
      ]),
      missingAssemblyWarning,
      summaryText,
    ])
  );

  refreshBuildCombo();
  refreshPlanBlueprintCombo();
  renderEntriesList();
  renderSyncStatus();

  // Restore whatever build was active last session (persisted so
  // background.js can also recalculate it headlessly - see storage.js),
  // or fall back to Build 1 if there's no valid persisted selection (first
  // ever use, or the persisted build no longer exists). Fire-and-forget:
  // initPlanTab() itself isn't async, same pattern as dashboard.js's
  // bootstrap().
  (async () => {
    const persisted = await storage.loadActiveBuildName();
    if (persisted && app.builds[persisted]) {
      await loadBuild(persisted);
    } else {
      await ensureBuildOneAndLoad();
    }
  })();

  app.refreshHooks.planBlueprintCombo = refreshPlanBlueprintCombo;
  app.refreshHooks.planCargoCapacity = (cargo) => { cargoInput.value = String(cargo); };
  app.refreshHooks.plan = async () => {
    renderSyncStatus();
    if (Object.keys(app.planRequirements).length > 0) await calculatePlan();
  };
}
