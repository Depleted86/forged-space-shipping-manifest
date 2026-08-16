// Blueprints tab - CRUD editor for Blueprint objects (build/item requirement
// lists). Port of gui.py's _build_recipes_tab and its handlers, including
// the dirty-check-before-discard pattern (Python names left as-is - that
// app is deleted, so this is purely historical lineage; Recipe/AssemblyRecipe
// were renamed to Blueprint/AssemblyPlan here on 2026-08-15 to match the
// game's own terminology). Unlike Assembly (which is kept in sync live from
// the game's Assembler Plans screen - see background.js's
// handleAssemblerScrape()), Blueprints are hand-entered only: an equivalent
// import from the game's Item Database category screens (Weapons, Defence,
// Reactors, etc.) was explored and deliberately shelved as more
// complicated than it's worth, so there's no scraper feeding this tab.

import { el, clear, selectableRow, enableInlineAutocomplete } from "./dom-helpers.js";
import { Blueprint } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initBlueprintsTab(app, container) {
  let editingBlueprint = null; // name of blueprint being edited, or null for new
  let editingRequirements = {}; // itemName -> qty, scratch state until Save
  // Captain Level requirement, when known - display-only stat, never used
  // to gate anything here. In practice this stays null for everything
  // entered through this tab (Blueprints have no live import to populate it
  // from - see the header comment above); it only ever gets a real value
  // via a Settings > Import of previously-exported data that already had
  // one set.
  let editingCaptainLevel = null;

  const blueprintSelectLabel = el("label", { for: "blueprints-list", class: "visually-hidden", text: "Saved blueprints" });
  const blueprintSelect = el("select", { id: "blueprints-list", size: "20", class: "list-select" });
  // width:auto (overriding the global .field-row label 200px, which other
  // tabs' stacked field-rows rely on for their OWN internal alignment)
  // plus flex:1 on the input, so "Blueprint name:" sits as close to its input
  // as "Item:" does below it, and the input stretches out to end at the
  // same right edge as the Add / Update button in the toolbar row below.
  const nameLabel = el("label", { for: "blueprint-name-input", text: "Blueprint name:", style: "width: auto; white-space: nowrap;" });
  const nameInput = el("input", { id: "blueprint-name-input", type: "text", placeholder: "Blueprint name", style: "flex: 1; min-width: 0;" });
  const capLevelInfo = el("div", { class: "status-text" });
  const saveStatus = el("div", { class: "status-text" });

  function refreshCapLevelInfo() {
    capLevelInfo.textContent = editingCaptainLevel != null ? `Captain Level required: ${editingCaptainLevel}` : "";
  }

  // A blueprint's own requirements can include an Assembly-produced part as
  // an ingredient, not just raw/refined catalog items - so that name needs
  // to be pickable here too. Live callback (not a snapshot), same reasoning
  // as Plan a Build's own ad-hoc item field: always reflects whatever's
  // currently in app.assemblyPlans, including anything just imported from
  // the Assembler Plans screen.
  function itemCandidates() {
    return [...new Set([...app.catalog.allItemNames(), ...Object.keys(app.assemblyPlans)])];
  }
  const itemDatalistId = "blueprints-item-datalist";
  const itemDatalist = el("datalist", { id: itemDatalistId }, itemCandidates().map((n) => el("option", { value: n })));
  const materialLabel = el("label", { for: "blueprint-item-input", text: "Item:" });
  const materialInput = el("input", { id: "blueprint-item-input", type: "text", list: itemDatalistId, placeholder: "Start typing to search...", style: "flex: 1; min-width: 0;" });
  enableInlineAutocomplete(materialInput, itemCandidates);
  const qtyLabel = el("label", { for: "blueprint-item-qty-input", text: "Qty:" });
  const qtyInput = el("input", { id: "blueprint-item-qty-input", type: "text", value: "1", style: "width:70px" });

  const reqTbody = el("tbody");
  const reqTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Item", "Kind", "Qty"].map((h) => el("th", { text: h })))]),
    reqTbody,
  ]);

  function savedRequirementsFor(name) {
    return name && app.blueprints[name] ? app.blueprints[name].requirements : {};
  }

  function hasUnsavedChanges() {
    const saved = savedRequirementsFor(editingBlueprint);
    const nameChanged = editingBlueprint !== null && nameInput.value.trim() !== editingBlueprint;
    return nameChanged || JSON.stringify(saved) !== JSON.stringify(editingRequirements);
  }

  function confirmDiscard() {
    if (!hasUnsavedChanges()) return true;
    return confirm("Discard unsaved changes to this blueprint?");
  }

  function refreshListbox() {
    clear(blueprintSelect);
    for (const name of Object.keys(app.blueprints).sort()) {
      blueprintSelect.appendChild(el("option", { value: name, text: name, selected: name === editingBlueprint ? "" : undefined }));
    }
    blueprintSelect.value = editingBlueprint || "";
  }

  function refreshTree() {
    clear(reqTbody);
    for (const name of Object.keys(editingRequirements).sort()) {
      const row = selectableRow(
        { "data-item": name },
        `Select ${name}, quantity ${editingRequirements[name]}`,
        [el("td", { text: name }), el("td", { text: app.kindLabel(name) }), el("td", { text: String(editingRequirements[name]) })],
        () => {
          materialInput.value = name;
          qtyInput.value = String(editingRequirements[name]);
        }
      );
      reqTbody.appendChild(row);
    }
  }

  function clearEditor() {
    editingBlueprint = null;
    editingRequirements = {};
    editingCaptainLevel = null;
    nameInput.value = "";
    materialInput.value = "";
    qtyInput.value = "1";
    saveStatus.textContent = "";
    refreshTree();
    refreshListbox();
    refreshCapLevelInfo();
  }

  function newBlueprint() {
    if (!confirmDiscard()) return;
    clearEditor();
  }

  async function deleteBlueprint() {
    if (!editingBlueprint) return;
    if (!confirm(`Delete blueprint "${editingBlueprint}"?`)) return;
    delete app.blueprints[editingBlueprint];
    await storage.saveBlueprints(app.blueprints);
    clearEditor();
  }

  function loadIntoEditor(name) {
    if (name === editingBlueprint) return;
    if (!confirmDiscard()) {
      blueprintSelect.value = editingBlueprint || "";
      return;
    }
    editingBlueprint = name;
    editingRequirements = { ...(app.blueprints[name]?.requirements || {}) };
    editingCaptainLevel = app.blueprints[name]?.captainLevel ?? null;
    nameInput.value = name;
    saveStatus.textContent = "";
    refreshTree();
    refreshListbox();
    refreshCapLevelInfo();
  }

  function addToEditor() {
    const name = materialInput.value.trim();
    const qty = parseFloat(qtyInput.value);
    if (!name || Number.isNaN(qty) || qty <= 0) {
      alert("Enter an item name and a positive quantity.");
      return;
    }
    if (app.kindLabel(name) === "Commodity") {
      alert(`"${name}" isn't a known ore, refined material, or planetary resource - it will be tracked as a Commodity (e.g. an Assembly output or otherwise inventory-tracked item).`);
    }
    editingRequirements[name] = qty;
    refreshTree();
  }

  function removeSelected() {
    const row = reqTbody.querySelector("tr.selected");
    if (!row) return;
    delete editingRequirements[row.dataset.item];
    refreshTree();
  }

  async function saveEditor() {
    const name = nameInput.value.trim();
    if (!name) {
      alert("Enter a blueprint name.");
      return;
    }
    if (Object.keys(editingRequirements).length === 0) {
      alert("Add at least one item requirement.");
      return;
    }
    const blueprint = new Blueprint(name);
    for (const [itemName, qty] of Object.entries(editingRequirements)) blueprint.setRequirement(itemName, qty);
    blueprint.captainLevel = editingCaptainLevel;
    if (editingBlueprint && editingBlueprint !== name) delete app.blueprints[editingBlueprint];
    app.blueprints[name] = blueprint;
    await storage.saveBlueprints(app.blueprints);
    editingBlueprint = name;
    refreshListbox();
    if (app.refreshHooks.planBlueprintCombo) app.refreshHooks.planBlueprintCombo();
    // Inline, non-blocking - unlike the two alert()s above (genuine input
    // errors worth interrupting for), a routine successful save shouldn't
    // make the player click through a dialog every single time.
    saveStatus.textContent = `Saved blueprint "${name}".`;
    saveStatus.className = "status-text status-ok";
  }

  blueprintSelect.addEventListener("change", () => loadIntoEditor(blueprintSelect.value));

  container.appendChild(
    el("div", { class: "split-layout" }, [
      el("div", { class: "side-list" }, [
        blueprintSelectLabel,
        blueprintSelect,
        el("div", { class: "toolbar" }, [
          el("button", { text: "New", onclick: newBlueprint }),
          el("button", { class: "danger", text: "Delete", onclick: deleteBlueprint }),
        ]),
      ]),
      el("div", { class: "detail-panel" }, [
        el("div", { class: "field-row" }, [nameLabel, nameInput]),
        capLevelInfo,
        el("div", { class: "toolbar" }, [materialLabel, materialInput, qtyLabel, qtyInput, el("button", { text: "Add / Update", onclick: addToEditor })]),
        itemDatalist,
        el("div", { class: "hint", text: "Item can be a refined material, a raw ore (used directly), or any other tracked resource/commodity." }),
        el("div", { class: "scroll-table" }, [reqTable]),
        el("div", { class: "toolbar" }, [
          el("button", { text: "Remove Selected Item", onclick: removeSelected }),
          el("button", { text: "Save Blueprint", onclick: saveEditor }),
        ]),
        saveStatus,
      ]),
    ])
  );

  refreshListbox();
  refreshTree();
  refreshCapLevelInfo();

  // Refreshes just the saved-blueprints list (not the in-progress edit form,
  // which shouldn't be clobbered mid-edit) when blueprints change externally
  // - e.g. an Assembler Plans import from background.js while this tab is
  // already open (see dashboard.js's storage.onChanged listener).
  app.refreshHooks.blueprints = () => refreshListbox();
}
