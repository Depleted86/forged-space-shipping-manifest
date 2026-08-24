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
import { initBlueprintsTab } from "./js/tab-blueprints.js";
import { initAssemblyTab } from "./js/tab-assembly.js";
import { initPlanTab } from "./js/tab-plan.js";
import { initCorpTab } from "./js/tab-corp.js";
import { initSettingsTab } from "./js/tab-settings.js";
import { initAboutTab } from "./js/tab-about.js";

// Shared classify(name) -> display-label mapping, ported from gui.py's
// _kind_label - used by Blueprints/Assembly (and later Inventory/Plan) tabs.
export function kindLabel(catalog, name) {
  const [kind] = catalog.classify(name);
  return { material: "Refined", ore: "Raw Ore", planet_resource: "Planetary", unknown: "Commodity" }[kind];
}

const app = {
  catalog: null,
  isFirstLaunch: false,
  blueprints: {},
  inventory: null,
  settings: null,
  harvesterSlots: [],
  maxHarvesters: 4,
  pendingRefining: {},
  assemblyPlans: {},
  builds: {},
  activeBuildName: null,
  corpInventory: {},
  corpHaveOverrides: {},
  activeCorpBuildName: null,
  planBaseRequirements: {},
  planRequirements: {},
  lastPlanResult: null,
  refreshHooks: {}, // tabId -> () => void, tabs register themselves here
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
  // Overlays whatever's already been scraped from the in-game Systems
  // Lexicon on top of the static baseline - see catalog.js's
  // applyScrapedPlanetTypes() comment.
  app.catalog.applyScrapedPlanetTypes(await storage.loadScrapedPlanetTypes());
  // Checked (and immediately marked done) before anything else loads, so a
  // brand-new install lands on Settings instead of Ore Database - see
  // storage.js's loadDashboardOnboarded() comment for why this isn't done
  // via browser.runtime.onInstalled.
  app.isFirstLaunch = !(await storage.loadDashboardOnboarded());
  if (app.isFirstLaunch) await storage.saveDashboardOnboarded();
  app.settings = await storage.loadSettings();
  app.maxHarvesters = Number(app.settings.max_harvesters || 4);
  app.blueprints = await storage.loadBlueprints();
  app.inventory = await storage.loadInventory(app.catalog);
  app.harvesterSlots = await storage.loadHarvesterSlots(app.maxHarvesters);
  app.pendingRefining = await storage.loadPendingRefining();
  app.assemblyPlans = await storage.loadAssemblyPlans();
  app.builds = await storage.loadBuilds();
  app.corpInventory = await storage.loadCorpInventory();
  app.corpHaveOverrides = await storage.loadCorpHaveOverrides();
  app.activeCorpBuildName = await storage.loadActiveCorpBuildName();

  initOreDatabaseTab(app, document.getElementById("tab-ore-database"));
  initPlanetsTab(app, document.getElementById("tab-planets"));
  initInventoryTab(app, document.getElementById("tab-inventory"));
  initBlueprintsTab(app, document.getElementById("tab-blueprints"));
  initAssemblyTab(app, document.getElementById("tab-assembly"));
  initPlanTab(app, document.getElementById("tab-plan"));
  initCorpTab(app, document.getElementById("tab-corp"));
  initSettingsTab(app, document.getElementById("tab-settings"));
  initAboutTab(app, document.getElementById("tab-about"));

  setupTabSwitching(app.isFirstLaunch ? "settings" : "ore-database");

  // Cross-tab / cross-context reactivity: if background.js (or another
  // dashboard tab) writes inventory/blueprints/assemblyPlans/builds while
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
    if (changes.blueprints) {
      storage.loadBlueprints().then((blueprints) => {
        app.blueprints = blueprints;
        // Both the Blueprints tab's own list AND Plan a Build's "add a
        // blueprint" dropdown need this - otherwise a blueprint added
        // anywhere other than this exact dashboard tab's own Blueprints tab
        // (the in-page Add Blueprint modal on the game page, or a second
        // dashboard tab) never shows up in Plan a Build here until manually
        // switching tabs or reloading.
        if (app.refreshHooks.blueprints) app.refreshHooks.blueprints();
        if (app.refreshHooks.planBlueprintCombo) app.refreshHooks.planBlueprintCombo();
      });
    }
    if (changes.assemblyPlans) {
      storage.loadAssemblyPlans().then((assemblyPlans) => {
        app.assemblyPlans = assemblyPlans;
        if (app.refreshHooks.assembly) app.refreshHooks.assembly();
      });
    }
    // app.settings was loaded ONCE at bootstrap and otherwise never
    // refreshed - but tab-plan.js's pruneStaleItemSettings()/"Item sources"
    // Mine-Buy toggle/calculatePlan(), and Settings tab's own Save, all call
    // storage.saveSettings(app.settings) using THIS SAME stale in-memory
    // object. Without this listener, any of those saves - triggered for a
    // completely unrelated reason (switching builds, recalculating a plan)
    // - would silently clobber a settings field changed elsewhere in the
    // meantime (e.g. the Manifest overlay's per-item Farm/Buy toggle, or a
    // per-material ore choice) back to whatever this stale snapshot had.
    // Confirmed as the actual cause of a real "the overlay's Buy/Farm
    // choice keeps reverting" report - not a rendering bug, a stale-write
    // bug. Replaces the whole object (not a per-field patch) since any
    // field could have changed; every read site accesses app.settings.X at
    // read-time rather than caching a reference, so this is safe.
    if (changes.settings) {
      storage.loadSettings().then((settings) => {
        app.settings = settings;
        app.maxHarvesters = Number(settings.max_harvesters || app.maxHarvesters);
        if (app.refreshHooks.planCargoCapacity) app.refreshHooks.planCargoCapacity();
      });
    }
    // A fresh Systems Lexicon scrape (background.js's handleLexiconPlanetsScrape())
    // re-applies onto the SAME app.catalog instance (additive, see
    // catalog.js's applyScrapedPlanetTypes()) rather than replacing it, so
    // every other tab's already-classified Ore/Material/PlanetType
    // references stay valid - only the Planets tab needs to actually redraw.
    if (changes.scrapedPlanetTypes) {
      storage.loadScrapedPlanetTypes().then((scraped) => {
        app.catalog.applyScrapedPlanetTypes(scraped);
        if (app.refreshHooks.planets) app.refreshHooks.planets();
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

function setupTabSwitching(defaultTab) {
  const buttons = [...document.querySelectorAll(".tab-btn")];
  const panels = [...document.querySelectorAll(".tab-panel")];

  function activate(tabId) {
    for (const btn of buttons) btn.classList.toggle("active", btn.dataset.tab === tabId);
    for (const panel of panels) panel.classList.toggle("active", panel.id === `tab-${tabId}`);
  }

  for (const btn of buttons) {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  }
  activate(defaultTab);
}

bootstrap();
