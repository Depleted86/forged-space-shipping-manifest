// Blueprints tab - read-only viewer for the blueprints the game's stores
// have been seen to sell. Fed entirely by the Blueprint Store scrape (see
// background.js's handleBlueprintStoreScrape()): a store list adds every
// blueprint with its ownership, and opening one in the store's detail panel
// imports its materials. There's no hand entry - a blueprint with no
// materials yet just says which store to open it in.

import { el, clear } from "./dom-helpers.js";
import { blueprintShipClasses, inShipClass, shipClassLabel, groupBlueprintNames, blueprintImportHint } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initBlueprintsTab(app, container) {
  let viewingBlueprint = null; // name of the blueprint shown, or null

  const blueprintSelectLabel = el("label", { for: "blueprints-list", class: "visually-hidden", text: "Saved blueprints" });
  const blueprintSelect = el("select", { id: "blueprints-list", size: "20", class: "list-select" });
  // Narrows the (long, store-fed) list to one ship class - see
  // blueprintShipClasses() in calc-engine.js.
  const classFilterLabel = el("label", { for: "blueprints-class-filter", text: "Class:", style: "width: auto; white-space: nowrap;" });
  const classFilter = el("select", { id: "blueprints-class-filter", style: "flex: 1; min-width: 0;" });
  classFilter.addEventListener("change", () => refreshListbox());
  // The player's skills and Captain level, as last read from the game
  // (Character Skills window / HUD) - shown, not editable.
  const skillsInfo = el("div", { class: "hint" });
  function refreshSkillsInfo() {
    const show = (n) => n ?? "?";
    skillsInfo.textContent = `Your Manufacturing ${show(app.settings.manufacturing_skill)}, Engineering ${show(app.settings.engineering_skill)}, Captain level ${show(app.settings.captain_level)} - read from the game's Character Skills window and top bar.`;
  }

  const nameHeading = el("h3", { class: "section-title" });
  const capLevelInfo = el("div", { class: "status-text" });
  const storeInfo = el("div", { class: "status-text" });
  const importHint = el("div", { class: "info-banner" });

  function viewed() {
    return viewingBlueprint ? app.blueprints[viewingBlueprint] : null;
  }

  function refreshCapLevelInfo() {
    const need = viewed()?.captainLevel ?? null;
    const have = app.settings.captain_level;
    const tooLow = need != null && have != null && need > have;
    capLevelInfo.textContent = need != null
      ? `Captain Level required: ${need}${tooLow ? ` - yours is ${have}, too low.` : ""}`
      : "";
    capLevelInfo.className = `status-text ${tooLow ? "status-warn" : ""}`;
  }

  // Above the player's Captain level (read from the game's HUD).
  function captainTooLow(blueprint) {
    const have = app.settings.captain_level;
    return blueprint.captainLevel != null && have != null && blueprint.captainLevel > have;
  }

  // Too high for the player's Manufacturing Skill (when both are known) -
  // the game sells these, but they can't be run until the skill catches up.
  function skillTooLow(blueprint) {
    const need = blueprint.store?.mfgSkill;
    const have = app.settings.manufacturing_skill;
    return need != null && have != null && need > have;
  }

  // Short tag for the list, so unowned/recipe-less blueprints stand out.
  function listTag(blueprint) {
    if (skillTooLow(blueprint)) return " [skill too low]";
    if (captainTooLow(blueprint)) return " [captain level too low]";
    if (!blueprint.hasRecipe()) return " [no recipe yet]";
    if (blueprint.store && !blueprint.store.owned) return " [not owned]";
    return "";
  }

  // Blueprint Store status for the blueprint being viewed.
  function refreshStoreInfo() {
    const blueprint = viewed();
    const st = blueprint?.store ?? null;
    const lines = [];
    if (st) {
      const details = [st.shipClass, st.buildLimit != null ? `build limit ${st.buildLimit}` : null].filter(Boolean).join(", ");
      lines.push(`${st.owned ? `Owned (${st.copies} ${st.copies === 1 ? "copy" : "copies"})` : "Not owned - buy it at a Blueprint Store before you can manufacture it."}${details ? ` [${details}]` : ""}`);
    }
    if (st?.mfgSkill != null) {
      const have = app.settings.manufacturing_skill;
      lines.push(`Requires Manufacturing Skill ${st.mfgSkill}${have != null && st.mfgSkill > have ? ` - yours is ${have}, too low to run this.` : "."}`);
    }
    const cr = (n) => `${n.toLocaleString()} cr`;
    if (st?.price != null) {
      const discounted = st.basePrice != null && st.basePrice !== st.price;
      lines.push(`Blueprint price: ${cr(st.price)}${discounted ? ` (base ${cr(st.basePrice)}, -${st.discountPct}%)` : ""}.`);
    }
    if (st?.buildCost != null) {
      lines.push(`Build cost at today's prices: ${cr(st.buildCost)}${st.guideValue != null ? ` (guide value ${cr(st.guideValue)})` : ""}.`);
    }
    if (st?.shipValue != null) lines.push(`Ship value: ${cr(st.shipValue)}.`);
    if (st?.engReq != null) {
      const have = app.settings.engineering_skill;
      lines.push(`Fitting needs Engineering ${st.engReq}${have != null && st.engReq > have ? ` - yours is ${have}, too low to fit it.` : "."}`);
    }
    storeInfo.textContent = lines.join(" ");
    const engTooLow = st?.engReq != null && app.settings.engineering_skill != null && st.engReq > app.settings.engineering_skill;
    storeInfo.className = `status-text ${(st && !st.owned) || engTooLow || (blueprint && skillTooLow(blueprint)) ? "status-warn" : ""}`;
  }

  const reqTbody = el("tbody");
  const reqTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Item", "Kind", "Qty"].map((h) => el("th", { text: h })))]),
    reqTbody,
  ]);

  function refreshClassFilter() {
    const current = classFilter.value;
    clear(classFilter);
    for (const c of ["", ...blueprintShipClasses(app.blueprints)]) classFilter.appendChild(el("option", { value: c, text: shipClassLabel(c) }));
    // Keep the choice unless that class has disappeared.
    classFilter.value = [...classFilter.options].some((o) => o.value === current) ? current : "";
  }

  function refreshListbox() {
    refreshClassFilter();
    clear(blueprintSelect);
    const inClass = (name) => inShipClass(app.blueprints[name], classFilter.value);
    // Sorted by Manufacturing Skill needed (unknown last), then name, with
    // the skill shown up front so a too-high one is obvious before buying.
    const skillOf = (name) => app.blueprints[name].store?.mfgSkill ?? Infinity;
    const names = Object.keys(app.blueprints).filter(inClass).sort((a, b) => skillOf(a) - skillOf(b) || a.localeCompare(b));
    // Grouped by the store each came from (Blueprints, Ships, ...).
    for (const [group, groupNames] of groupBlueprintNames(names, app.blueprints)) {
      const optgroup = el("optgroup", { label: group });
      for (const name of groupNames) {
        const skill = app.blueprints[name].store?.mfgSkill;
        const prefix = skill != null ? `[Mfg ${skill}] ` : "[Mfg ?] ";
        optgroup.appendChild(el("option", { value: name, text: prefix + name + listTag(app.blueprints[name]), selected: name === viewingBlueprint ? "" : undefined }));
      }
      blueprintSelect.appendChild(optgroup);
    }
    blueprintSelect.value = viewingBlueprint || "";
  }

  // Everything about the viewed blueprint - name, requirements, store and
  // Captain level info, and the "open it in its store" hint when its
  // materials haven't been imported yet.
  function refreshDetail() {
    const blueprint = viewed();
    nameHeading.textContent = viewingBlueprint || "Pick a blueprint from the list";
    clear(reqTbody);
    const requirements = blueprint?.requirements || {};
    for (const name of Object.keys(requirements).sort()) {
      reqTbody.appendChild(el("tr", {}, [el("td", { text: name }), el("td", { text: app.kindLabel(name) }), el("td", { text: String(requirements[name]) })]));
    }
    reqTable.style.display = blueprint && blueprint.hasRecipe() ? "" : "none";
    importHint.textContent = blueprint && !blueprint.hasRecipe() ? blueprintImportHint(blueprint) : "";
    importHint.style.display = importHint.textContent ? "" : "none";
    refreshCapLevelInfo();
    refreshStoreInfo();
  }

  async function deleteBlueprint() {
    if (!viewingBlueprint) return;
    if (!confirm(`Delete blueprint "${viewingBlueprint}"? It comes back the next time a store lists it.`)) return;
    delete app.blueprints[viewingBlueprint];
    await storage.saveBlueprints(app.blueprints);
    viewingBlueprint = null;
    refreshListbox();
    refreshDetail();
    if (app.refreshHooks.planBlueprintCombo) app.refreshHooks.planBlueprintCombo();
  }

  blueprintSelect.addEventListener("change", () => {
    viewingBlueprint = blueprintSelect.value || null;
    refreshDetail();
  });

  container.appendChild(
    el("div", { class: "split-layout" }, [
      el("div", { class: "side-list" }, [
        skillsInfo,
        el("div", { class: "field-row" }, [classFilterLabel, classFilter]),
        blueprintSelectLabel,
        blueprintSelect,
        el("div", { class: "toolbar" }, [el("button", { class: "danger", text: "Delete", onclick: deleteBlueprint })]),
      ]),
      el("div", { class: "detail-panel" }, [
        el("div", { class: "hint", text: "Blueprints fill in from the in-game blueprint stores. Opening a blueprint there imports its materials." }),
        nameHeading,
        capLevelInfo,
        storeInfo,
        importHint,
        el("div", { class: "scroll-table" }, [reqTable]),
      ]),
    ])
  );

  refreshSkillsInfo();
  refreshListbox();
  refreshDetail();

  // Skills/Captain level changed (a Character Skills or HUD read).
  app.refreshHooks.blueprintsSkill = () => {
    refreshSkillsInfo();
    refreshListbox();
    refreshDetail();
  };

  // Blueprints changed externally - e.g. a store scrape while this tab is
  // open (see dashboard.js's storage.onChanged listener).
  app.refreshHooks.blueprints = () => {
    if (viewingBlueprint && !app.blueprints[viewingBlueprint]) viewingBlueprint = null;
    refreshListbox();
    refreshDetail();
  };
}
