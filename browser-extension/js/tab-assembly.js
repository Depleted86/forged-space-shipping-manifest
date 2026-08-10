// Assembly tab - CRUD editor for AssemblyRecipe objects (continuous
// production rate + per-unit input costs). Near-mirror of tab-recipes.js
// with an added rate_per_hour field, per gui.py's _build_assembly_tab.

import { el, clear, selectableRow, enableInlineAutocomplete } from "./dom-helpers.js";
import { AssemblyRecipe } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initAssemblyTab(app, container) {
  let editingOutput = null; // output item name being edited, or null for new
  let editingRequirements = {};

  const listSelectLabel = el("label", { for: "assembly-list", class: "visually-hidden", text: "Saved Assembly recipes" });
  const listSelect = el("select", { id: "assembly-list", size: "20", class: "list-select" });
  const outputDatalistId = "assembly-output-datalist";
  const outputDatalist = el("datalist", { id: outputDatalistId });
  // width:auto (overriding the global .field-row label 200px) + flex:1 on
  // the input, same treatment as Recipes' "Recipe name:" - so these two
  // field-rows sit as close to their labels as "Item:"/"Qty per unit:" do
  // below, and outputInput stretches out to the same right edge as the
  // Add / Update button. rateInput stays a small fixed width like
  // inputQtyInput does - it's a short number, not a name field.
  const outputLabel = el("label", { for: "assembly-output-input", text: "Output item:", style: "width: auto; white-space: nowrap;" });
  const outputInput = el("input", { id: "assembly-output-input", type: "text", list: outputDatalistId, placeholder: "Output item (Commodity name)", style: "flex: 1; min-width: 0;" });
  // Same candidate set refreshOutputChoices() populates the datalist with -
  // kept as a live callback (not a snapshot array) so it reflects whatever
  // is currently in inventory/assemblyRecipes at the moment the user types.
  enableInlineAutocomplete(outputInput, () => [...new Set([...Object.keys(app.inventory.other), ...Object.keys(app.assemblyRecipes)])]);
  const rateLabel = el("label", { for: "assembly-rate-input", text: "Rate (units/hour):", style: "width: auto; white-space: nowrap;" });
  const rateInput = el("input", { id: "assembly-rate-input", type: "text", value: "1", style: "width:90px" });

  const inputDatalistId = "assembly-input-datalist";
  const inputDatalist = el("datalist", { id: inputDatalistId }, app.catalog.allItemNames().map((n) => el("option", { value: n })));
  const inputItemLabel = el("label", { for: "assembly-input-item", text: "Item:" });
  const inputItemInput = el("input", { id: "assembly-input-item", type: "text", list: inputDatalistId, placeholder: "Start typing to search...", style: "flex: 1; min-width: 0;" });
  enableInlineAutocomplete(inputItemInput, () => app.catalog.allItemNames());
  const inputQtyLabel = el("label", { for: "assembly-input-qty", text: "Qty per unit:" });
  const inputQtyInput = el("input", { id: "assembly-input-qty", type: "text", value: "1", style: "width:70px" });

  const reqTbody = el("tbody");
  const reqTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Input Item", "Kind", "Qty per unit"].map((h) => el("th", { text: h })))]),
    reqTbody,
  ]);

  function refreshOutputChoices() {
    clear(outputDatalist);
    const names = new Set([...Object.keys(app.inventory.other), ...Object.keys(app.assemblyRecipes)]);
    for (const n of [...names].sort()) outputDatalist.appendChild(el("option", { value: n }));
  }

  function savedFor(name) {
    return name && app.assemblyRecipes[name] ? { rate: app.assemblyRecipes[name].ratePerHour, req: app.assemblyRecipes[name].requirements } : { rate: null, req: {} };
  }

  function hasUnsavedChanges() {
    const saved = savedFor(editingOutput);
    const nameChanged = editingOutput !== null && outputInput.value.trim() !== editingOutput;
    const rateChanged = saved.rate !== null && parseFloat(rateInput.value) !== saved.rate;
    return nameChanged || rateChanged || JSON.stringify(saved.req) !== JSON.stringify(editingRequirements);
  }

  function confirmDiscard() {
    if (!hasUnsavedChanges()) return true;
    return confirm("Discard unsaved changes to this Assembly recipe?");
  }

  function refreshListbox() {
    clear(listSelect);
    for (const name of Object.keys(app.assemblyRecipes).sort()) {
      listSelect.appendChild(el("option", { value: name, text: name, selected: name === editingOutput ? "" : undefined }));
    }
    listSelect.value = editingOutput || "";
  }

  function refreshTree() {
    clear(reqTbody);
    for (const name of Object.keys(editingRequirements).sort()) {
      const row = selectableRow(
        { "data-item": name },
        `Select ${name}, quantity ${editingRequirements[name]}`,
        [el("td", { text: name }), el("td", { text: app.kindLabel(name) }), el("td", { text: String(editingRequirements[name]) })],
        () => {
          inputItemInput.value = name;
          inputQtyInput.value = String(editingRequirements[name]);
        }
      );
      reqTbody.appendChild(row);
    }
  }

  function clearEditor() {
    editingOutput = null;
    editingRequirements = {};
    outputInput.value = "";
    rateInput.value = "1";
    inputItemInput.value = "";
    inputQtyInput.value = "1";
    refreshTree();
    refreshListbox();
  }

  function newRecipe() {
    if (!confirmDiscard()) return;
    clearEditor();
  }

  async function deleteRecipe() {
    if (!editingOutput) return;
    if (!confirm(`Delete Assembly recipe for "${editingOutput}"?`)) return;
    delete app.assemblyRecipes[editingOutput];
    await storage.saveAssemblyRecipes(app.assemblyRecipes);
    clearEditor();
    refreshOutputChoices();
  }

  function loadIntoEditor(name) {
    if (name === editingOutput) return;
    if (!confirmDiscard()) {
      listSelect.value = editingOutput || "";
      return;
    }
    editingOutput = name;
    const recipe = app.assemblyRecipes[name];
    editingRequirements = { ...(recipe?.requirements || {}) };
    outputInput.value = name;
    rateInput.value = String(recipe?.ratePerHour ?? 1);
    refreshTree();
    refreshListbox();
  }

  function addInput() {
    const name = inputItemInput.value.trim();
    const qty = parseFloat(inputQtyInput.value);
    if (!name || Number.isNaN(qty)) {
      alert("Enter an item name and a numeric quantity.");
      return;
    }
    if (app.kindLabel(name) === "Commodity") {
      alert(`"${name}" isn't a known ore, refined material, or planetary resource - it will be tracked as a Commodity, unless it also has its own Assembly recipe.`);
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
    const outputItem = outputInput.value.trim();
    const rate = parseFloat(rateInput.value);
    if (!outputItem) {
      alert("Enter an output item name.");
      return;
    }
    if (!(rate > 0)) {
      alert("Rate (units/hour) must be a positive number.");
      return;
    }
    if (Object.keys(editingRequirements).length === 0) {
      alert("Add at least one input requirement.");
      return;
    }
    const recipe = new AssemblyRecipe(outputItem, rate);
    for (const [itemName, qty] of Object.entries(editingRequirements)) recipe.setRequirement(itemName, qty);
    if (editingOutput && editingOutput !== outputItem) delete app.assemblyRecipes[editingOutput];
    app.assemblyRecipes[outputItem] = recipe;
    await storage.saveAssemblyRecipes(app.assemblyRecipes);
    editingOutput = outputItem;
    refreshListbox();
    refreshOutputChoices();
    alert(`Saved Assembly recipe for "${outputItem}".`);
  }

  listSelect.addEventListener("change", () => loadIntoEditor(listSelect.value));

  container.appendChild(
    el("div", { class: "split-layout" }, [
      el("div", { class: "side-list" }, [
        listSelectLabel,
        listSelect,
        el("div", { class: "toolbar" }, [
          el("button", { text: "New", onclick: newRecipe }),
          el("button", { class: "danger", text: "Delete", onclick: deleteRecipe }),
        ]),
      ]),
      el("div", { class: "detail-panel" }, [
        el("div", { class: "hint", text: "Assembly produces a Commodity at a continuous rate (units/hour), each unit costing the listed inputs." }),
        el("div", { class: "field-row" }, [outputLabel, outputInput]),
        outputDatalist,
        el("div", { class: "field-row" }, [rateLabel, rateInput]),
        el("div", { class: "toolbar" }, [inputItemLabel, inputItemInput, inputQtyLabel, inputQtyInput, el("button", { text: "Add / Update", onclick: addInput })]),
        inputDatalist,
        el("div", { class: "scroll-table" }, [reqTable]),
        el("div", { class: "toolbar" }, [
          el("button", { text: "Remove Selected Input", onclick: removeSelected }),
          el("button", { text: "Save Assembly Recipe", onclick: saveEditor }),
        ]),
      ]),
    ])
  );

  refreshOutputChoices();
  refreshListbox();
  refreshTree();

  app.refreshHooks.assembly = () => refreshOutputChoices();
}
