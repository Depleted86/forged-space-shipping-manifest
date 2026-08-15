// Settings tab - cargo capacity and max harvesters. Port of gui.py's
// _build_settings_tab, minus the two settings that have no analog in the
// extension: downloads_dir (no filesystem access) and
// auto_refresh_enabled/refresh_interval_seconds (those governed the
// CSV-polling schedule; inventory sync here is event-driven off the game's
// DOM, not a user-configurable poll). Unlike the desktop app, changing max
// harvesters takes effect immediately - there's no process to restart.

import { el } from "./dom-helpers.js";
import * as storage from "./storage.js";

export function initSettingsTab(app, container) {
  const cargoInput = el("input", { type: "text", value: String(app.settings.cargo_capacity) });
  const maxHarvestersInput = el("input", { type: "text", value: String(app.maxHarvesters) });
  const statusText = el("div", { class: "status-text" });

  async function save() {
    const cargo = parseFloat(cargoInput.value);
    if (Number.isNaN(cargo) || cargo <= 0) {
      alert("Cargo capacity must be a positive number.");
      return;
    }
    const maxHarvesters = parseInt(maxHarvestersInput.value, 10);
    if (Number.isNaN(maxHarvesters) || maxHarvesters <= 0) {
      alert("Max harvesters must be a positive whole number.");
      return;
    }

    app.settings.cargo_capacity = cargo;
    app.settings.max_harvesters = maxHarvesters;
    await storage.saveSettings(app.settings);

    if (maxHarvesters !== app.maxHarvesters) {
      app.maxHarvesters = maxHarvesters;
      app.harvesterSlots = await storage.loadHarvesterSlots(maxHarvesters);
      if (app.refreshHooks.planets) app.refreshHooks.planets();
    }
    if (app.refreshHooks.planCargoCapacity) app.refreshHooks.planCargoCapacity(cargo);

    statusText.textContent = "Settings saved.";
    statusText.className = "status-ok";
  }

  // --- Backup & restore ---
  // browser.storage.local has no built-in export UI, and its data is scoped
  // to the extension's ID - reinstalling under a different ID (e.g. after
  // changing browser_specific_settings.gecko.id) starts with empty storage.
  // Export dumps every genuine source-of-truth data key as JSON for
  // safekeeping; Import writes a pasted blob of that same shape back in
  // (also doubles as the one-time migration path from the old Python app's
  // export_for_extension.py). Deliberately excludes the purely-derived/
  // cache keys (toMineData, corpToMineData, inventorySyncMeta) - those are
  // just the last computed plan result and a sync timestamp, recalculated
  // automatically the moment the relevant tab loads, so backing them up
  // would only ever restore something instantly stale.
  const BACKUP_KEYS = [
    "recipes",
    "inventory",
    "settings",
    "harvesters",
    "pendingRefining",
    "assemblyRecipes",
    "builds",
    "activeBuildName",
    "corpInventory",
    "activeCorpBuildName",
    "corpHaveOverrides",
  ];

  const exportTextarea = el("textarea", { rows: "6", style: "width:100%;font-family:monospace;font-size:12px", placeholder: "Click Export to fill this in..." });
  const exportStatus = el("div", { class: "status-text" });

  async function runExport() {
    const result = await browser.storage.local.get(BACKUP_KEYS);
    exportTextarea.value = JSON.stringify(result, null, 2);
    exportStatus.textContent = "Exported below - copy it somewhere safe.";
    exportStatus.className = "status-ok";
  }

  const importTextarea = el("textarea", { rows: "6", style: "width:100%;font-family:monospace;font-size:12px", placeholder: "Paste an exported backup (or export_for_extension.py's output) here..." });
  const importStatus = el("div", { class: "status-text" });

  async function runImport() {
    let blob;
    try {
      blob = JSON.parse(importTextarea.value);
    } catch (e) {
      alert("That doesn't look like valid JSON.");
      return;
    }
    const toWrite = {};
    for (const key of BACKUP_KEYS) {
      if (key in blob) toWrite[key] = blob[key];
    }
    if (Object.keys(toWrite).length === 0) {
      alert(`No recognized keys found in that JSON (expected ${BACKUP_KEYS.join("/")}).`);
      return;
    }
    if (!confirm(`This will overwrite: ${Object.keys(toWrite).join(", ")}. Continue?`)) return;
    await browser.storage.local.set(toWrite);
    importStatus.textContent = `Imported ${Object.keys(toWrite).join(", ")}. Reloading...`;
    importStatus.className = "status-ok";
    setTimeout(() => location.reload(), 800);
  }

  container.appendChild(
    el("div", {}, [
      el("div", { class: "field-row" }, [el("label", { text: "Cargo capacity per trip:" }), cargoInput]),
      el("div", { class: "field-row" }, [el("label", { text: "Max harvesters at once:" }), maxHarvestersInput]),
      el("div", { class: "toolbar" }, [el("button", { text: "Save", onclick: save })]),
      statusText,
      el("h3", { class: "section-title", text: "Backup & restore" }),
      el("div", { class: "hint", text: "Export everything (recipes, inventory, settings, builds, etc.) as JSON, or paste a previous export back in to restore it." }),
      el("div", { class: "toolbar" }, [el("button", { text: "Export Current Data", onclick: runExport })]),
      exportTextarea,
      exportStatus,
      el("div", { class: "toolbar" }, [el("button", { text: "Import", onclick: runImport })]),
      importTextarea,
      importStatus,
    ])
  );
}
