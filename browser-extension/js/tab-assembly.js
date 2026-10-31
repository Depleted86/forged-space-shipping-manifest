// Assembly tab - CRUD editor for AssemblyPlan objects (continuous
// production rate + per-run input costs). Near-mirror of tab-blueprints.js
// with an added rate_per_hour field, per gui.py's _build_assembly_tab.

import { el, clear, selectableRow, enableInlineAutocomplete } from "./dom-helpers.js";
import { AssemblyPlan } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initAssemblyTab(app, container) {
  let editingOutput = null; // output item name being edited, or null for new
  let editingRequirements = {};
  // Captain Level requirement, when known - display-only stat carried over
  // from an Assembler Plans import (see background.js's
  // handleAssemblerScrape()), never used to gate anything here.
  let editingCaptainLevel = null;
  // R&D status from the R&D Office scrape (see background.js's
  // handleResearchScrape()) - carried through edits untouched, like
  // editingCaptainLevel.
  let editingResearch = null;

  const listSelectLabel = el("label", { for: "assembly-list", class: "visually-hidden", text: "Saved Assembly Plans" });
  const listSelect = el("select", { id: "assembly-list", size: "20", class: "list-select" });
  const outputDatalistId = "assembly-output-datalist";
  const outputDatalist = el("datalist", { id: outputDatalistId });
  // width:auto (overriding the global .field-row label 200px) + flex:1 on
  // the input, same treatment as Blueprints' "Blueprint name:" - so these
  // two field-rows sit as close to their labels as "Item:"/"Qty per run:"
  // do below, and outputInput stretches out to the same right edge as the
  // Add / Update button. rateInput stays a small fixed width like
  // inputQtyInput does - it's a short number, not a name field.
  const outputLabel = el("label", { for: "assembly-output-input", text: "Output item:", style: "width: auto; white-space: nowrap;" });
  const outputInput = el("input", { id: "assembly-output-input", type: "text", list: outputDatalistId, placeholder: "Output item (Commodity name)", style: "flex: 1; min-width: 0;" });
  // Same candidate set refreshOutputChoices() populates the datalist with -
  // kept as a live callback (not a snapshot array) so it reflects whatever
  // is currently in inventory/assemblyPlans at the moment the user types.
  enableInlineAutocomplete(outputInput, () => [...new Set([...Object.keys(app.inventory.other), ...Object.keys(app.assemblyPlans)])]);
  const rateLabel = el("label", { for: "assembly-rate-input", text: "Rate (units/hour):", style: "width: auto; white-space: nowrap;" });
  const rateInput = el("input", { id: "assembly-rate-input", type: "text", value: "1", style: "width:90px" });
  const capLevelInfo = el("div", { class: "status-text" });
  const researchInfo = el("div", { class: "status-text" });
  const saveStatus = el("div", { class: "status-text" });

  // Shown only while there are zero Assembly Plans - a first-time player
  // has no way to know this tab auto-populates from a live in-game screen
  // (see content.js's checkAssemblerPlans()/background.js's
  // handleAssemblerScrape()) rather than shipping with the data built in.
  // Deliberately just points at the game screen rather than bundling a
  // data snapshot with the extension - Forged Space changes weekly, and a
  // bundled snapshot would silently go stale until someone re-scrapes
  // anyway, so the one thing worth shipping is the instruction, not the
  // data itself.
  const emptyStateHint = el("div", { class: "info-banner" });
  function refreshEmptyStateHint() {
    emptyStateHint.textContent =
      Object.keys(app.assemblyPlans).length === 0
        ? 'No Assembly Plans yet - in-game, dock at a station with an Assembly service and open Assembly Facility (Configure Production). This tab fills in automatically from the plans listed there. Plans you haven\'t unlocked yet don\'t appear in-game, so add those by hand below.'
        : "";
  }

  function refreshCapLevelInfo() {
    capLevelInfo.textContent = editingCaptainLevel != null ? `Captain Level required: ${editingCaptainLevel}` : "";
  }

  // Short tag for the plan list, so locked/recipe-less plans stand out.
  function listTag(plan) {
    if (plan.isResearchLocked()) return " [not researched]";
    if (!plan.hasRecipe()) return " [no recipe yet]";
    return "";
  }

  function refreshResearchInfo() {
    const r = editingResearch;
    const plan = editingOutput ? app.assemblyPlans[editingOutput] : null;
    const lines = [];
    if (r && r.level === 0) {
      let text = "R&D: not researched yet - this plan can't be built at an Assembler.";
      if (r.skillRequired != null) text += ` Needs Research Skill ${r.skillRequired}.`;
      if (r.progress) text += ` Research progress: ${r.progress}${r.active ? " (in progress)" : ""}.`;
      lines.push(text);
    } else if (r) {
      lines.push(`R&D: researched to Level ${r.level}${r.progress ? ` (${r.progress} toward next level${r.active ? ", in progress" : ""})` : ""}.`);
    }
    if (plan && !plan.hasRecipe()) {
      lines.push("Recipe not known yet - it imports automatically once the plan shows up in the in-game Assembly Facility, or enter it below.");
    }
    researchInfo.textContent = lines.join(" ");
    researchInfo.className = `status-text ${r && r.level === 0 ? "status-warn" : ""}`;
  }

  // An Assembly Plan's own inputs can include another Assembly-produced
  // part, not just raw/refined catalog items - so that name needs to be
  // pickable here too, same reasoning as tab-blueprints.js's "Item:" field.
  function inputItemCandidates() {
    return [...new Set([...app.catalog.allItemNames(), ...Object.keys(app.assemblyPlans)])];
  }
  const inputDatalistId = "assembly-input-datalist";
  const inputDatalist = el("datalist", { id: inputDatalistId }, inputItemCandidates().map((n) => el("option", { value: n })));
  const inputItemLabel = el("label", { for: "assembly-input-item", text: "Item:" });
  const inputItemInput = el("input", { id: "assembly-input-item", type: "text", list: inputDatalistId, placeholder: "Start typing to search...", style: "flex: 1; min-width: 0;" });
  enableInlineAutocomplete(inputItemInput, inputItemCandidates);
  const inputQtyLabel = el("label", { for: "assembly-input-qty", text: "Qty per run:" });
  const inputQtyInput = el("input", { id: "assembly-input-qty", type: "text", value: "1", style: "width:70px" });

  const reqTbody = el("tbody");
  const reqTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Input Item", "Kind", "Qty per run"].map((h) => el("th", { text: h })))]),
    reqTbody,
  ]);

  function refreshOutputChoices() {
    clear(outputDatalist);
    const names = new Set([...Object.keys(app.inventory.other), ...Object.keys(app.assemblyPlans)]);
    for (const n of [...names].sort()) outputDatalist.appendChild(el("option", { value: n }));
  }

  function savedFor(name) {
    return name && app.assemblyPlans[name] ? { rate: app.assemblyPlans[name].ratePerHour, req: app.assemblyPlans[name].requirements } : { rate: null, req: {} };
  }

  function hasUnsavedChanges() {
    const saved = savedFor(editingOutput);
    const nameChanged = editingOutput !== null && outputInput.value.trim() !== editingOutput;
    const rateChanged = saved.rate !== null && parseFloat(rateInput.value) !== saved.rate;
    return nameChanged || rateChanged || JSON.stringify(saved.req) !== JSON.stringify(editingRequirements);
  }

  function confirmDiscard() {
    if (!hasUnsavedChanges()) return true;
    return confirm("Discard unsaved changes to this Assembly Plan?");
  }

  function refreshListbox() {
    clear(listSelect);
    for (const name of Object.keys(app.assemblyPlans).sort()) {
      listSelect.appendChild(el("option", { value: name, text: name + listTag(app.assemblyPlans[name]), selected: name === editingOutput ? "" : undefined }));
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
    editingCaptainLevel = null;
    editingResearch = null;
    outputInput.value = "";
    rateInput.value = "1";
    inputItemInput.value = "";
    inputQtyInput.value = "1";
    saveStatus.textContent = "";
    refreshTree();
    refreshListbox();
    refreshCapLevelInfo();
    refreshResearchInfo();
  }

  function newPlan() {
    if (!confirmDiscard()) return;
    clearEditor();
  }

  async function deletePlan() {
    if (!editingOutput) return;
    if (!confirm(`Delete Assembly Plan for "${editingOutput}"?`)) return;
    delete app.assemblyPlans[editingOutput];
    await storage.saveAssemblyPlans(app.assemblyPlans);
    clearEditor();
    refreshOutputChoices();
    refreshEmptyStateHint();
  }

  function loadIntoEditor(name) {
    if (name === editingOutput) return;
    if (!confirmDiscard()) {
      listSelect.value = editingOutput || "";
      return;
    }
    editingOutput = name;
    const plan = app.assemblyPlans[name];
    editingRequirements = { ...(plan?.requirements || {}) };
    editingCaptainLevel = plan?.captainLevel ?? null;
    editingResearch = plan?.research ?? null;
    outputInput.value = name;
    rateInput.value = String(plan?.ratePerHour ?? 1);
    saveStatus.textContent = "";
    refreshTree();
    refreshListbox();
    refreshCapLevelInfo();
    refreshResearchInfo();
  }

  function addInput() {
    const name = inputItemInput.value.trim();
    const qty = parseFloat(inputQtyInput.value);
    if (!name || Number.isNaN(qty) || qty <= 0) {
      alert("Enter an item name and a positive quantity.");
      return;
    }
    if (app.kindLabel(name) === "Commodity") {
      alert(`"${name}" isn't a known ore, refined material, or planetary resource - it will be tracked as a Commodity, unless it also has its own Assembly Plan.`);
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
    const plan = new AssemblyPlan(outputItem, rate);
    for (const [itemName, qty] of Object.entries(editingRequirements)) plan.setRequirement(itemName, qty);
    plan.captainLevel = editingCaptainLevel;
    plan.research = editingResearch;
    if (editingOutput && editingOutput !== outputItem) delete app.assemblyPlans[editingOutput];
    app.assemblyPlans[outputItem] = plan;
    await storage.saveAssemblyPlans(app.assemblyPlans);
    editingOutput = outputItem;
    refreshListbox();
    refreshOutputChoices();
    refreshEmptyStateHint();
    // Inline, non-blocking - unlike the alert()s above (genuine input
    // errors worth interrupting for), a routine successful save shouldn't
    // make the player click through a dialog every single time.
    saveStatus.textContent = `Saved Assembly Plan for "${outputItem}".`;
    saveStatus.className = "status-text status-ok";
  }

  listSelect.addEventListener("change", () => loadIntoEditor(listSelect.value));

  container.appendChild(emptyStateHint);
  container.appendChild(
    el("div", { class: "split-layout" }, [
      el("div", { class: "side-list" }, [
        listSelectLabel,
        listSelect,
        el("div", { class: "toolbar" }, [
          el("button", { text: "New", onclick: newPlan }),
          el("button", { class: "danger", text: "Delete", onclick: deletePlan }),
        ]),
      ]),
      el("div", { class: "detail-panel" }, [
        el("div", { class: "hint", text: "Assembly produces a Commodity in one-hour runs: each run costs the listed inputs once and yields Rate (units/hour) units." }),
        el("div", { class: "field-row" }, [outputLabel, outputInput]),
        outputDatalist,
        el("div", { class: "field-row" }, [rateLabel, rateInput]),
        capLevelInfo,
        researchInfo,
        el("div", { class: "toolbar" }, [inputItemLabel, inputItemInput, inputQtyLabel, inputQtyInput, el("button", { text: "Add / Update", onclick: addInput })]),
        inputDatalist,
        el("div", { class: "scroll-table" }, [reqTable]),
        el("div", { class: "toolbar" }, [
          el("button", { text: "Remove Selected Input", onclick: removeSelected }),
          el("button", { text: "Save Assembly Plan", onclick: saveEditor }),
        ]),
        saveStatus,
      ]),
    ])
  );

  refreshOutputChoices();
  refreshListbox();
  refreshTree();
  refreshCapLevelInfo();
  refreshResearchInfo();
  refreshEmptyStateHint();

  // Also refreshes the saved-list (not the in-progress edit form) when
  // assemblyPlans change externally - e.g. an Assembler Plans import from
  // background.js while this tab is already open.
  app.refreshHooks.assembly = () => {
    refreshOutputChoices();
    refreshListbox();
    refreshEmptyStateHint();
    // R&D status isn't editable in the form, so it's safe to pick up a fresh
    // scrape for the plan being viewed (e.g. it just got unlocked).
    if (editingOutput && app.assemblyPlans[editingOutput]) {
      editingResearch = app.assemblyPlans[editingOutput].research ?? null;
      refreshResearchInfo();
    }
  };
}
