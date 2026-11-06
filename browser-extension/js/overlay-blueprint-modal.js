// In-page "Add to Build" modal - a quick-access alternative to switching
// over to the dashboard's Plan a Build tab just to add something to the
// active build. Opened from the Manifest overlay's "Add to Build" button
// (see overlay-manifest.js); renders directly into the game page (own
// Shadow DOM host, same reasoning as the Manifest overlay itself - see
// content.js's header comment) so it never requires leaving the game or
// switching tabs.
//
// Adds a saved blueprint (scaled by qty) or an ad-hoc item+qty directly to
// whichever build is currently active in Plan a Build (same entry shape
// addBlueprintToPlan()/addMaterialToPlan() already produce there, so
// anything added here is fully visible/editable from the dashboard
// afterward too). Blueprints themselves aren't entered here - they come
// from the game's blueprint stores.
//
// Content scripts have direct browser.storage.local access (the "storage"
// permission covers the whole extension, not just its own pages), so this
// reads/writes storage.js the exact same way every dashboard tab does - no
// messaging round trip through background.js needed.

import { el, clear, enableInlineAutocomplete } from "./dom-helpers.js";
import { Catalog } from "./catalog.js";
import * as storage from "./storage.js";

const MAX_Z_INDEX = 2147483647;

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .fsc-backdrop {
    position: fixed;
    inset: 0;
    z-index: ${MAX_Z_INDEX};
    background: transparent;
    display: none;
    align-items: center;
    justify-content: center;
    /* Invisible AND click-through - the whole point of a transparent
       backdrop is so the game (and any other in-game window) stays fully
       visible AND usable while this is open, e.g. reading a blueprint off
       another panel. Only the modal itself (see .fsc-modal below) opts back
       into receiving pointer events. */
    pointer-events: none;
  }
  .fsc-backdrop.fsc-visible { display: flex; }
  .fsc-modal {
    pointer-events: auto;
    width: min(480px, 92vw);
    max-height: 85vh;
    overflow-y: auto;
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    font: 13px system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .fsc-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #334155;
    background: #1e293b;
    border-radius: 10px 10px 0 0;
    cursor: move;
  }
  .fsc-modal-header h2 {
    margin: 0;
    font-size: 14px;
    color: #67e8f9;
  }
  .fsc-modal-body {
    padding: 12px;
  }
  .fsc-field-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .fsc-field-row label {
    color: #94a3b8;
    font-size: 12px;
    white-space: nowrap;
  }
  .fsc-field-row input, .fsc-field-row select {
    flex: 1 1 auto;
    min-width: 0;
    background: #172033;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 5px;
    padding: 4px 6px;
    font-size: 12px;
  }
  .fsc-field-row input:focus, .fsc-field-row select:focus {
    outline: none;
    border-color: #22d3ee;
  }
  .fsc-qty-input { flex: 0 0 60px !important; }
  button {
    background: #172033;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 5px;
    padding: 4px 9px;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover { border-color: #22d3ee; }
  button.fsc-primary { border-color: #22d3ee; color: #67e8f9; }
  button.fsc-danger { border-color: #f87171; color: #f87171; }
  .fsc-close-btn { font-size: 14px; padding: 3px 8px; }
  .fsc-status {
    font-size: 12px;
    color: #94a3b8;
    min-height: 16px;
    margin-top: 4px;
  }
  .fsc-status.fsc-ok { color: #4ade80; }
  .fsc-hint {
    color: #94a3b8;
    font-size: 11px;
    margin-bottom: 8px;
  }
`;

let shadowRoot = null;
let backdropEl = null;
let modalEl = null;
let bodyEl = null;
let catalog = null;
let blueprints = {};
let assemblyPlans = {};
let builds = {};
let activeBuildName = null;
let buildLabels = {}; // buildId -> custom display name, mirrors storage.js's `buildLabels` key

function ensureHost() {
  if (shadowRoot) return;
  const host = document.createElement("div");
  host.id = "fsc-blueprint-modal-host";
  document.documentElement.appendChild(host);
  shadowRoot = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  shadowRoot.appendChild(style);
  // No click-outside-to-close here - the backdrop is pointer-events:none
  // (see STYLE above), so it never receives clicks at all. Escape and the
  // header's close button (below) are the only ways to dismiss.
  backdropEl = el("div", { class: "fsc-backdrop" });
  shadowRoot.appendChild(backdropEl);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && backdropEl.classList.contains("fsc-visible")) closeModal();
  });

  // The modal shell (header + drag handling) is built once here rather than
  // in renderModal(), which reruns on every open - attaching makeDraggable's
  // document-level mousemove/mouseup listeners there would pile up a fresh,
  // never-removed pair every time the modal is opened.
  const closeBtn = el("button", { class: "fsc-close-btn", text: "×", title: "Close", onclick: closeModal });
  const header = el("div", { class: "fsc-modal-header" }, [el("h2", { text: "Add to Active Build" }), closeBtn]);
  bodyEl = el("div", { class: "fsc-modal-body" });
  modalEl = el("div", { class: "fsc-modal" }, [header, bodyEl]);
  modalEl.addEventListener("mousedown", (e) => e.stopPropagation());
  backdropEl.appendChild(modalEl);
  makeDraggable(modalEl, header);
}

// Drag-to-reposition via the header, same pattern as the Manifest overlay's
// own panel (overlay-manifest.js's makeDraggable) - lets the modal be moved
// off to the side so it doesn't block the Manifest overlay or game content
// underneath. The modal starts centered by the
// backdrop's flex layout; switching to position:fixed with an explicit
// left/top the moment a drag starts takes it out of that flow without a
// visible jump, since the rect is read before anything changes.
function makeDraggable(modal, handle) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return; // don't start a drag from a header button click
    dragging = true;
    const rect = modal.getBoundingClientRect();
    modal.style.position = "fixed";
    modal.style.margin = "0";
    modal.style.left = `${rect.left}px`;
    modal.style.top = `${rect.top}px`;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const maxLeft = window.innerWidth - 40;
    const maxTop = window.innerHeight - 40;
    const left = Math.min(Math.max(0, startLeft + (e.clientX - startX)), maxLeft);
    const top = Math.min(Math.max(0, startTop + (e.clientY - startY)), maxTop);
    modal.style.left = `${left}px`;
    modal.style.top = `${top}px`;
  });
  document.addEventListener("mouseup", () => {
    dragging = false;
  });
}

function closeModal() {
  backdropEl.classList.remove("fsc-visible");
}

async function loadLiveData() {
  if (!catalog) catalog = new Catalog();
  // Re-applied every open (idempotent/additive - see catalog.js's
  // applyScrapedPlanetTypes()), not just on first creation, so a scrape
  // that happened after this modal's catalog was first built still shows
  // up the next time it's opened - matches blueprints/assemblyPlans/builds
  // below, all reloaded fresh on every open too.
  catalog.applyScrapedPlanetTypes(await storage.loadScrapedPlanetTypes());
  blueprints = await storage.loadBlueprints();
  assemblyPlans = await storage.loadAssemblyPlans();
  builds = await storage.loadBuilds();
  activeBuildName = await storage.loadActiveBuildName();
  buildLabels = await storage.loadBuildLabels();
}

export async function openAddToBuildModal() {
  ensureHost();
  await loadLiveData();
  renderModal();
  backdropEl.classList.add("fsc-visible");
}

function itemCandidates() {
  return [...new Set([...catalog.allItemNames(), ...Object.keys(assemblyPlans)])];
}

function renderModal() {
  clear(bodyEl);
  bodyEl.append(buildAddToPlanSection());
}

// ---- Add to active build ----
let addToPlanBlueprintSelect = null;

function refreshAddToPlanBlueprintOptions() {
  if (!addToPlanBlueprintSelect) return;
  clear(addToPlanBlueprintSelect);
  for (const name of Object.keys(blueprints).sort()) addToPlanBlueprintSelect.appendChild(el("option", { value: name, text: name }));
}

function buildAddToPlanSection() {
  if (!activeBuildName) {
    return el("div", {}, [el("div", { class: "fsc-hint", text: "No active build - open the dashboard's Plan a Build tab to create/select one first." })]);
  }

  const status = el("div", { class: "fsc-status" });

  addToPlanBlueprintSelect = el("select", {});
  refreshAddToPlanBlueprintOptions();
  const blueprintQtyInput = el("input", { class: "fsc-qty-input", type: "text", value: "1" });
  async function addBlueprintToPlan() {
    const name = addToPlanBlueprintSelect.value;
    const qty = parseFloat(blueprintQtyInput.value);
    if (!name || Number.isNaN(qty) || qty <= 0) {
      status.textContent = "Choose a blueprint and enter a positive quantity.";
      status.className = "fsc-status";
      return;
    }
    builds[activeBuildName] = builds[activeBuildName] || [];
    builds[activeBuildName].push(["blueprint", name, qty]);
    await storage.saveBuilds(builds);
    status.textContent = `Added ${qty}× "${name}" to build "${buildLabels[activeBuildName] || activeBuildName}".`;
    status.className = "fsc-status fsc-ok";
  }
  const addBlueprintBtn = el("button", { class: "fsc-primary", text: "Add", onclick: addBlueprintToPlan });

  const itemDatalistId = "fsc-plan-item-list";
  const itemDatalist = el("datalist", { id: itemDatalistId }, itemCandidates().map((n) => el("option", { value: n })));
  const materialInput = el("input", { type: "text", list: itemDatalistId, placeholder: "Item name" });
  enableInlineAutocomplete(materialInput, itemCandidates);
  const materialQtyInput = el("input", { class: "fsc-qty-input", type: "text", value: "1" });
  async function addMaterialToPlan() {
    const name = materialInput.value.trim();
    const qty = parseFloat(materialQtyInput.value);
    if (!name || Number.isNaN(qty) || qty <= 0) {
      status.textContent = "Enter an item name and a positive quantity.";
      status.className = "fsc-status";
      return;
    }
    builds[activeBuildName] = builds[activeBuildName] || [];
    builds[activeBuildName].push(["material", name, qty]);
    await storage.saveBuilds(builds);
    materialInput.value = "";
    materialQtyInput.value = "1";
    status.textContent = `Added ${qty}× "${name}" to build "${buildLabels[activeBuildName] || activeBuildName}".`;
    status.className = "fsc-status fsc-ok";
  }
  const addItemBtn = el("button", { class: "fsc-primary", text: "Add", onclick: addMaterialToPlan });

  return el("div", {}, [
    el("div", { class: "fsc-hint", text: `Adding to build "${buildLabels[activeBuildName] || activeBuildName}".` }),
    el("div", { class: "fsc-field-row" }, [el("label", { text: "Blueprint:" }), addToPlanBlueprintSelect, blueprintQtyInput, addBlueprintBtn]),
    el("div", { class: "fsc-field-row" }, [el("label", { text: "Item:" }), materialInput, materialQtyInput, addItemBtn]),
    itemDatalist,
    status,
  ]);
}
