// Recipes tab - CRUD editor for Recipe objects (build/item requirement
// lists). Port of gui.py's _build_recipes_tab and its handlers, including
// the dirty-check-before-discard pattern.

import { el, clear, selectableRow, enableInlineAutocomplete } from "./dom-helpers.js";
import { Recipe } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initRecipesTab(app, container) {
  let editingRecipe = null; // name of recipe being edited, or null for new
  let editingRequirements = {}; // itemName -> qty, scratch state until Save

  const recipeSelectLabel = el("label", { for: "recipes-list", class: "visually-hidden", text: "Saved recipes" });
  const recipeSelect = el("select", { id: "recipes-list", size: "20", class: "list-select" });
  // width:auto (overriding the global .field-row label 200px, which other
  // tabs' stacked field-rows rely on for their OWN internal alignment)
  // plus flex:1 on the input, so "Recipe name:" sits as close to its input
  // as "Item:" does below it, and the input stretches out to end at the
  // same right edge as the Add / Update button in the toolbar row below.
  const nameLabel = el("label", { for: "recipe-name-input", text: "Recipe name:", style: "width: auto; white-space: nowrap;" });
  const nameInput = el("input", { id: "recipe-name-input", type: "text", placeholder: "Recipe name", style: "flex: 1; min-width: 0;" });

  const itemDatalistId = "recipes-item-datalist";
  const itemDatalist = el("datalist", { id: itemDatalistId }, app.catalog.allItemNames().map((n) => el("option", { value: n })));
  const materialLabel = el("label", { for: "recipe-item-input", text: "Item:" });
  const materialInput = el("input", { id: "recipe-item-input", type: "text", list: itemDatalistId, placeholder: "Start typing to search...", style: "flex: 1; min-width: 0;" });
  enableInlineAutocomplete(materialInput, () => app.catalog.allItemNames());
  const qtyLabel = el("label", { for: "recipe-item-qty-input", text: "Qty:" });
  const qtyInput = el("input", { id: "recipe-item-qty-input", type: "text", value: "1", style: "width:70px" });

  const reqTbody = el("tbody");
  const reqTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Item", "Kind", "Qty"].map((h) => el("th", { text: h })))]),
    reqTbody,
  ]);

  function savedRequirementsFor(name) {
    return name && app.recipes[name] ? app.recipes[name].requirements : {};
  }

  function hasUnsavedChanges() {
    const saved = savedRequirementsFor(editingRecipe);
    const nameChanged = editingRecipe !== null && nameInput.value.trim() !== editingRecipe;
    return nameChanged || JSON.stringify(saved) !== JSON.stringify(editingRequirements);
  }

  function confirmDiscard() {
    if (!hasUnsavedChanges()) return true;
    return confirm("Discard unsaved changes to this recipe?");
  }

  function refreshListbox() {
    clear(recipeSelect);
    for (const name of Object.keys(app.recipes).sort()) {
      recipeSelect.appendChild(el("option", { value: name, text: name, selected: name === editingRecipe ? "" : undefined }));
    }
    recipeSelect.value = editingRecipe || "";
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
    editingRecipe = null;
    editingRequirements = {};
    nameInput.value = "";
    materialInput.value = "";
    qtyInput.value = "1";
    refreshTree();
    refreshListbox();
  }

  function newRecipe() {
    if (!confirmDiscard()) return;
    clearEditor();
  }

  async function deleteRecipe() {
    if (!editingRecipe) return;
    if (!confirm(`Delete recipe "${editingRecipe}"?`)) return;
    delete app.recipes[editingRecipe];
    await storage.saveRecipes(app.recipes);
    clearEditor();
  }

  function loadIntoEditor(name) {
    if (name === editingRecipe) return;
    if (!confirmDiscard()) {
      recipeSelect.value = editingRecipe || "";
      return;
    }
    editingRecipe = name;
    editingRequirements = { ...(app.recipes[name]?.requirements || {}) };
    nameInput.value = name;
    refreshTree();
    refreshListbox();
  }

  function addToEditor() {
    const name = materialInput.value.trim();
    const qty = parseFloat(qtyInput.value);
    if (!name || Number.isNaN(qty)) {
      alert("Enter an item name and a numeric quantity.");
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
      alert("Enter a recipe name.");
      return;
    }
    const recipe = new Recipe(name);
    for (const [itemName, qty] of Object.entries(editingRequirements)) recipe.setRequirement(itemName, qty);
    if (editingRecipe && editingRecipe !== name) delete app.recipes[editingRecipe];
    app.recipes[name] = recipe;
    await storage.saveRecipes(app.recipes);
    editingRecipe = name;
    refreshListbox();
    if (app.refreshHooks.planRecipeCombo) app.refreshHooks.planRecipeCombo();
    alert(`Saved recipe "${name}".`);
  }

  recipeSelect.addEventListener("change", () => loadIntoEditor(recipeSelect.value));

  container.appendChild(
    el("div", { class: "split-layout" }, [
      el("div", { class: "side-list" }, [
        recipeSelectLabel,
        recipeSelect,
        el("div", { class: "toolbar" }, [
          el("button", { text: "New", onclick: newRecipe }),
          el("button", { class: "danger", text: "Delete", onclick: deleteRecipe }),
        ]),
      ]),
      el("div", { class: "detail-panel" }, [
        el("div", { class: "field-row" }, [nameLabel, nameInput]),
        el("div", { class: "toolbar" }, [materialLabel, materialInput, qtyLabel, qtyInput, el("button", { text: "Add / Update", onclick: addToEditor })]),
        itemDatalist,
        el("div", { class: "hint", text: "Item can be a refined material, a raw ore (used directly), or any other tracked resource/commodity." }),
        el("div", { class: "scroll-table" }, [reqTable]),
        el("div", { class: "toolbar" }, [
          el("button", { text: "Remove Selected Item", onclick: removeSelected }),
          el("button", { text: "Save Recipe", onclick: saveEditor }),
        ]),
      ]),
    ])
  );

  refreshListbox();
  refreshTree();
}
