// Settings tab - the ship capacities read from the game (shown, not
// editable), moving blueprints and builds to another browser, and backup
// & restore. Port of gui.py's _build_settings_tab,
// minus the settings that have no analog in the extension. Cargo and Ore
// Hold come from the game's top bar (background.js's handleSkillsScrape()),
// and the harvester slot count lives on the Planets tab, next to the
// roster it sizes.

import { el } from "./dom-helpers.js";
import { TRANSFER_FORMAT, TRANSFER_KEYS, TRANSFER_SETTINGS, mergeTransferData, transferConflicts } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initSettingsTab(app, container) {
  const shipInfo = el("div", { class: "status-text" });
  function refreshShipInfo() {
    const s = app.settings;
    shipInfo.textContent = s.has_ore_hold
      ? `Cargo capacity: ${s.cargo_capacity}. Ore Hold: ${s.ore_hold_capacity} (used for mining trips).`
      : `Cargo capacity: ${s.cargo_capacity} (used for mining trips). No Ore Hold on this ship.`;
  }

  // --- Move to another browser or PC ---
  // Blueprints, assembly plans and saved builds (personal and corp) as a
  // downloaded .json file, merged on import - see mergeTransferData() in
  // calc-engine.js. The same <a download> blob click as the Corp tab's CSV
  // export, so no "downloads" permission is needed.
  const transferStatus = el("div", { class: "status-text" });

  async function exportTransferFile() {
    const data = await browser.storage.local.get(TRANSFER_KEYS);
    if (data.settings) data.settings = Object.fromEntries(TRANSFER_SETTINGS.filter((f) => f in data.settings).map((f) => [f, data.settings[f]]));
    const blob = new Blob([JSON.stringify({ format: TRANSFER_FORMAT, version: 1, exported: new Date().toISOString(), ...data }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const a = el("a", { href: url, download: `forged-space-blueprints-builds-${dateStamp}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    const bpCount = Object.keys(data.blueprints || {}).length;
    const buildCount = Object.keys(data.builds || {}).length;
    const slotCount = (data.harvesters || []).filter((slot) => slot && slot.resource).length;
    transferStatus.textContent = `Exported ${bpCount} blueprint${bpCount === 1 ? "" : "s"}, ${buildCount} build${buildCount === 1 ? "" : "s"} and ${slotCount} harvester assignment${slotCount === 1 ? "" : "s"}.`;
    transferStatus.className = "status-ok";
  }

  // Allow/Skip for an import that would change something set by hand here -
  // resolves true for Allow. `lines` are shown under the message.
  function askAllowSkip(title, message, lines) {
    return new Promise((resolve) => {
      const allowBtn = el("button", { text: "Allow" });
      const skipBtn = el("button", { text: "Skip" });
      const overlay = el("div", { class: "modal-overlay" }, [
        el("div", { class: "modal-box" }, [
          el("h3", { text: title }),
          el("div", { class: "hint", text: message }),
          ...lines.map((line) => el("div", { class: "status-text", text: line })),
          el("div", { class: "toolbar" }, [allowBtn, skipBtn]),
        ]),
      ]);
      const finish = (allow) => {
        overlay.remove();
        resolve(allow);
      };
      allowBtn.addEventListener("click", () => finish(true));
      skipBtn.addEventListener("click", () => finish(false));
      document.body.appendChild(overlay);
    });
  }

  function describeRoster(slots, count) {
    const assigned = (slots || []).slice(0, count ?? Infinity).filter((slot) => slot && slot.resource);
    const list = assigned.map((slot) => `${slot.resource} ${slot.rate}`).join(", ");
    return `${count ?? (slots || []).length} slots${list ? ` - ${list}` : ""}`;
  }

  const transferFileInput = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
  transferFileInput.addEventListener("change", async () => {
    const file = transferFileInput.files[0];
    transferFileInput.value = ""; // reset so re-selecting the same file still fires "change"
    if (!file) return;
    let blob;
    try {
      blob = JSON.parse(await file.text());
    } catch (e) {
      alert("That file isn't valid JSON.");
      return;
    }
    if (blob && typeof blob === "object") {
      for (const [oldKey, newKey] of Object.entries(LEGACY_IMPORT_KEY_MAP)) {
        if (oldKey in blob && !(newKey in blob)) blob[newKey] = blob[oldKey];
      }
    }
    if (!blob || typeof blob !== "object" || !["blueprints", "assemblyPlans", "builds", "harvesters", "scrapedPlanetTypes"].some((k) => k in blob)) {
      alert("No blueprints, builds or harvesters found in that file - pick one exported from this section.");
      return;
    }
    const current = await browser.storage.local.get(TRANSFER_KEYS);
    const conflicts = transferConflicts(current, blob);
    const replace = {};
    if (conflicts.harvesters) {
      replace.harvesters = await askAllowSkip("Harvester settings", "The imported file changes your harvester settings.", [
        `Yours: ${describeRoster(current.harvesters, current.settings?.max_harvesters)}`,
        `File: ${describeRoster(blob.harvesters, blob.settings?.max_harvesters)}`,
      ]);
    }
    if (conflicts.choices.length > 0) {
      const mine = current.settings || {};
      const theirs = blob.settings || {};
      const describe = (settings, item) =>
        [settings.ore_choices?.[item], settings.item_acquisition_mode?.[item], settings.assembler_counts?.[item] ? `${settings.assembler_counts[item]} assemblers` : null].filter(Boolean).join(", ");
      replace.choices = await askAllowSkip(
        "Ore, buy/craft and assembler choices",
        "The imported file changes your ore, buy/craft or assembler choices for these items.",
        conflicts.choices.map((item) => `${item}: yours ${describe(mine, item) || "-"}, file ${describe(theirs, item) || "-"}`)
      );
    }
    const { data, counts } = mergeTransferData(current, blob, replace);
    if (replace.choices) counts.choices = conflicts.choices.length;
    if (counts.blueprints + counts.assemblyPlans + counts.builds + counts.harvesters + counts.planetTypes + (counts.choices || 0) === 0) {
      transferStatus.textContent = "Nothing new in that file - everything in it is already here.";
      transferStatus.className = "status-ok";
      return;
    }
    await browser.storage.local.set(data);
    const parts = [
      `${counts.blueprints} blueprint${counts.blueprints === 1 ? "" : "s"}`,
      `${counts.assemblyPlans} assembly plan${counts.assemblyPlans === 1 ? "" : "s"}`,
      `${counts.builds} build${counts.builds === 1 ? "" : "s"}`,
    ];
    if (counts.harvesters) parts.push(`${counts.harvesters} harvester assignment${counts.harvesters === 1 ? "" : "s"}`);
    if (counts.choices) parts.push(`${counts.choices} updated ore/buy choice${counts.choices === 1 ? "" : "s"}`);
    if (counts.planetTypes) parts.push(`${counts.planetTypes} planet type${counts.planetTypes === 1 ? "" : "s"}`);
    transferStatus.textContent = `Added ${parts.join(", ")}${counts.buildsSkipped ? ` (${counts.buildsSkipped} build${counts.buildsSkipped === 1 ? " was" : "s were"} already here)` : ""}. Reloading...`;
    transferStatus.className = "status-ok";
    setTimeout(() => location.reload(), 1500);
  });

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

  // The in-game "Refresh your data" reminder each new session (see
  // js/overlay-setup.js) - saved straight away, like every other setting.
  const reminderCheckbox = el("input", { type: "checkbox", id: "session-reminder" });
  reminderCheckbox.checked = app.settings.session_reminder !== false;
  reminderCheckbox.addEventListener("change", async () => {
    app.settings.session_reminder = reminderCheckbox.checked;
    await storage.saveSettings(app.settings);
  });

  // Cargo/Ore Hold read from the game's HUD - see dashboard.js's
  // storage.onChanged listener.
  app.refreshHooks.settingsFields = refreshShipInfo;
  refreshShipInfo();

  container.appendChild(
    el("div", {}, [
      el("h3", { class: "section-title", text: "Your ship" }),
      shipInfo,
      el("div", { class: "hint", text: "Read from the game's top bar while it's open - switching ships updates these. Mining trips use the Ore Hold when your ship has one, otherwise cargo." }),
      el("h3", { class: "section-title", text: "Reminders" }),
      el("div", { class: "field-row" }, [reminderCheckbox, el("label", { for: "session-reminder", text: "Remind me to refresh my game data (storage, skills, harvesters, assemblers, refining) each session" })]),
      el("div", { class: "hint", text: "When you start playing, a small window on the game page lists Commercial Storage and Skills, and ticks each off once it's been opened." }),
      el("h3", { class: "section-title", text: "Move to another browser or PC" }),
      el("div", { class: "hint", text: "Save your blueprints, assembly plans, builds (including corp builds), harvester slots and planet types to a file, then import it in the extension on the other browser or PC. Importing adds to what's already there, and blueprints already read from the game there are kept. If the file would change your harvester settings or ore/buy choices, you're asked first." }),
      el("div", { class: "toolbar" }, [
        el("button", { text: "Export to File", onclick: exportTransferFile }),
        el("button", { text: "Import from File...", onclick: () => transferFileInput.click() }),
      ]),
      transferFileInput,
      transferStatus,
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
