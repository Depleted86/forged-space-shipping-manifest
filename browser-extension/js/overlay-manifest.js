// In-page "Manifest" overlay - the direct replacement for the old floating
// popup.html/popup.js window (removed - see content.js's header comment for
// why: OS-level "always on top" isn't a real WebExtension capability, so
// that window only ever stayed above the game on setups where the user's
// own window manager happened to provide it themselves). Same content, same
// live storage-driven rendering - just hosted in a Shadow DOM appended
// directly into the game page instead of a separate browser window, so it's
// guaranteed to render above the game everywhere with no window-manager
// cooperation needed, and positioned/sized with plain CSS (drag + internal
// scroll) instead of async browser.windows.update() calls, which sidesteps
// every timing/race issue that class of API had on Chrome.
//
// Two pieces live in the shadow root: a small always-visible edge handle
// (the discoverable way to find this if you didn't know to use the toolbar
// icon) and the actual panel (hidden until toggled on) - see
// initManifestOverlay() for both. Rendering itself - renderPersonalRow(),
// buildBatchControls(), renderRefinedGroups(), etc. - is a near-verbatim
// port of the old popup.js: same data (manifestToMineData/manifestCorpToMineData
// from browser.storage.local, which content scripts already have direct
// access to - no messaging round trip needed just to read/write it), same
// suppress-while-editing-a-batch-input guard, same section/sub-label
// grouping. Only the window-sizing math (resizeToFit()/performResize()) is
// gone - there's no OS window to size here, just a CSS box.

import { openAddBlueprintModal } from "./overlay-blueprint-modal.js";
import { Catalog } from "./catalog.js";
import * as storage from "./storage.js";
import { formatHours } from "./dom-helpers.js";

const MAX_Z_INDEX = 2147483647; // largest valid CSS z-index - guarantees this paints above anything the game's own page sets, regardless of its own stacking contexts

// Only needed for the Refined section's per-material ore `<select>`
// (catalog.findMaterial(name).sources) and the selection dropdown's Blueprint
// tooltip - construction is synchronous/cheap (builds static in-memory
// indices, no I/O), same as background.js's own module-level instance.
const catalog = new Catalog();
// Fire-and-forget - overlays whatever's already been scraped from the
// Systems Lexicon on top of the static baseline (see catalog.js's
// applyScrapedPlanetTypes() comment). Not re-applied live on further
// scrapes - this overlay only uses the catalog for material/ore lookups,
// never planet types directly, so staying fresh as of whenever it was last
// opened is enough.
storage.loadScrapedPlanetTypes().then((scraped) => catalog.applyScrapedPlanetTypes(scraped));

let shadowRoot = null;
let panelEl = null;
let listEl = null;
let personalBtn = null;
let corpBtn = null;
let edgeHandleEl = null;
let selectionRowEl = null;
let selectionSelectEl = null;
let selectionInfoEl = null;
let markCompleteBtn = null;
let corpSelectionRowEl = null;
let corpSelectionSelectEl = null;
let corpSelectionInfoEl = null;
let viewToggleEl = null;
let addBlueprintBtn = null;
let dashboardBtn = null;
let titleEl = null;
// Set only while an item is focused AND the panel currently has a
// user-resized (fixed pixel) height - see render()'s "shrink to fit" logic.
// Restored the instant focus mode ends, so a manual resize (via the corner
// handles) is never permanently lost just because the user focused
// something in the meantime.
let stashedPanelHeight = null;
// True for the entire time focus mode's chrome (view toggle/Farm rows/
// header buttons) is hidden - NOT the same thing as `focusedItem` being
// truthy on any given render() call. The stash-height logic above must only
// fire on the actual TRANSITION into focus mode, not on every re-render
// while already there (e.g. the ~2s background inventory sync) - otherwise
// a resize the user makes WHILE ALREADY focused gets immediately treated as
// "the old size to restore later" and silently wiped back to natural size
// on the very next unrelated re-render, which is exactly the "resize
// stretches fine once but then won't shrink again" bug this flag fixes.
let focusChromeActive = false;

let currentView = "personal"; // "personal" | "corp"
// Row-level "focus" - clicking an item in EITHER view hides every other row
// (across every section, not just its own) so the panel can be shrunk down
// to show just that one thing, useful on a smaller screen where the full
// list eats too much space. Works identically in Personal Farm and Corp -
// see renderFocusedItem()'s two branches. { section, name } | null -
// `section` disambiguates since names aren't guaranteed unique ACROSS
// sections (only within one). Not itself tagged with which view set it -
// simpler to just clear it on every view-toggle click instead (see
// personalBtn's/corpBtn's own click handlers) than to carry that around and
// re-check it everywhere.
let focusedItem = null;
let personalData = { available: false };
let corpData = { available: false, items: [] };
let overlayVisible = false;
let builds = {}; // buildName -> [[kind, itemName, qty], ...], mirrors storage.js's `builds` key
let blueprints = {}; // blueprintName -> Blueprint, mirrors storage.js's `blueprints` key
let buildLabels = {}; // buildId -> custom display name, mirrors storage.js's `buildLabels` key
let manifestSelection = null; // { type: "build"|"blueprint", name: string } | null - see storage.js
let manifestCorpSelection = null; // Corp-view counterpart - { type: "build"|"blueprint", name: string } | null, see storage.js's manifestCorpSelection
// render() fully rebuilds the row list on every storage change - live
// inventory syncs fire every ~2s while the game's storage screen is open,
// which would otherwise destroy a batch-count <input> mid-type (same class
// of bug tab-planets.js's harvester roster and this exact file's popup.js
// predecessor both hit). Suppressed while that input has focus; storage
// data still updates underneath, the next render() (on blur) reflects it.
let suppressRenderWhileEditing = false;

const STYLE = `
  :host {
    all: initial;
  }
  * {
    box-sizing: border-box;
  }
  .fsc-edge-handle {
    position: fixed;
    top: 40%;
    right: 0;
    z-index: ${MAX_Z_INDEX};
    background: #1e293b;
    color: #67e8f9;
    border: 1px solid #334155;
    border-right: none;
    border-radius: 8px 0 0 8px;
    padding: 10px 6px;
    font: 600 12px system-ui, -apple-system, "Segoe UI", sans-serif;
    letter-spacing: 0.04em;
    writing-mode: vertical-rl;
    text-orientation: mixed;
    cursor: pointer;
    user-select: none;
  }
  .fsc-edge-handle:hover {
    color: #e2e8f0;
    border-color: #22d3ee;
  }
  .fsc-edge-handle.fsc-hidden {
    display: none;
  }
  .fsc-panel {
    position: fixed;
    top: 80px;
    right: 40px;
    z-index: ${MAX_Z_INDEX};
    display: none;
    flex-direction: column;
    width: fit-content;
    min-width: 280px;
    max-width: 420px;
    max-height: 75vh;
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    font: 13px system-ui, -apple-system, "Segoe UI", sans-serif;
    overflow: hidden;
  }
  .fsc-panel.fsc-visible {
    display: flex;
  }
  .fsc-resize-handle {
    position: absolute;
    bottom: 1px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: #475569;
    user-select: none;
    z-index: 1;
  }
  .fsc-resize-handle:hover {
    color: #22d3ee;
  }
  .fsc-resize-handle-left {
    left: 1px;
    cursor: sw-resize;
  }
  .fsc-resize-handle-right {
    right: 1px;
    cursor: se-resize;
  }
  .fsc-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid #334155;
    background: #1e293b;
    cursor: move;
  }
  .fsc-header h1 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #67e8f9;
    white-space: nowrap;
  }
  .fsc-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .fsc-header button {
    background: #172033;
    color: #94a3b8;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
  }
  .fsc-header button:hover {
    color: #e2e8f0;
    border-color: #22d3ee;
  }
  .fsc-close-btn {
    padding: 4px 7px !important;
    font-size: 13px !important;
    line-height: 1;
  }
  .fsc-selection-row {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #172033;
    border-bottom: 1px solid #334155;
  }
  .fsc-selection-row.fsc-hidden {
    display: none;
  }
  .fsc-selection-row label {
    font-size: 12px;
    color: #94a3b8;
    white-space: nowrap;
  }
  .fsc-selection-select {
    flex: 1 1 auto;
    min-width: 0;
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 12px;
  }
  .fsc-selection-select:focus {
    outline: none;
    border-color: #22d3ee;
  }
  .fsc-info-icon {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid #475569;
    color: #94a3b8;
    font-size: 11px;
    font-style: normal;
    cursor: help;
    user-select: none;
  }
  .fsc-info-icon:hover, .fsc-info-icon:focus-visible {
    color: #67e8f9;
    border-color: #22d3ee;
    outline: none;
  }
  .fsc-refresh-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: #172033;
    color: #94a3b8;
    border: 1px solid #334155;
    border-radius: 5px;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }
  .fsc-refresh-btn:hover, .fsc-refresh-btn:focus-visible {
    color: #67e8f9;
    border-color: #22d3ee;
    outline: none;
  }
  .fsc-mark-complete-btn {
    flex: 0 0 auto;
    background: #172033;
    color: #94a3b8;
    border: 1px solid #334155;
    border-radius: 5px;
    padding: 3px 7px;
    font-size: 11px;
    line-height: 1.2;
    white-space: nowrap;
    cursor: pointer;
  }
  .fsc-mark-complete-btn:hover, .fsc-mark-complete-btn:focus-visible {
    color: #67e8f9;
    border-color: #22d3ee;
    outline: none;
  }
  .fsc-mark-complete-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .fsc-row-clickable {
    cursor: pointer;
  }
  .fsc-row-clickable:hover {
    outline: 1px solid rgba(103, 232, 249, 0.4);
    outline-offset: -1px;
  }
  .fsc-back-btn {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    color: #67e8f9;
    border: none;
    border-bottom: 1px solid #334155;
    padding: 6px 8px;
    margin-bottom: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  .fsc-back-btn:hover {
    color: #e2e8f0;
  }
  .fsc-view-toggle {
    flex: 0 0 auto;
    display: flex;
    background: #172033;
    border-bottom: 1px solid #334155;
  }
  .fsc-view-toggle.fsc-hidden {
    display: none;
  }
  .fsc-view-toggle button {
    flex: 1 1 0;
    background: transparent;
    color: #94a3b8;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 8px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .fsc-view-toggle button:hover {
    color: #e2e8f0;
  }
  .fsc-view-toggle button[aria-pressed="true"] {
    color: #67e8f9;
    border-bottom-color: #22d3ee;
  }
  .fsc-list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px;
  }
  .fsc-row {
    padding: 8px;
    border-radius: 6px;
    border: 1px solid rgba(148, 163, 184, 0.15);
    margin-bottom: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fsc-row:nth-child(odd) {
    background: rgba(251, 146, 60, 0.12);
  }
  .fsc-row:nth-child(even) {
    background: rgba(34, 211, 238, 0.12);
  }
  .fsc-row:last-child {
    margin-bottom: 0;
  }
  .fsc-row-flex {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    white-space: normal;
  }
  .fsc-row-flex > span:first-child {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fsc-ore-select, .fsc-mode-select {
    flex: 0 0 auto;
    max-width: 45%;
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 4px;
    padding: 2px 4px;
    font-size: 11px;
  }
  .fsc-ore-select:focus, .fsc-mode-select:focus {
    outline: none;
    border-color: #22d3ee;
  }
  .fsc-breakdown-row {
    padding: 2px 8px 2px 20px;
    font-size: 11px;
    color: #94a3b8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fsc-section-label {
    padding: 4px 8px 2px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #94a3b8;
  }
  .fsc-section-label.fsc-sub-label {
    padding-left: 16px;
    font-size: 10px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: normal;
    opacity: 0.85;
  }
  .fsc-sub-label-with-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .fsc-sub-label-with-controls > span:first-child {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fsc-batch-controls {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .fsc-batch-label {
    font-size: 11px;
    color: #94a3b8;
    white-space: nowrap;
  }
  .fsc-batch-input {
    width: 2ch;
    font-size: 11px;
    padding: 2px 2px;
    border-radius: 4px;
    border: 1px solid rgba(148, 163, 184, 0.3);
    background: #172033;
    color: #e2e8f0;
    text-align: center;
  }
  .fsc-batch-input:focus {
    outline: none;
    border-color: #22d3ee;
  }
  .fsc-batch-remaining {
    font-size: 11px;
    color: #94a3b8;
    white-space: nowrap;
  }
  .fsc-assembly-row {
    background: rgba(167, 139, 250, 0.16) !important;
  }
  .fsc-planetary-row {
    background: rgba(74, 222, 128, 0.14) !important;
  }
  .fsc-empty-message {
    padding: 10px 4px;
    color: #94a3b8;
  }
`;

// One-time setup: builds the Shadow DOM host + edge handle + panel
// skeleton, wires storage reactivity, and starts collapsed. Safe to call
// once per page load (content.js calls this on init).
export function initManifestOverlay() {
  const host = document.createElement("div");
  host.id = "fsc-manifest-overlay-host";
  document.documentElement.appendChild(host);
  shadowRoot = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLE;
  shadowRoot.appendChild(style);

  edgeHandleEl = document.createElement("div");
  edgeHandleEl.className = "fsc-edge-handle";
  edgeHandleEl.textContent = "Manifest";
  edgeHandleEl.title = "Show/hide the Manifest overlay";
  edgeHandleEl.addEventListener("click", toggleManifestOverlay);
  shadowRoot.appendChild(edgeHandleEl);

  panelEl = buildPanel();
  shadowRoot.appendChild(panelEl);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let changed = false;
    if (changes.manifestToMineData) {
      personalData = changes.manifestToMineData.newValue || { available: false };
      changed = true;
    }
    // Own key (manifestCorpToMineData), not the dashboard's corpToMineData -
    // same independence as the Personal side, see storage.js's
    // manifestCorpSelection comment.
    if (changes.manifestCorpToMineData) {
      corpData = changes.manifestCorpToMineData.newValue || { available: false, items: [], refined: [] };
      changed = true;
    }
    // Someone else (the dashboard, or a second overlay on another tab) may
    // have added/renamed/deleted a build or blueprint, or this overlay's own
    // background.js round trip just confirmed a new selection - keep the
    // dropdown/tooltip in sync rather than showing a stale list or the wrong
    // entry highlighted. builds/blueprints are re-loaded properly (not read
    // raw off `changes`) since they need Blueprint-class hydration for the
    // tooltip's `.requirements` access - see storage.js's loadBuilds()/
    // loadBlueprints(). Both selectors share the same builds/blueprints
    // data, just different CURRENT selections, so one refresh call each
    // covers both dropdowns.
    if (changes.builds) {
      storage.loadBuilds().then((b) => {
        builds = b;
        refreshSelectionSelector();
        refreshCorpSelectionSelector();
      });
    }
    if (changes.blueprints) {
      storage.loadBlueprints().then((bp) => {
        blueprints = bp;
        refreshSelectionSelector();
        refreshCorpSelectionSelector();
      });
    }
    // A build may have just been renamed on the dashboard's Plan a Build tab
    // (see tab-plan.js's "Rename Build..." button) - keep both dropdowns'
    // display text in sync rather than showing a stale label.
    if (changes.buildLabels) {
      storage.loadBuildLabels().then((labels) => {
        buildLabels = labels;
        refreshSelectionSelector();
        refreshCorpSelectionSelector();
      });
    }
    if (changes.manifestSelection) {
      manifestSelection = changes.manifestSelection.newValue || null;
      refreshSelectionSelector();
    }
    if (changes.manifestCorpSelection) {
      manifestCorpSelection = changes.manifestCorpSelection.newValue || null;
      refreshCorpSelectionSelector();
    }
    if (changed && !suppressRenderWhileEditing) render();
  });

  Promise.all([
    browser.storage.local.get(["manifestToMineData", "manifestCorpToMineData", "manifestSelection", "manifestCorpSelection"]),
    storage.loadBuilds(),
    storage.loadBlueprints(),
    storage.loadBuildLabels(),
  ]).then(([result, loadedBuilds, loadedBlueprints, loadedBuildLabels]) => {
    personalData = result.manifestToMineData || { available: false };
    corpData = result.manifestCorpToMineData || { available: false, items: [], refined: [] };
    manifestSelection = result.manifestSelection || null;
    manifestCorpSelection = result.manifestCorpSelection || null;
    builds = loadedBuilds;
    blueprints = loadedBlueprints;
    buildLabels = loadedBuildLabels;
    refreshSelectionSelector();
    refreshCorpSelectionSelector();
    render();
  });
}

export function toggleManifestOverlay() {
  overlayVisible = !overlayVisible;
  panelEl.classList.toggle("fsc-visible", overlayVisible);
  // The panel's own header already has a close button once it's open, so
  // the edge handle sitting there too is just redundant clutter (and can
  // visually overlap the panel depending on viewport size/panel height,
  // since the two are positioned independently - see their CSS above).
  edgeHandleEl.classList.toggle("fsc-hidden", overlayVisible);
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.className = "fsc-panel";

  const header = document.createElement("div");
  header.className = "fsc-header";
  titleEl = document.createElement("h1");
  titleEl.textContent = "Manifest";
  const actions = document.createElement("div");
  actions.className = "fsc-header-actions";
  addBlueprintBtn = document.createElement("button");
  addBlueprintBtn.type = "button";
  addBlueprintBtn.textContent = "Add Blueprint";
  addBlueprintBtn.title = "Quickly add/edit a blueprint or add to your active build, without leaving the game";
  addBlueprintBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openAddBlueprintModal();
  });
  dashboardBtn = document.createElement("button");
  dashboardBtn.type = "button";
  dashboardBtn.textContent = "Dashboard →";
  dashboardBtn.title = "Open the full dashboard in a new tab";
  dashboardBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    browser.runtime.sendMessage({ type: "fsc-open-dashboard" }).catch(() => {});
  });
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "fsc-close-btn";
  closeBtn.textContent = "×";
  closeBtn.title = "Hide the Manifest overlay";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleManifestOverlay();
  });
  actions.append(addBlueprintBtn, dashboardBtn, closeBtn);
  header.append(titleEl, actions);
  makeDraggable(panel, header);

  // Selection switcher - lets either a single Blueprint (previewed at 1x)
  // or a saved multi-item Build Order be picked right from the game page,
  // without opening the dashboard. Deliberately its OWN storage track
  // (manifestSelection/manifestToMineData/manifestOreChoices - see
  // storage.js's header comments on each) rather than the dashboard's
  // activeBuildName/builds/toMineData - a bare Blueprint has no equivalent
  // "active" concept there, and sharing toMineData would let the
  // dashboard's headless recalculation (which only knows about saved
  // Builds) silently clobber a Blueprint preview on the next inventory
  // sync. Only meaningful for the Personal Farm view (Corp tracks its own
  // separate active build, set from the dashboard's Corp tab - see
  // storage.js's activeCorpBuildName) - see refreshSelectionSelector()'s
  // fsc-hidden toggle below.
  selectionRowEl = document.createElement("div");
  selectionRowEl.className = "fsc-selection-row";
  const selectionLabel = document.createElement("label");
  selectionLabel.setAttribute("for", "fsc-selection-select");
  selectionLabel.textContent = "Farm:";
  selectionSelectEl = document.createElement("select");
  selectionSelectEl.id = "fsc-selection-select";
  selectionSelectEl.className = "fsc-selection-select";
  selectionSelectEl.addEventListener("change", () => {
    const raw = selectionSelectEl.value;
    if (!raw) return;
    const sep = raw.indexOf(":");
    const type = raw.slice(0, sep);
    const name = raw.slice(sep + 1);
    if (manifestSelection && manifestSelection.type === type && manifestSelection.name === name) return;
    // background.js owns the actual persistence + recalculation (mirrors
    // handleSetPendingBatches() below) - this content-script context has no
    // `app`/calc-engine wiring of its own to redo tab-plan.js's math with,
    // and centralizing it there keeps a single recalculation code path
    // rather than a second copy living here. The storage.onChanged listener
    // above picks up the resulting manifestToMineData/manifestSelection
    // writes and refreshes this panel once background.js is done.
    browser.runtime.sendMessage({ type: "fsc-switch-manifest-selection", selection: { type, name } }).catch(() => {});
  });
  selectionInfoEl = document.createElement("span");
  selectionInfoEl.className = "fsc-info-icon";
  selectionInfoEl.textContent = "i";
  selectionInfoEl.setAttribute("tabindex", "0");
  selectionInfoEl.setAttribute("aria-label", "Contents of the selected Blueprint or Build Order");

  // Manual recalculation - see background.js's fsc-refresh-manifest-selection
  // handler comment for why this exists: cargo capacity, inventory, and
  // Blueprint/Build Order edits made on the DASHBOARD side have no automatic
  // path to this overlay's cached plan, unlike the overlay's own controls
  // (selection dropdown, ore picker, Farm/Buy toggle), which already trigger
  // a recalculation themselves.
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "fsc-refresh-btn";
  refreshBtn.textContent = "⟳";
  refreshBtn.title = "Refresh this farm's numbers - use after changing cargo capacity, inventory, or a Blueprint/Build Order in the dashboard";
  refreshBtn.setAttribute("aria-label", "Refresh farm plan");
  refreshBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    browser.runtime.sendMessage({ type: "fsc-refresh-manifest-selection" }).catch(() => {});
  });

  // "Mark Complete" - declares the currently-selected Blueprint/Build Order
  // done: clears ITS OWN batch counts and ore-source picks (see storage.js's
  // manifestPendingBatches/manifestOreChoices) and deselects, so a finished
  // print doesn't leave stale numbers/settings behind for the next one that
  // happens to share an ore. Deliberately never deletes the underlying
  // Blueprint or Build Order - only the dashboard's own "Mark Build
  // Complete" (tab-plan.js) does that, and on purpose stays a separate,
  // more deliberate action. Only meaningful for Personal Farm (batches/ore
  // choices are a Personal-view-only concept - see refreshSelectionSelector()
  // enabling this button, and storage.js's manifestOreChoices comment on why
  // Corp has no equivalent).
  markCompleteBtn = document.createElement("button");
  markCompleteBtn.type = "button";
  markCompleteBtn.className = "fsc-mark-complete-btn";
  markCompleteBtn.textContent = "Complete";
  markCompleteBtn.title = "Mark this Blueprint/Build Order complete - clears its batch counts and ore-source picks, then deselects";
  markCompleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!manifestSelection) return;
    const label =
      manifestSelection.type === "blueprint"
        ? manifestSelection.name
        : buildLabels[manifestSelection.name] || `Build ${manifestSelection.name}`;
    if (!confirm(`Mark "${label}" complete? This clears its batch counts and ore-source picks (not the Blueprint/Build Order itself), then deselects it.`)) return;
    browser.runtime.sendMessage({ type: "fsc-mark-manifest-selection-complete" }).catch(() => {});
  });

  selectionRowEl.append(selectionLabel, selectionSelectEl, refreshBtn, markCompleteBtn, selectionInfoEl);

  // Corp's own Blueprint/Build Order switcher - exact mirror of the
  // Personal one above (same manifestCorpSelection/manifestCorpToMineData
  // storage.js pair, same reasoning for staying independent of the
  // dashboard's Corp tab activeCorpBuildName/corpToMineData), just wired to
  // the fsc-*-manifest-corp-selection messages instead. Only meaningful for
  // the Corp view - hidden/shown opposite of selectionRowEl (see
  // refreshCorpSelectionSelector()'s fsc-hidden toggle below).
  corpSelectionRowEl = document.createElement("div");
  corpSelectionRowEl.className = "fsc-selection-row";
  const corpSelectionLabel = document.createElement("label");
  corpSelectionLabel.setAttribute("for", "fsc-corp-selection-select");
  corpSelectionLabel.textContent = "Farm:";
  corpSelectionSelectEl = document.createElement("select");
  corpSelectionSelectEl.id = "fsc-corp-selection-select";
  corpSelectionSelectEl.className = "fsc-selection-select";
  corpSelectionSelectEl.addEventListener("change", () => {
    const raw = corpSelectionSelectEl.value;
    if (!raw) return;
    const sep = raw.indexOf(":");
    const type = raw.slice(0, sep);
    const name = raw.slice(sep + 1);
    if (manifestCorpSelection && manifestCorpSelection.type === type && manifestCorpSelection.name === name) return;
    browser.runtime.sendMessage({ type: "fsc-switch-manifest-corp-selection", selection: { type, name } }).catch(() => {});
  });
  corpSelectionInfoEl = document.createElement("span");
  corpSelectionInfoEl.className = "fsc-info-icon";
  corpSelectionInfoEl.textContent = "i";
  corpSelectionInfoEl.setAttribute("tabindex", "0");
  corpSelectionInfoEl.setAttribute("aria-label", "Contents of the selected Blueprint or Build Order");

  const corpRefreshBtn = document.createElement("button");
  corpRefreshBtn.type = "button";
  corpRefreshBtn.className = "fsc-refresh-btn";
  corpRefreshBtn.textContent = "⟳";
  corpRefreshBtn.title = "Refresh this farm's numbers - use after changing the Corp Store, inventory, or a Blueprint/Build Order in the dashboard";
  corpRefreshBtn.setAttribute("aria-label", "Refresh corp farm plan");
  corpRefreshBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    browser.runtime.sendMessage({ type: "fsc-refresh-manifest-corp-selection" }).catch(() => {});
  });

  corpSelectionRowEl.append(corpSelectionLabel, corpSelectionSelectEl, corpRefreshBtn, corpSelectionInfoEl);

  viewToggleEl = document.createElement("div");
  viewToggleEl.className = "fsc-view-toggle";
  personalBtn = document.createElement("button");
  personalBtn.type = "button";
  personalBtn.textContent = "Personal Farm";
  personalBtn.setAttribute("aria-pressed", "true");
  personalBtn.addEventListener("click", () => {
    currentView = "personal";
    focusedItem = null; // a focused item belongs to whichever view set it - see focusedItem's own comment
    refreshSelectionSelector();
    refreshCorpSelectionSelector();
    render();
  });
  corpBtn = document.createElement("button");
  corpBtn.type = "button";
  corpBtn.textContent = "Corp";
  corpBtn.setAttribute("aria-pressed", "false");
  corpBtn.addEventListener("click", () => {
    currentView = "corp";
    focusedItem = null;
    refreshSelectionSelector();
    refreshCorpSelectionSelector();
    render();
  });
  viewToggleEl.append(personalBtn, corpBtn);

  listEl = document.createElement("main");
  listEl.className = "fsc-list";

  // Both corners, not just one - the panel starts anchored on the right side
  // of the screen (see its own CSS), where the bottom-LEFT handle is the
  // natural one (keeps that right-side anchor fixed while growing) - but
  // once dragged to the left side of the screen instead, the bottom-RIGHT
  // handle becomes the natural one (keeps the now-relevant left edge fixed).
  // Having both means whichever side the panel ends up on, there's always a
  // handle that grows it the "expected" way without also shifting it
  // sideways first.
  // Resize grip icon: 3 short parallel diagonal lines, longest nearest the
  // corner - the standard "resizable panel/textarea" grip look (e.g. seen
  // in most browsers' own resizable <textarea>) - reads instantly as "drag
  // here" without needing an arrowhead. Replaced an earlier attempt at a
  // hand-drawn CSS border-triangle (had a real geometry bug - see project
  // memory) and then a Unicode double-arrow glyph (user found it visually
  // unclear) before landing here.
  const resizeHandleLeft = document.createElement("div");
  resizeHandleLeft.className = "fsc-resize-handle fsc-resize-handle-left";
  resizeHandleLeft.appendChild(buildResizeGripIcon(true));
  resizeHandleLeft.title = "Drag to resize";
  resizeHandleLeft.setAttribute("aria-hidden", "true"); // mouse-only, like the header's own drag-to-reposition - no keyboard equivalent exists for that either
  makeResizable(panel, resizeHandleLeft, "left");

  const resizeHandleRight = document.createElement("div");
  resizeHandleRight.className = "fsc-resize-handle fsc-resize-handle-right";
  resizeHandleRight.appendChild(buildResizeGripIcon(false));
  resizeHandleRight.title = "Drag to resize";
  resizeHandleRight.setAttribute("aria-hidden", "true");
  makeResizable(panel, resizeHandleRight, "right");

  panel.append(header, selectionRowEl, corpSelectionRowEl, viewToggleEl, listEl, resizeHandleLeft, resizeHandleRight);
  return panel;
}

// Repopulates the selection <select> with two sections - Blueprints (every
// saved Blueprint, previewable directly at 1x) and Build Orders (sorted the
// same way tab-plan.js's own refreshBuildCombo() sorts them - numerically,
// not lexically, since build names are auto-assigned integer strings) -
// re-selects whichever is actually active, and rebuilds the info icon's
// tooltip. For a Build Order this lists its blueprint entries (kind ===
// "blueprint", or the pre-2026-08-15 "recipe" tag - see tab-plan.js's
// renderEntriesList() for why both are still recognized; ad-hoc materials
// in the build are deliberately left out, matching the original ask for
// "the blueprints listed in the build"). For a directly-selected Blueprint
// there's no "build" to list blueprints from, so it instead lists that
// Blueprint's own item requirements.
// Cheap, called from both refresh*SelectionSelector() functions below AND
// directly from render() on every render (see render()'s own comment) -
// kept separate from the (much heavier, dropdown-rebuilding) refresh
// functions so render() doesn't have to redo that work just to keep these
// two rows' visibility correct after a focus change.
function updateSelectionRowVisibility() {
  if (selectionRowEl) selectionRowEl.classList.toggle("fsc-hidden", currentView !== "personal" || Boolean(focusedItem));
  if (corpSelectionRowEl) corpSelectionRowEl.classList.toggle("fsc-hidden", currentView !== "corp" || Boolean(focusedItem));
}

function refreshSelectionSelector() {
  if (!selectionSelectEl) return;
  updateSelectionRowVisibility();

  selectionSelectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Select --";
  selectionSelectEl.appendChild(placeholder);

  const blueprintNames = Object.keys(blueprints).sort();
  if (blueprintNames.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "Blueprints";
    for (const name of blueprintNames) {
      const opt = document.createElement("option");
      opt.value = `blueprint:${name}`;
      opt.textContent = name;
      group.appendChild(opt);
    }
    selectionSelectEl.appendChild(group);
  }

  const buildNames = Object.keys(builds).sort((a, b) => Number(a) - Number(b));
  if (buildNames.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "Build Orders (Dashboard)";
    for (const name of buildNames) {
      const opt = document.createElement("option");
      opt.value = `build:${name}`;
      opt.textContent = buildLabels[name] || `Build ${name}`;
      group.appendChild(opt);
    }
    selectionSelectEl.appendChild(group);
  }

  selectionSelectEl.value = manifestSelection ? `${manifestSelection.type}:${manifestSelection.name}` : "";
  if (markCompleteBtn) markCompleteBtn.disabled = !manifestSelection;

  if (manifestSelection?.type === "blueprint") {
    const blueprint = blueprints[manifestSelection.name];
    const lines = blueprint
      ? Object.entries(blueprint.requirements)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, qty]) => `${name} x${qty}`)
      : [];
    selectionInfoEl.title = lines.length ? `Items in this blueprint:\n${lines.join("\n")}` : "No items in this blueprint.";
  } else if (manifestSelection?.type === "build") {
    const entries = builds[manifestSelection.name] || [];
    const lines = entries
      .filter(([kind]) => kind === "blueprint" || kind === "recipe")
      .map(([, name, qty]) => `${name} x${qty}`);
    selectionInfoEl.title = lines.length ? `Blueprints in this build:\n${lines.join("\n")}` : "No blueprints in this build.";
  } else {
    selectionInfoEl.title = "Pick a Blueprint or Build Order to see its contents.";
  }
}

// Corp counterpart to refreshSelectionSelector() above - identical in every
// way except it reads/writes manifestCorpSelection instead of
// manifestSelection, and is hidden/shown OPPOSITE that one (visible only in
// Corp view, not Personal).
function refreshCorpSelectionSelector() {
  if (!corpSelectionSelectEl) return;
  updateSelectionRowVisibility();

  corpSelectionSelectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Select --";
  corpSelectionSelectEl.appendChild(placeholder);

  const blueprintNames = Object.keys(blueprints).sort();
  if (blueprintNames.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "Blueprints";
    for (const name of blueprintNames) {
      const opt = document.createElement("option");
      opt.value = `blueprint:${name}`;
      opt.textContent = name;
      group.appendChild(opt);
    }
    corpSelectionSelectEl.appendChild(group);
  }

  const buildNames = Object.keys(builds).sort((a, b) => Number(a) - Number(b));
  if (buildNames.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "Build Orders (Dashboard)";
    for (const name of buildNames) {
      const opt = document.createElement("option");
      opt.value = `build:${name}`;
      opt.textContent = buildLabels[name] || `Build ${name}`;
      group.appendChild(opt);
    }
    corpSelectionSelectEl.appendChild(group);
  }

  corpSelectionSelectEl.value = manifestCorpSelection ? `${manifestCorpSelection.type}:${manifestCorpSelection.name}` : "";

  if (manifestCorpSelection?.type === "blueprint") {
    const blueprint = blueprints[manifestCorpSelection.name];
    const lines = blueprint
      ? Object.entries(blueprint.requirements)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, qty]) => `${name} x${qty}`)
      : [];
    corpSelectionInfoEl.title = lines.length ? `Items in this blueprint:\n${lines.join("\n")}` : "No items in this blueprint.";
  } else if (manifestCorpSelection?.type === "build") {
    const entries = builds[manifestCorpSelection.name] || [];
    const lines = entries
      .filter(([kind]) => kind === "blueprint" || kind === "recipe")
      .map(([, name, qty]) => `${name} x${qty}`);
    corpSelectionInfoEl.title = lines.length ? `Blueprints in this build:\n${lines.join("\n")}` : "No blueprints in this build.";
  } else {
    corpSelectionInfoEl.title = "Pick a Blueprint or Build Order to see its contents.";
  }
}

// Drag-to-reposition via the header - position:fixed + left/top, switching
// away from right/top-anchored placement to left/top-anchored the moment a
// drag starts (so the panel doesn't visually jump the instant it's grabbed
// - it started anchored by `right` for a sensible default first-open spot).
function makeDraggable(panel, handle) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return; // don't start a drag from a header button click
    dragging = true;
    const rect = panel.getBoundingClientRect();
    panel.style.right = "auto";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
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
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  document.addEventListener("mouseup", () => {
    dragging = false;
  });
}

// Builds the resize-grip SVG icon: 3 parallel diagonal line segments,
// shortest furthest from the corner, longest right at it. `mirrored: true`
// draws them NE-to-SW (for the bottom-LEFT handle, matching its sw-resize
// cursor); `false` draws NW-to-SE (bottom-RIGHT, se-resize). Built via
// createElementNS rather than innerHTML - this file/project's convention
// throughout (see dom-helpers.js's own header comment) is to never set
// markup via innerHTML, even for static/trusted strings like this one.
function buildResizeGripIcon(mirrored) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  const segments = mirrored
    ? [[12, 14, 2, 4], [8, 14, 2, 8], [4, 14, 2, 12]]
    : [[4, 14, 14, 4], [8, 14, 14, 8], [12, 14, 14, 12]];
  for (const [x1, y1, x2, y2] of segments) {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
  }
  return svg;
}

// Drag-to-resize from a bottom corner. Two handles share this (see
// buildPanel()) since which corner is "natural" depends on which side of
// the screen the panel is currently sitting on: `corner: "left"` keeps the
// RIGHT edge fixed while growing (right for a panel still in its default
// right-anchored spot), `corner: "right"` keeps the LEFT edge fixed instead
// (right for a panel that's been dragged over to the left side of the
// screen). Same "switch to left/top+explicit size the moment the
// interaction starts" trick as makeDraggable() above - the panel's default
// `width: fit-content`/`max-width`/`max-height` (its own CSS) only apply
// until an explicit inline width/height/right:auto is set, at which point
// they stop constraining it, matching how makeDraggable() already
// overrides `right` the same way.
function makeResizable(panel, handle, corner) {
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let startWidth = 0;
  let startHeight = 0;
  const MIN_WIDTH = 280; // matches the CSS min-width this replaces once resizing starts
  const MIN_HEIGHT = 220; // enough room for the header/selection row/view toggle plus at least one list row

  handle.addEventListener("mousedown", (e) => {
    resizing = true;
    const rect = panel.getBoundingClientRect();
    panel.style.right = "auto";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.maxWidth = "none";
    panel.style.maxHeight = "none";
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    startWidth = rect.width;
    startHeight = rect.height;
    e.preventDefault();
    e.stopPropagation(); // don't also let the panel's own drag (header) or anything else react to this
  });
  document.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const maxHeight = window.innerHeight - startTop - 10;
    const height = Math.min(Math.max(MIN_HEIGHT, startHeight + deltaY), maxHeight);
    panel.style.height = `${height}px`;
    if (corner === "left") {
      // The RIGHT edge (startLeft + startWidth) stays fixed - only the left
      // edge (tracking the mouse) moves.
      const maxWidth = startLeft + startWidth - 10; // don't let the left edge cross past 10px from the viewport's own left edge
      const width = Math.min(Math.max(MIN_WIDTH, startWidth - deltaX), maxWidth);
      panel.style.left = `${startLeft + startWidth - width}px`;
      panel.style.width = `${width}px`;
    } else {
      // The LEFT edge (startLeft) stays fixed - only the right edge
      // (tracking the mouse) moves, so `left` itself never needs to change.
      const maxWidth = window.innerWidth - startLeft - 10; // don't let the right edge cross past 10px from the viewport's own right edge
      const width = Math.min(Math.max(MIN_WIDTH, startWidth + deltaX), maxWidth);
      panel.style.width = `${width}px`;
    }
  });
  document.addEventListener("mouseup", () => {
    resizing = false;
  });
}

function emptyMessage() {
  if (currentView === "corp") {
    if (!corpData.available) {
      return "Pick a Blueprint or Build Order above to see what's needed";
    }
    return "Corp Store already covers everything needed";
  }
  if (!personalData.available) {
    return "Pick a Blueprint or Build Order above to see what's needed";
  }
  return "Nothing left to mine";
}

// Scoped to whichever Blueprint/Build Order is currently selected (see
// storage.js's manifestPendingBatches comment) - deliberately a different
// message/storage key than the dashboard's global pendingRefining-backed
// batch controls, so a batch started here for one selection never silently
// credits a different selection's own "how many more do I need" math.
function setPendingBatches(oreName, batches) {
  browser.runtime.sendMessage({ type: "fsc-set-manifest-pending-batches", oreName, batches }).catch(() => {});
}

// Row-level "focus" click - see focusedItem's own declaration comment.
// Shared by all 5 focusable row types (ore/refined/assembly/planetary/buy).
// Toggling (not just setting) is what makes "click the same row again"
// exit focus mode work, with no special-casing needed in render() - the
// focused view reuses these exact same render*Row() functions, so the
// click listener attached here fires identically whether the row is
// currently shown as part of the full list or as the sole focused row.
function isFocused(section, name) {
  return focusedItem !== null && focusedItem.section === section && focusedItem.name === name;
}

function toggleFocus(section, name) {
  focusedItem = isFocused(section, name) ? null : { section, name };
  render();
}

// Mining/ores is the TOTAL raw ore still needed (direct use + refining
// combined - see toStorableToMineData() in calc-engine.js). The refining
// share of THIS row's total used to be called out inline - "(refined: N)" -
// but that made rows noisy/hard to parse at a glance; now it's a small info
// icon (only shown when there IS a refining share) whose tooltip carries
// the number instead, pointing at the Refined section below rather than
// repeating its detail inline.
function renderPersonalRow(ore) {
  const row = document.createElement("div");
  row.addEventListener("click", () => toggleFocus("ore", ore.name));
  const tripLabel = ore.trips === 1 ? "trip" : "trips";
  const labelText = `${ore.name}: ${Math.round(ore.to_mine).toLocaleString()} (${ore.trips} ${tripLabel})`;
  const titleText = `${labelText} — Law ${ore.law}`;

  if (ore.refined_portion <= 0) {
    row.className = "fsc-row fsc-row-clickable";
    row.textContent = labelText;
    row.title = titleText;
    return row;
  }

  row.className = "fsc-row fsc-row-flex fsc-row-clickable";
  const label = document.createElement("span");
  label.textContent = labelText;
  label.title = titleText;

  const infoIcon = document.createElement("span");
  infoIcon.className = "fsc-info-icon";
  infoIcon.textContent = "i";
  infoIcon.setAttribute("tabindex", "0");
  infoIcon.setAttribute("aria-label", "Part of this ore is needed for refining - see Refined Materials");
  infoIcon.title = `${Math.round(ore.refined_portion).toLocaleString()} of this is needed for refining — see Refined Materials below`;

  row.append(label, infoIcon);
  return row;
}

// "[typed X] / remaining" batch-tracking control. X is an editable count of
// batches currently started (typed in directly, not incremented - matches
// the real workflow: type the count when a run starts, reset to 0 once
// collected). "remaining" is a static number - how many MORE batches are
// still needed, counting only what's actually been collected.
function buildBatchControls(name, pendingBatches, remainingBatches) {
  const controls = document.createElement("span");
  controls.className = "fsc-batch-controls";

  const batchLabel = document.createElement("span");
  batchLabel.className = "fsc-batch-label";
  batchLabel.textContent = "Batch:";

  const batchInput = document.createElement("input");
  batchInput.type = "text";
  batchInput.className = "fsc-batch-input";
  batchInput.setAttribute("aria-label", `Batches of ${name} currently started refining`);
  batchInput.value = String(pendingBatches);
  const digits = Math.max(2, String(remainingBatches).length, String(pendingBatches).length);
  batchInput.style.width = `calc(${digits}ch + 6px)`;
  batchInput.title = `Batches of ${name} currently started refining (not yet collected) - type a number and press Enter/click away to save`;
  const commit = () => {
    const batches = parseInt(batchInput.value, 10);
    if (Number.isNaN(batches) || batches < 0) {
      batchInput.value = String(pendingBatches);
      return;
    }
    setPendingBatches(name, batches);
  };
  batchInput.addEventListener("click", (e) => e.stopPropagation());
  batchInput.addEventListener("mousedown", (e) => e.stopPropagation());
  batchInput.addEventListener("focus", () => { suppressRenderWhileEditing = true; });
  batchInput.addEventListener("blur", () => {
    suppressRenderWhileEditing = false;
    commit();
    render();
  });
  batchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      batchInput.blur();
    }
  });

  const remainingLabel = document.createElement("span");
  remainingLabel.className = "fsc-batch-remaining";
  remainingLabel.textContent = `/ ${remainingBatches}`;
  remainingLabel.title = `${remainingBatches} total batch(es) of ${name} still needed, counting only what's actually been collected - starting more batches (left number) doesn't reduce this until they're actually collected`;

  controls.append(batchLabel, batchInput, remainingLabel);
  return controls;
}

function renderMiningGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `Law ${item.law}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => parseFloat(a.slice(4)) - parseFloat(b.slice(4)));
  for (const key of sortedKeys) {
    listEl.appendChild(sectionLabel(key, true));
    groups.get(key).forEach((item) => listEl.appendChild(renderPersonalRow(item)));
  }
}

// `editable` (Personal Farm view only - see render()'s call sites) swaps the
// plain have/need text row for a flex row with a source-ore <select> next to
// it, populated straight from the Catalog's own candidate list
// (catalog.findMaterial(name).sources - a plain Ore[], nothing to do with
// toStorableToMineData's output, which only ever carries the ONE currently-
// chosen ore per material, not the full candidate set). Picking a different
// ore sends fsc-set-manifest-ore-choice, persisted per-selection (see
// storage.js's manifestOreChoices) - the material will naturally reappear
// under a different group header on the next render once background.js's
// recalculation lands, same live-regrouping behavior the dashboard's own
// ore-choice selects already have.
function renderRefinedRow(item, oreName, editable) {
  const row = document.createElement("div");
  const labelText = `${item.name}: ${Math.round(item.have).toLocaleString()} / ${Math.round(item.need).toLocaleString()}`;
  const titleText = `${item.name}: have ${item.have} / need ${item.need}`;

  if (!editable) {
    // Corp's own Refined section reuses this same function with
    // editable:false (see renderRefinedGroups()'s default param, and its
    // only two call sites in render() below - editable is always true for
    // Personal, always false for Corp, a clean 1:1 split) - no ore picker
    // here, but focus mode still applies the same as everywhere else.
    row.addEventListener("click", () => toggleFocus("refined", item.name));
    row.className = "fsc-row fsc-row-clickable";
    row.textContent = labelText;
    row.title = titleText;
    return row;
  }

  row.addEventListener("click", () => toggleFocus("refined", item.name));
  row.className = "fsc-row fsc-row-flex fsc-row-clickable";
  const label = document.createElement("span");
  label.textContent = labelText;
  label.title = titleText;

  const select = document.createElement("select");
  select.className = "fsc-ore-select";
  select.setAttribute("aria-label", `Source ore for ${item.name}`);
  const material = catalog.findMaterial(item.name);
  for (const ore of material ? material.sources : []) {
    const opt = document.createElement("option");
    opt.value = ore.name;
    opt.textContent = ore.name;
    select.appendChild(opt);
  }
  select.value = oreName;
  select.addEventListener("click", (e) => e.stopPropagation());
  select.addEventListener("mousedown", (e) => e.stopPropagation());
  select.addEventListener("change", () => {
    browser.runtime.sendMessage({ type: "fsc-set-manifest-ore-choice", materialName: item.name, oreName: select.value }).catch(() => {});
  });

  row.append(label, select);
  return row;
}

function renderRefinedGroups(groups, editable = false) {
  for (const group of groups) {
    const isPersonal = group.pending_batches !== undefined;
    const lawText = group.law != null ? ` (Law ${group.law})` : "";
    const rawText = Math.round(group.raw_needed).toLocaleString();
    const labelText = isPersonal ? `${group.ore}${lawText}` : `${group.ore}${lawText} — ${rawText} raw needed`;
    const header = document.createElement("div");
    header.className = "fsc-section-label fsc-sub-label";
    if (isPersonal) {
      header.classList.add("fsc-sub-label-with-controls");
      const label = document.createElement("span");
      label.textContent = labelText;
      header.append(label, buildBatchControls(group.ore, group.pending_batches, group.remaining_batches));
    } else {
      header.textContent = labelText;
    }
    listEl.appendChild(header);
    group.materials.forEach((item) => listEl.appendChild(renderRefinedRow(item, group.ore, editable)));
  }
}

// Shared by renderAssemblyRow()/renderBuyRow() below - the Farm/Buy choice
// is the exact same global settings.item_acquisition_mode the dashboard's
// Plan a Build tab's "Item sources" Mine/Buy select already reads/writes
// (see background.js's handleSetItemAcquisitionMode()), just surfaced here
// too so switching an item's mode - either direction - doesn't require
// leaving the game to open the dashboard.
function renderModeSelect(itemName, mode) {
  const select = document.createElement("select");
  select.className = "fsc-mode-select";
  select.setAttribute("aria-label", `Acquisition mode for ${itemName}`);
  const mineOpt = document.createElement("option");
  mineOpt.value = "mine";
  mineOpt.textContent = "Farm";
  const buyOpt = document.createElement("option");
  buyOpt.value = "buy";
  buyOpt.textContent = "Buy";
  select.append(mineOpt, buyOpt);
  select.value = mode;
  select.addEventListener("click", (e) => e.stopPropagation());
  select.addEventListener("mousedown", (e) => e.stopPropagation());
  select.addEventListener("change", () => {
    browser.runtime.sendMessage({ type: "fsc-set-item-acquisition-mode", itemName, mode: select.value }).catch(() => {});
  });
  return select;
}

// A single ore/item line from the item's itemResourceBreakdown() (computed
// server-side in background.js's recalculateManifestSelection() and
// attached to each personalData.assembly entry as `.breakdown` - see that
// function's comment for why this only ever exists for "Farm"-mode items).
function renderAssemblyBreakdownRow(sub) {
  const row = document.createElement("div");
  row.className = "fsc-breakdown-row";
  row.textContent = `↳ ${sub.name}: ${sub.need.toLocaleString()}`;
  row.title = row.textContent;
  return row;
}

// Every item here is, by construction, currently in "Farm" mode (see
// background.js's toStorableToMineData()/recalculateManifestSelection()
// comments - a "Buy"-moded item lands in personalData.buy instead, rendered
// by renderBuyRow() below) - the mode select always starts on "mine", and
// switching it to "buy" moves the item to the Buy section on the next
// render once background.js's recalculation lands.
function renderAssemblyRow(item) {
  const row = document.createElement("div");
  row.addEventListener("click", () => toggleFocus("assembly", item.name));
  row.className = "fsc-row fsc-assembly-row fsc-row-flex fsc-row-clickable";
  const hoursText = item.hours != null ? formatHours(item.hours) : "rate unknown";
  const label = document.createElement("span");
  label.textContent = `${item.name}: ${Math.round(item.need).toLocaleString()} (${hoursText})`;
  label.title = label.textContent;
  row.append(label, renderModeSelect(item.name, "mine"));
  return row;
}

function renderPlanetaryRow(item) {
  const row = document.createElement("div");
  row.addEventListener("click", () => toggleFocus("planetary", item.name));
  row.className = "fsc-row fsc-planetary-row fsc-row-clickable";
  const hoursText = item.hours != null ? formatHours(item.hours) : "idle";
  row.textContent = `${item.name}: ${Math.round(item.need).toLocaleString()} (${hoursText})`;
  row.title = row.textContent;
  return row;
}

function renderPlanetaryGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.planets && item.planets.length ? [...item.planets].sort().join(" / ") : "Unknown source";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const key of [...groups.keys()].sort()) {
    listEl.appendChild(sectionLabel(key, true));
    groups.get(key).forEach((item) => listEl.appendChild(renderPlanetaryRow(item)));
  }
}

function sectionLabel(text, sub = false) {
  const el = document.createElement("div");
  el.className = sub ? "fsc-section-label fsc-sub-label" : "fsc-section-label";
  el.textContent = text;
  return el;
}

function renderCorpOreGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.law != null ? `Law ${item.law}` : "Unknown Law";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const numA = parseFloat(a.slice(4));
    const numB = parseFloat(b.slice(4));
    if (Number.isNaN(numA) || Number.isNaN(numB)) return a.localeCompare(b);
    return numA - numB;
  });
  for (const key of sortedKeys) {
    listEl.appendChild(sectionLabel(key, true));
    groups.get(key).forEach((item) => listEl.appendChild(renderCorpRow(item)));
  }
}

function renderCorpPlanetaryGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.planets && item.planets.length ? [...item.planets].sort().join(" / ") : "Unknown source";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const key of [...groups.keys()].sort()) {
    listEl.appendChild(sectionLabel(key, true));
    groups.get(key).forEach((item) => listEl.appendChild(renderCorpRow(item)));
  }
}

function renderCorpRow(item) {
  const row = document.createElement("div");
  // item.category ("ore"|"assembly"|"planetary", falling back to
  // "commodity" for anything else) is the same categorization render()
  // itself already uses to bucket corpData.items - reused directly as the
  // focus section key so no separate section param is needed here.
  row.addEventListener("click", () => toggleFocus(item.category || "commodity", item.name));
  row.className = "fsc-row fsc-row-clickable";
  const shortfallText = Math.round(item.shortfall).toLocaleString();
  if (item.kind === "ore") {
    const tripLabel = item.trips === 1 ? "trip" : "trips";
    row.textContent = `${item.name}: ${shortfallText} (${item.trips} ${tripLabel})`;
  } else {
    row.textContent = `${item.name}: ${shortfallText}`;
  }
  row.title = row.textContent;
  return row;
}

// A "Buy" row can land here for two different reasons (see background.js's
// recalculateManifestSelection() comment on the `has_plan` flag it attaches)
// - deliberately buy-moded (can switch back to "Farm"), or no known
// Assembly Plan exists at all (nothing to switch TO, so no selector - it
// would just silently stay in Buy anyway since there's nothing to cascade).
function renderBuyRow(item) {
  const row = document.createElement("div");
  row.addEventListener("click", () => toggleFocus("buy", item.name));
  const label = document.createElement("span");
  label.textContent = `${item.name}: ${Math.round(item.need).toLocaleString()}`;
  label.title = label.textContent;
  if (!item.has_plan) {
    row.className = "fsc-row fsc-row-clickable";
    row.textContent = label.textContent;
    row.title = label.textContent;
    return row;
  }
  row.className = "fsc-row fsc-row-flex fsc-row-clickable";
  row.append(label, renderModeSelect(item.name, "buy"));
  return row;
}

function appendEmpty() {
  const empty = document.createElement("div");
  empty.className = "fsc-empty-message";
  empty.textContent = emptyMessage();
  listEl.appendChild(empty);
}

function renderSections(sections) {
  const nonEmpty = sections.filter((s) => s.items.length > 0);
  if (nonEmpty.length === 0) {
    appendEmpty();
    return;
  }
  const showLabels = nonEmpty.length > 1;
  for (const section of nonEmpty) {
    if (showLabels) listEl.appendChild(sectionLabel(section.label));
    section.render(section.items);
  }
}

// Finds focusedItem's underlying data in whichever of personalData/corpData
// matches the CURRENT view and appends just that one row (plus, for a
// Personal Assembly item, its breakdown sub-rows, same as the full list
// would) - reuses the exact same render*Row() functions the full list uses,
// so a focused row looks and behaves identically to its full-list
// counterpart (including its own click-to-toggle-off listener). Returns
// false if the item can't be found anymore (e.g. fully satisfied and
// dropped from the plan by the latest recalculation) - render() falls back
// to the normal full list in that case rather than leaving focus mode stuck
// on a vanished item.
function renderFocusedItem() {
  const { section, name } = focusedItem;

  if (currentView === "corp") {
    if (section === "refined") {
      for (const group of corpData.refined || []) {
        const item = (group.materials || []).find((m) => m.name === name);
        if (item) {
          listEl.appendChild(renderRefinedRow(item, group.ore, false));
          return true;
        }
      }
      return false;
    }
    // Every other Corp section (ore/assembly/planetary/commodity) is a flat
    // renderCorpRow() keyed by item.category - see that function's own
    // comment on why category doubles as the section key here.
    const item = (corpData.items || []).find((i) => (i.category || "commodity") === section && i.name === name);
    if (!item) return false;
    listEl.appendChild(renderCorpRow(item));
    return true;
  }

  if (section === "ore") {
    const ore = (personalData.ores || []).find((o) => o.name === name);
    if (!ore) return false;
    listEl.appendChild(renderPersonalRow(ore));
    return true;
  }
  if (section === "refined") {
    for (const group of personalData.refined || []) {
      const item = (group.materials || []).find((m) => m.name === name);
      if (item) {
        listEl.appendChild(renderRefinedRow(item, group.ore, true));
        return true;
      }
    }
    return false;
  }
  if (section === "assembly") {
    const item = (personalData.assembly || []).find((i) => i.name === name);
    if (!item) return false;
    listEl.appendChild(renderAssemblyRow(item));
    (item.breakdown || []).forEach((sub) => listEl.appendChild(renderAssemblyBreakdownRow(sub)));
    return true;
  }
  if (section === "planetary") {
    const item = (personalData.planetary || []).find((i) => i.name === name);
    if (!item) return false;
    listEl.appendChild(renderPlanetaryRow(item));
    return true;
  }
  if (section === "buy") {
    const item = (personalData.buy || []).find((i) => i.name === name);
    if (!item) return false;
    listEl.appendChild(renderBuyRow(item));
    return true;
  }
  return false;
}

function render() {
  listEl.innerHTML = "";
  personalBtn.setAttribute("aria-pressed", String(currentView === "personal"));
  corpBtn.setAttribute("aria-pressed", String(currentView === "corp"));

  if (focusedItem) {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "fsc-back-btn";
    backBtn.textContent = "← All items";
    backBtn.addEventListener("click", () => {
      focusedItem = null;
      render();
    });
    listEl.appendChild(backBtn);
    if (renderFocusedItem()) {
      // Down to just "Manifest" + the close button, the back link, and the
      // one focused row - the Personal Farm/Corp toggle, whichever Farm
      // selector row is showing, and the Add Blueprint/Dashboard header
      // buttons all add nothing useful once you're already looking at a
      // single item (updateSelectionRowVisibility() checks focusedItem
      // itself, same as this).
      viewToggleEl.classList.add("fsc-hidden");
      addBlueprintBtn.style.display = "none";
      dashboardBtn.style.display = "none";
      titleEl.textContent = "Manifest (focused)";
      updateSelectionRowVisibility();
      // Stash-and-clear a fixed height ONLY on the actual transition into
      // focus mode (focusChromeActive was false coming in) - if the panel
      // was previously resized to a fixed height (drag handles - see
      // makeResizable()), that height would otherwise leave a lot of dead
      // space below one row, so let it shrink to fit instead. Guarding on
      // focusChromeActive (not just re-checking panelEl.style.height) is
      // what stops this from re-firing on every subsequent re-render while
      // ALREADY focused (e.g. the ~2s background inventory sync) - without
      // it, a resize made WHILE focused would look like a stale height to
      // restore later and get wiped on the very next unrelated render().
      if (!focusChromeActive) {
        if (panelEl.style.height) {
          stashedPanelHeight = panelEl.style.height;
          panelEl.style.height = "";
        }
        focusChromeActive = true;
      }
      return;
    }
    focusedItem = null; // vanished since it was focused - fall through to the normal full list below
    listEl.innerHTML = "";
  }

  viewToggleEl.classList.remove("fsc-hidden");
  addBlueprintBtn.style.display = "";
  dashboardBtn.style.display = "";
  titleEl.textContent = "Manifest";
  updateSelectionRowVisibility();
  if (focusChromeActive) {
    if (stashedPanelHeight !== null) {
      panelEl.style.height = stashedPanelHeight;
      stashedPanelHeight = null;
    }
    focusChromeActive = false;
  }

  if (currentView === "corp") {
    const byCategory = { ore: [], assembly: [], planetary: [], commodity: [] };
    for (const item of corpData.items || []) {
      (byCategory[item.category] || byCategory.commodity).push(item);
    }
    const flatRender = (items) => items.forEach((item) => listEl.appendChild(renderCorpRow(item)));
    renderSections([
      { label: "Ore", items: byCategory.ore, render: renderCorpOreGroups },
      { label: "Refined", items: corpData.refined || [], render: renderRefinedGroups },
      { label: "Assembly", items: byCategory.assembly, render: flatRender },
      { label: "Planetary", items: byCategory.planetary, render: renderCorpPlanetaryGroups },
      { label: "Commodities", items: byCategory.commodity, render: flatRender },
    ]);
  } else {
    renderSections([
      { label: "Mining", items: personalData.ores || [], render: renderMiningGroups },
      { label: "Refined", items: personalData.refined || [], render: (items) => renderRefinedGroups(items, true) },
      {
        label: "Assembly",
        items: personalData.assembly || [],
        render: (items) => items.forEach((item) => {
          listEl.appendChild(renderAssemblyRow(item));
          (item.breakdown || []).forEach((sub) => listEl.appendChild(renderAssemblyBreakdownRow(sub)));
        }),
      },
      { label: "Planetary", items: personalData.planetary || [], render: renderPlanetaryGroups },
      { label: "Buy", items: personalData.buy || [], render: (items) => items.forEach((item) => listEl.appendChild(renderBuyRow(item))) },
    ]);
  }
}
