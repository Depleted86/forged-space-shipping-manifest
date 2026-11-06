// Assembly tab - read-only viewer for AssemblyPlan objects (continuous
// production rate + per-run input costs). Fed entirely by the game: the
// Assembly Facility's Configure Production screen (background.js's
// handleAssemblerScrape()) imports each plan's rate and inputs, and the R&D
// Office's Select Research Plan list (handleResearchScrape()) adds plans
// that aren't researched yet. There's no hand entry.

import { el, clear } from "./dom-helpers.js";
import * as storage from "./storage.js";

export function initAssemblyTab(app, container) {
  let viewingOutput = null; // output item name shown, or null

  const listSelectLabel = el("label", { for: "assembly-list", class: "visually-hidden", text: "Saved Assembly Plans" });
  const listSelect = el("select", { id: "assembly-list", size: "20", class: "list-select" });
  const nameHeading = el("h3", { class: "section-title" });
  const rateInfo = el("div", { class: "status-text" });
  const capLevelInfo = el("div", { class: "status-text" });
  const researchInfo = el("div", { class: "status-text" });

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
        ? "No Assembly Plans yet - in-game, dock at a station with an Assembly service and open Assembly Facility (Configure Production). This tab fills in automatically from the plans listed there, and from the R&D Office's Select Research Plan list."
        : "";
    emptyStateHint.style.display = emptyStateHint.textContent ? "" : "none";
  }

  function viewed() {
    return viewingOutput ? app.assemblyPlans[viewingOutput] : null;
  }

  // Short tag for the plan list, so locked/recipe-less plans stand out.
  function listTag(plan) {
    if (plan.isResearchLocked()) return " [not researched]";
    if (!plan.hasRecipe()) return " [no recipe yet]";
    return "";
  }

  function refreshResearchInfo() {
    const plan = viewed();
    const r = plan?.research ?? null;
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
      lines.push("Recipe not known yet - it imports automatically once the plan shows up in the in-game Assembly Facility (Configure Production).");
    }
    researchInfo.textContent = lines.join(" ");
    researchInfo.className = `status-text ${r && r.level === 0 ? "status-warn" : ""}`;
  }

  const reqTbody = el("tbody");
  const reqTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Input Item", "Kind", "Qty per run"].map((h) => el("th", { text: h })))]),
    reqTbody,
  ]);

  function refreshListbox() {
    clear(listSelect);
    for (const name of Object.keys(app.assemblyPlans).sort()) {
      listSelect.appendChild(el("option", { value: name, text: name + listTag(app.assemblyPlans[name]), selected: name === viewingOutput ? "" : undefined }));
    }
    listSelect.value = viewingOutput || "";
  }

  function refreshDetail() {
    const plan = viewed();
    nameHeading.textContent = viewingOutput || "Pick an Assembly Plan from the list";
    rateInfo.textContent = plan && plan.hasRecipe() ? `Rate: ${plan.ratePerHour} units/hour (one run per hour).` : "";
    capLevelInfo.textContent = plan?.captainLevel != null ? `Captain Level required: ${plan.captainLevel}` : "";
    clear(reqTbody);
    const requirements = plan?.requirements || {};
    for (const name of Object.keys(requirements).sort()) {
      reqTbody.appendChild(el("tr", {}, [el("td", { text: name }), el("td", { text: app.kindLabel(name) }), el("td", { text: String(requirements[name]) })]));
    }
    reqTable.style.display = plan && plan.hasRecipe() ? "" : "none";
    refreshResearchInfo();
  }

  async function deletePlan() {
    if (!viewingOutput) return;
    if (!confirm(`Delete Assembly Plan for "${viewingOutput}"? It comes back the next time the game lists it.`)) return;
    delete app.assemblyPlans[viewingOutput];
    await storage.saveAssemblyPlans(app.assemblyPlans);
    viewingOutput = null;
    refreshListbox();
    refreshDetail();
    refreshEmptyStateHint();
  }

  listSelect.addEventListener("change", () => {
    viewingOutput = listSelect.value || null;
    refreshDetail();
  });

  container.appendChild(emptyStateHint);
  container.appendChild(
    el("div", { class: "split-layout" }, [
      el("div", { class: "side-list" }, [
        listSelectLabel,
        listSelect,
        el("div", { class: "toolbar" }, [el("button", { class: "danger", text: "Delete", onclick: deletePlan })]),
      ]),
      el("div", { class: "detail-panel" }, [
        el("div", { class: "hint", text: "Assembly produces a Commodity in one-hour runs: each run costs the listed inputs once and yields Rate (units/hour) units." }),
        nameHeading,
        rateInfo,
        capLevelInfo,
        researchInfo,
        el("div", { class: "scroll-table" }, [reqTable]),
      ]),
    ])
  );

  refreshListbox();
  refreshDetail();
  refreshEmptyStateHint();

  // assemblyPlans changed externally - e.g. an Assembly Facility or R&D
  // import from background.js while this tab is already open.
  app.refreshHooks.assembly = () => {
    if (viewingOutput && !app.assemblyPlans[viewingOutput]) viewingOutput = null;
    refreshListbox();
    refreshDetail();
    refreshEmptyStateHint();
  };
}
