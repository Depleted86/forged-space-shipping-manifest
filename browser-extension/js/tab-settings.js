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

  // Ore Hold - some ships have one dedicated to raw ore, separate from
  // general cargo space, so mining/refining trip counts need a different
  // capacity than everything else uses (see storage.js's has_ore_hold/
  // ore_hold_capacity comment). The capacity field only makes sense once the
  // checkbox is checked, so it's hidden rather than just inert when it isn't
  // - an always-visible-but-ignored number field would be confusing.
  const hasOreHoldInput = el("input", { type: "checkbox", checked: app.settings.has_ore_hold ? "" : undefined });
  const oreHoldCapacityInput = el("input", { type: "text", value: String(app.settings.ore_hold_capacity) });
  const oreHoldCapacityRow = el("div", { class: "field-row", style: app.settings.has_ore_hold ? "" : "display:none" }, [
    el("label", { text: "Ore Hold capacity per trip:" }),
    oreHoldCapacityInput,
  ]);
  hasOreHoldInput.addEventListener("change", () => {
    oreHoldCapacityRow.style.display = hasOreHoldInput.checked ? "" : "none";
    // Immediate, not debounced - a checkbox toggle has no "still typing" to
    // wait out, unlike the text fields below. autoSaveNow() is declared
    // later in this function but safe to reference here - function
    // declarations are hoisted, and this callback only ever actually runs
    // on a later "change" event, well after everything's initialized.
    autoSaveNow();
  });

  const statusText = el("div", { class: "status-text" });

  // Auto-save, standardized with how the rest of the app already behaves
  // (the harvester roster below commits on blur/change with no Save button;
  // every Manifest overlay control applies instantly) - this tab was the
  // odd one out, requiring an explicit click. Errors surface inline in
  // statusText instead of alert() - a blocking modal firing mid-typing (or
  // on every debounced tick while a field is momentarily invalid) would be
  // far more disruptive here than it was as a one-shot button-click check.
  // An invalid field simply isn't persisted (whatever was last validly
  // saved stays in storage) until it's fixed.
  async function save() {
    const cargo = parseFloat(cargoInput.value);
    if (Number.isNaN(cargo) || cargo <= 0) {
      statusText.textContent = "Cargo capacity must be a positive number.";
      statusText.className = "status-text status-warn";
      return;
    }
    const maxHarvesters = parseInt(maxHarvestersInput.value, 10);
    if (Number.isNaN(maxHarvesters) || maxHarvesters <= 0) {
      statusText.textContent = "Max harvesters must be a positive whole number.";
      statusText.className = "status-text status-warn";
      return;
    }
    let oreHoldCapacity = app.settings.ore_hold_capacity;
    if (hasOreHoldInput.checked) {
      oreHoldCapacity = parseFloat(oreHoldCapacityInput.value);
      if (Number.isNaN(oreHoldCapacity) || oreHoldCapacity <= 0) {
        statusText.textContent = "Ore Hold capacity must be a positive number.";
        statusText.className = "status-text status-warn";
        return;
      }
    }

    app.settings.cargo_capacity = cargo;
    app.settings.max_harvesters = maxHarvesters;
    app.settings.has_ore_hold = hasOreHoldInput.checked;
    app.settings.ore_hold_capacity = oreHoldCapacity;
    await storage.saveSettings(app.settings);

    if (maxHarvesters !== app.maxHarvesters) {
      app.maxHarvesters = maxHarvesters;
      app.harvesterSlots = await storage.loadHarvesterSlots(maxHarvesters);
      if (app.refreshHooks.planets) app.refreshHooks.planets();
    }
    // No-arg - the Plan a Build tab re-derives its own field's label/value/
    // storage-key from app.settings itself (has_ore_hold, cargo_capacity,
    // ore_hold_capacity all just got updated above), rather than being
    // handed a single number that no longer says which setting it belongs to.
    if (app.refreshHooks.planCargoCapacity) app.refreshHooks.planCargoCapacity();

    statusText.textContent = "Settings saved.";
    statusText.className = "status-text status-ok";
  }

  // "After entry has stopped" - debounced, not per-keystroke (parseFloat
  // running, and a save round-trip firing, on every single character while
  // someone's still mid-typing "600" would be wasteful and could flash a
  // spurious validation error at intermediate states). blur() saves
  // immediately (matches the harvester roster's own commit-on-blur below) so
  // tabbing away doesn't sit waiting on the debounce timer for no reason.
  const AUTOSAVE_DEBOUNCE_MS = 600;
  let debounceTimer = null;
  function autoSaveDebounced() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(save, AUTOSAVE_DEBOUNCE_MS);
  }
  function autoSaveNow() {
    clearTimeout(debounceTimer);
    save();
  }
  for (const input of [cargoInput, oreHoldCapacityInput, maxHarvestersInput]) {
    input.addEventListener("input", autoSaveDebounced);
    input.addEventListener("blur", autoSaveNow);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") autoSaveNow();
    });
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
    "blueprints",
    "inventory",
    "settings",
    "harvesters",
    "pendingRefining",
    "assemblyPlans",
    "builds",
    "buildLabels",
    "activeBuildName",
    "corpInventory",
    "activeCorpBuildName",
    "corpHaveOverrides",
  ];

  // Old key names, from before the 2026-08-15 Recipe/AssemblyRecipe ->
  // Blueprint/AssemblyPlan rename - accepted on Import only (never Export),
  // so a backup taken with an older version still restores correctly. This
  // writes straight to browser.storage.local, bypassing storage.js's own
  // loadBlueprints()/loadAssemblyPlans() migration entirely, so it needs
  // this same fallback of its own.
  const LEGACY_IMPORT_KEY_MAP = { recipes: "blueprints", assemblyRecipes: "assemblyPlans" };

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
    for (const [oldKey, newKey] of Object.entries(LEGACY_IMPORT_KEY_MAP)) {
      if (oldKey in blob && !(newKey in toWrite)) toWrite[newKey] = blob[oldKey];
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

  // Only shown the very first time the dashboard is ever opened (see
  // dashboard.js's bootstrap(), which also lands the user on this tab in
  // that case) - a nudge to fill in the numbers every trip/mining
  // calculation across the app depends on before doing anything else.
  const welcomeHint = app.isFirstLaunch
    ? el("div", {
        class: "hint",
        text: "Welcome! Fill in your cargo capacity (and Ore Hold, if your ship has one) and max harvesters below - saved automatically as you go - these drive every trip and mining calculation across the app.",
      })
    : null;

  // Cargo/Ore Hold read from the game's HUD (background.js's
  // handleSkillsScrape()) - reflect them here, but never over a field the
  // player is typing in.
  app.refreshHooks.settingsFields = () => {
    if (document.activeElement !== cargoInput) cargoInput.value = String(app.settings.cargo_capacity);
    if (document.activeElement !== oreHoldCapacityInput) oreHoldCapacityInput.value = String(app.settings.ore_hold_capacity);
    hasOreHoldInput.checked = !!app.settings.has_ore_hold;
    oreHoldCapacityRow.style.display = hasOreHoldInput.checked ? "" : "none";
  };

  container.appendChild(
    el("div", {}, [
      welcomeHint,
      el("div", { class: "field-row" }, [el("label", { text: "Cargo capacity per trip:" }), cargoInput]),
      el("div", { class: "field-row" }, [el("label", { text: "Do you have an Ore Hold?" }), hasOreHoldInput]),
      oreHoldCapacityRow,
      el("div", { class: "hint", text: "Cargo and Ore Hold fill in from the game's top bar while it's open - mining trips use the Ore Hold when your ship has one, otherwise cargo. You can still type them here." }),
      el("div", { class: "field-row" }, [el("label", { text: "Max harvesters at once:" }), maxHarvestersInput]),
      statusText,
      el("h3", { class: "section-title", text: "Backup & restore" }),
      el("div", { class: "hint", text: "Export everything (blueprints, inventory, settings, builds, etc.) as JSON, or paste a previous export back in to restore it." }),
      el("div", { class: "toolbar" }, [el("button", { text: "Export Current Data", onclick: runExport })]),
      exportTextarea,
      exportStatus,
      el("div", { class: "toolbar" }, [el("button", { text: "Import", onclick: runImport })]),
      importTextarea,
      importStatus,
    ])
  );
}
