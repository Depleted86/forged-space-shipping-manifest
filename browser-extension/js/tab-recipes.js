// Recipes tab - CRUD editor for Recipe objects (build/item requirement
// lists). Port of gui.py's _build_recipes_tab and its handlers, including
// the dirty-check-before-discard pattern. Unlike Assembly (which is kept in
// sync live from the game's Assembler Plans screen - see background.js's
// handleAssemblerScrape()), Recipes are hand-entered only: an equivalent
// import from the game's Item Database category screens (Weapons, Defence,
// Reactors, etc.) was explored and deliberately shelved as more
// complicated than it's worth, so there's no scraper feeding this tab.

import { el, clear, selectableRow, enableInlineAutocomplete } from "./dom-helpers.js";
import { Recipe } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initRecipesTab(app, container) {
  let editingRecipe = null; // name of recipe being edited, or null for new
  let editingRequirements = {}; // itemName -> qty, scratch state until Save
  // Captain Level requirement, when known - display-only stat, never used
  // to gate anything here. In practice this stays null for everything
  // entered through this tab (Recipes have no live import to populate it
  // from - see the header comment above); it only ever gets a real value
  // via a Settings > Import of previously-exported data that already had
  // one set.
  let editingCaptainLevel = null;

  const recipeSelectLabel = el("label", { for: "recipes-list", class: "visually-hidden", text: "Saved recipes" });
  const recipeSelect = el("select", { id: "recipes-list", size: "20", class: "list-select" });
  // width:auto (overriding the global .field-row label 200px, which other
  // tabs' stacked field-rows rely on for their OWN internal alignment)
  // plus flex:1 on the input, so "Recipe name:" sits as close to its input
  // as "Item:" does below it, and the input stretches out to end at the
  // same right edge as the Add / Update button in the toolbar row below.
  const nameLabel = el("label", { for: "recipe-name-input", text: "Recipe name:", style: "width: auto; white-space: nowrap;" });
  const nameInput = el("input", { id: "recipe-name-input", type: "text", placeholder: "Recipe name", style: "flex: 1; min-width: 0;" });
  const capLevelInfo = el("div", { class: "status-text" });
  const saveStatus = el("div", { class: "status-text" });

  function refreshCapLevelInfo() {
    capLevelInfo.textContent = editingCaptainLevel != null ? `Captain Level required: ${editingCaptainLevel}` : "";
  }

  // A recipe's own requirements can include an Assembly-produced part as an
  // ingredient, not just raw/refined catalog items - so that name needs to
  // be pickable here too. Live callback (not a snapshot), same reasoning as
  // Plan a Build's own ad-hoc item field: always reflects whatever's
  // currently in app.assemblyRecipes, including anything just imported from
  // the Assembler Plans screen.
  function itemCandidates() {
    return [...new Set([...app.catalog.allItemNames(), ...Object.keys(app.assemblyRecipes)])];
  }
  const itemDatalistId = "recipes-item-datalist";
  const itemDatalist = el("datalist", { id: itemDatalistId }, itemCandidates().map((n) => el("option", { value: n })));
  const materialLabel = el("label", { for: "recipe-item-input", text: "Item:" });
  const materialInput = el("input", { id: "recipe-item-input", type: "text", list: itemDatalistId, placeholder: "Start typing to search...", style: "flex: 1; min-width: 0;" });
  enableInlineAutocomplete(materialInput, itemCandidates);
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
    editingCaptainLevel = null;
    nameInput.value = "";
    materialInput.value = "";
    qtyInput.value = "1";
    saveStatus.textContent = "";
    refreshTree();
    refreshListbox();
    refreshCapLevelInfo();
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
    editingCaptainLevel = app.recipes[name]?.captainLevel ?? null;
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
      alert("Enter a recipe name.");
      return;
    }
    if (Object.keys(editingRequirements).length === 0) {
      alert("Add at least one item requirement.");
      return;
    }
    const recipe = new Recipe(name);
    for (const [itemName, qty] of Object.entries(editingRequirements)) recipe.setRequirement(itemName, qty);
    recipe.captainLevel = editingCaptainLevel;
    if (editingRecipe && editingRecipe !== name) delete app.recipes[editingRecipe];
    app.recipes[name] = recipe;
    await storage.saveRecipes(app.recipes);
    editingRecipe = name;
    refreshListbox();
    if (app.refreshHooks.planRecipeCombo) app.refreshHooks.planRecipeCombo();
    // Inline, non-blocking - unlike the two alert()s above (genuine input
    // errors worth interrupting for), a routine successful save shouldn't
    // make the player click through a dialog every single time.
    saveStatus.textContent = `Saved recipe "${name}".`;
    saveStatus.className = "status-text status-ok";
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
        capLevelInfo,
        el("div", { class: "toolbar" }, [materialLabel, materialInput, qtyLabel, qtyInput, el("button", { text: "Add / Update", onclick: addToEditor })]),
        itemDatalist,
        el("div", { class: "hint", text: "Item can be a refined material, a raw ore (used directly), or any other tracked resource/commodity." }),
        el("div", { class: "scroll-table" }, [reqTable]),
        el("div", { class: "toolbar" }, [
          el("button", { text: "Remove Selected Item", onclick: removeSelected }),
          el("button", { text: "Save Recipe", onclick: saveEditor }),
        ]),
        saveStatus,
      ]),
    ])
  );

  refreshListbox();
  refreshTree();
  refreshCapLevelInfo();

  // Refreshes just the saved-recipes list (not the in-progress edit form,
  // which shouldn't be clobbered mid-edit) when recipes change externally -
  // e.g. an Assembler Plans import from background.js while this tab is
  // already open (see dashboard.js's storage.onChanged listener).
  app.refreshHooks.recipes = () => refreshListbox();
  app.unsavedGuards.recipes = hasUnsavedChanges;
}
