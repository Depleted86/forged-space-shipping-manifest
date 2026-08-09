// Recipes tab - CRUD editor for Recipe objects (build/item requirement
// lists). Port of gui.py's _build_recipes_tab and its handlers, including
// the dirty-check-before-discard pattern.

import { el, clear } from "./dom-helpers.js";
import { Recipe } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initRecipesTab(app, container) {
  let editingRecipe = null; // name of recipe being edited, or null for new
  let editingRequirements = {}; // itemName -> qty, scratch state until Save

  const recipeSelect = el("select", { size: "20", class: "list-select" });
  const nameInput = el("input", { type: "text", placeholder: "Recipe name" });

  const itemDatalistId = "recipes-item-datalist";
  const itemDatalist = el("datalist", { id: itemDatalistId }, app.catalog.allItemNames().map((n) => el("option", { value: n })));
  const materialInput = el("input", { type: "text", list: itemDatalistId, placeholder: "Item name" });
  const qtyInput = el("input", { type: "text", value: "1", style: "width:70px" });

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
      const row = el("tr", { "data-item": name }, [
        el("td", { text: name }),
        el("td", { text: app.kindLabel(name) }),
        el("td", { text: String(editingRequirements[name]) }),
      ]);
      row.addEventListener("click", () => {
        materialInput.value = name;
        qtyInput.value = String(editingRequirements[name]);
      });
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
  reqTbody.addEventListener("click", (e) => {
    const row = e.target.closest("tr");
    if (!row) return;
    for (const r of reqTbody.querySelectorAll("tr")) r.classList.remove("selected");
    row.classList.add("selected");
  });

  container.appendChild(
    el("div", { class: "split-layout" }, [
      el("div", { class: "side-list" }, [
        recipeSelect,
        el("div", { class: "toolbar" }, [
          el("button", { text: "New", onclick: newRecipe }),
          el("button", { class: "danger", text: "Delete", onclick: deleteRecipe }),
        ]),
      ]),
      el("div", { class: "detail-panel" }, [
        el("div", { class: "field-row" }, [el("label", { text: "Recipe name:" }), nameInput]),
        el("div", { class: "toolbar" }, [materialInput, qtyInput, el("button", { text: "Add / Update", onclick: addToEditor })]),
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
