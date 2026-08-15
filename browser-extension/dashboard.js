// Dashboard shell: tab switching + shared app state, bootstrapped from
// browser.storage.local. Each tab module exports init(app) which renders
// itself into its <section id="tab-X"> and registers a refresh(app) hook so
// the storage.onChanged chokepoint (wired up in Phase 4) can tell it to
// redraw after another tab or the background script changes shared state -
// this generalizes gui.py's `_after_inventory_updated` cascade.

import "./js/browser-compat.js";
import { Catalog } from "./js/catalog.js";
import { Inventory } from "./js/calc-engine.js";
import * as storage from "./js/storage.js";

import { initOreDatabaseTab } from "./js/tab-ore-database.js";
import { initPlanetsTab } from "./js/tab-planets.js";
import { initInventoryTab } from "./js/tab-inventory.js";
import { initRecipesTab } from "./js/tab-recipes.js";
import { initAssemblyTab } from "./js/tab-assembly.js";
import { initPlanTab } from "./js/tab-plan.js";
import { initCorpTab } from "./js/tab-corp.js";
import { initSettingsTab } from "./js/tab-settings.js";
import { initAboutTab } from "./js/tab-about.js";

// Shared classify(name) -> display-label mapping, ported from gui.py's
// _kind_label - used by Recipes/Assembly (and later Inventory/Plan) tabs.
export function kindLabel(catalog, name) {
  const [kind] = catalog.classify(name);
  return { material: "Refined", ore: "Raw Ore", planet_resource: "Planetary", unknown: "Commodity" }[kind];
}

const app = {
  catalog: null,
  recipes: {},
  inventory: null,
  settings: null,
  harvesterSlots: [],
  maxHarvesters: 4,
  pendingRefining: {},
  assemblyRecipes: {},
  builds: {},
  activeBuildName: null,
  corpInventory: {},
  corpHaveOverrides: {},
  activeCorpBuildName: null,
  planBaseRequirements: {},
  planRequirements: {},
  lastPlanResult: null,
  refreshHooks: {}, // tabId -> () => void, tabs register themselves here
  unsavedGuards: {}, // tabId -> () => boolean, tabs with an in-progress edit register a "do I have unsaved changes right now" check here
  // Checked before any full-page navigation that would tear down every
  // tab's in-memory scratch state at once (see setupToMineSwitch() below) -
  // in-tab navigation (switching the selected recipe, clicking New/Delete)
  // already guards this per-tab via each tab's own confirmDiscard(), but
  // nothing previously protected the one point where the whole page itself
  // gets replaced, silently discarding whatever was mid-edit.
  confirmNavigateAway() {
    for (const isDirty of Object.values(this.unsavedGuards)) {
      if (isDirty && isDirty()) {
        return confirm("You have unsaved changes that will be lost if you leave this page. Continue anyway?");
      }
    }
    return true;
  },
  kindLabel(name) {
    return kindLabel(this.catalog, name);
  },
  // Called after ANY change to inventory/pendingRefining - the reactive
  // chokepoint. Tab modules register a refresh hook under a stable id if
  // they need to react; missing hooks (tabs not yet ported) are skipped.
  async refreshAfterInventoryUpdate() {
    for (const id of ["inventory", "assembly", "plan"]) {
      if (this.refreshHooks[id]) await this.refreshHooks[id]();
    }
  },
};

async function bootstrap() {
  app.catalog = new Catalog();
  app.settings = await storage.loadSettings();
  app.maxHarvesters = Number(app.settings.max_harvesters || 4);
  app.recipes = await storage.loadRecipes();
  app.inventory = await storage.loadInventory(app.catalog);
  app.harvesterSlots = await storage.loadHarvesterSlots(app.maxHarvesters);
  app.pendingRefining = await storage.loadPendingRefining();
  app.assemblyRecipes = await storage.loadAssemblyRecipes();
  app.builds = await storage.loadBuilds();
  app.corpInventory = await storage.loadCorpInventory();
  app.corpHaveOverrides = await storage.loadCorpHaveOverrides();
  app.activeCorpBuildName = await storage.loadActiveCorpBuildName();

  initOreDatabaseTab(app, document.getElementById("tab-ore-database"));
  initPlanetsTab(app, document.getElementById("tab-planets"));
  initInventoryTab(app, document.getElementById("tab-inventory"));
  initRecipesTab(app, document.getElementById("tab-recipes"));
  initAssemblyTab(app, document.getElementById("tab-assembly"));
  initPlanTab(app, document.getElementById("tab-plan"));
  initCorpTab(app, document.getElementById("tab-corp"));
  initSettingsTab(app, document.getElementById("tab-settings"));
  initAboutTab(app, document.getElementById("tab-about"));

  setupTabSwitching();

  // Cross-tab / cross-context reactivity: if background.js (or another
  // dashboard tab) writes inventory/recipes/assemblyRecipes/builds while
  // this page is open, refresh in place instead of showing stale data.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.inventory) {
      storage.loadInventory(app.catalog).then((inv) => {
        app.inventory = inv;
        app.refreshAfterInventoryUpdate();
      });
    }
    if (changes.pendingRefining) {
      storage.loadPendingRefining().then((p) => {
        app.pendingRefining = p;
        app.refreshAfterInventoryUpdate();
      });
    }
    if (changes.inventorySyncMeta && app.refreshHooks.inventory) {
      app.refreshHooks.inventory();
    }
    if (changes.corpInventory) {
      storage.loadCorpInventory().then((inv) => {
        app.corpInventory = inv;
        if (app.refreshHooks.corp) app.refreshHooks.corp();
      });
    }
    if (changes.corpHaveOverrides) {
      storage.loadCorpHaveOverrides().then((haveOverrides) => {
        app.corpHaveOverrides = haveOverrides;
        if (app.refreshHooks.corp) app.refreshHooks.corp();
      });
    }
    if (changes.recipes) {
      storage.loadRecipes().then((recipes) => {
        app.recipes = recipes;
        if (app.refreshHooks.recipes) app.refreshHooks.recipes();
      });
    }
    if (changes.assemblyRecipes) {
      storage.loadAssemblyRecipes().then((assemblyRecipes) => {
        app.assemblyRecipes = assemblyRecipes;
        if (app.refreshHooks.assembly) app.refreshHooks.assembly();
      });
    }
    // Plan a Build already refreshes its own build selector directly after
    // its own add/delete/complete actions (see tab-plan.js's
    // refreshBuildCombo() call sites) - this is for everyone ELSE: the Corp
    // tab's build dropdown (and prefill data) otherwise goes stale the
    // moment a build is renamed/deleted/completed, whether that happened
    // elsewhere on this same page or in a second dashboard window entirely.
    if (changes.builds) {
      storage.loadBuilds().then((builds) => {
        app.builds = builds;
        if (app.refreshHooks.corp) app.refreshHooks.corp();
      });
    }
  });
}

// The dashboard can now load inside the same floating "Manifest" window
// (see popup.js's "Dashboard" button, which navigates that window here
// instead of opening a separate tab) as well as a normal browser tab. The
// "← Manifest" switcher only makes sense in the former case - popup.html's
// content is sized/styled for a small chrome-less popup window, so
// navigating a full normal tab to it would just look broken (tiny content
// floating in an otherwise full-size tab with an address bar above it).
async function setupToMineSwitch() {
  const btn = document.getElementById("to-mine-switch");
  const win = await browser.windows.getCurrent();
  if (win.type !== "popup") return;
  btn.style.display = "";
  btn.addEventListener("click", () => {
    if (!app.confirmNavigateAway()) return;
    window.location.href = "popup.html";
  });
}

function setupTabSwitching() {
  const buttons = [...document.querySelectorAll(".tab-btn")];
  const panels = [...document.querySelectorAll(".tab-panel")];

  function activate(tabId) {
    for (const btn of buttons) btn.classList.toggle("active", btn.dataset.tab === tabId);
    for (const panel of panels) panel.classList.toggle("active", panel.id === `tab-${tabId}`);
  }

  for (const btn of buttons) {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  }
  activate("ore-database");
}

bootstrap();
setupToMineSwitch();
