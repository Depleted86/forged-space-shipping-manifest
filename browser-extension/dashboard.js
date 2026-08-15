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

// Matches popup.js's own DASHBOARD_WIDTH/HEIGHT constants - kept as a
// separate copy rather than shared/imported since these two files don't
// otherwise share any module, and it's just two numbers.
const DASHBOARD_WIDTH = 1000;
const DASHBOARD_HEIGHT = 700;

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

  // Authoritative resize-up, run from THIS page's own already-loaded
  // context - not relying solely on popup.js's "Dashboard →" button, which
  // resizes the OLD document right before navigating away from it. That
  // pre-navigation resize is still worth keeping as a head start (it
  // starts the window growing immediately on click, before this page has
  // even loaded), but the browser doesn't guarantee a size change
  // requested against a document that's about to be replaced actually
  // carries over cleanly to the incoming page's renderer - this is what
  // showed up as the dashboard rendering "collapsed" the first time you
  // switched to it. Only grows (never shrinks) - a player who's manually
  // resized the dashboard bigger for their own comfort shouldn't get
  // snapped back down just from reloading/renavigating here.
  //
  // Deliberately NOT queried/applied immediately at module-load time - right
  // after a cross-page navigation, Chrome's window manager can still be
  // mid-settle from whatever popup.js's own pre-navigation resize just did,
  // and both reading win.width/height AND issuing windows.update() too
  // early in that window can silently no-op (no error, no effect) rather
  // than actually reporting/applying the real size - this is what showed up
  // as the dashboard sometimes not resizing AT ALL on the very first
  // switch, only starting to work again once something else (e.g. manually
  // nudging the window) forced Chrome to catch up. A short delay via
  // window.onload + an extra tick gives that settling time to happen before
  // this reads/acts on the window's geometry at all. Fire-and-forget (not
  // awaited) so it can't delay attaching the click listener below - a very
  // fast click during that delay should still work immediately, not get
  // silently missed because the listener wasn't wired up yet.
  (async () => {
    await new Promise((resolve) => {
      if (document.readyState === "complete") resolve();
      else window.addEventListener("load", resolve, { once: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      const freshWin = await browser.windows.getCurrent();
      if (freshWin.width < DASHBOARD_WIDTH || freshWin.height < DASHBOARD_HEIGHT) {
        const centerX = freshWin.left + freshWin.width / 2;
        const centerY = freshWin.top + freshWin.height / 2;
        const left = Math.round(centerX - DASHBOARD_WIDTH / 2);
        const top = Math.round(centerY - DASHBOARD_HEIGHT / 2);
        await browser.windows.update(freshWin.id, { width: DASHBOARD_WIDTH, height: DASHBOARD_HEIGHT, left, top });
      }
    } catch (err) {
      console.warn("Couldn't resize dashboard window to full size:", err);
    }
  })();

  btn.addEventListener("click", async () => {
    if (!app.confirmNavigateAway()) return;
    // Shrink back down toward the Manifest popup's compact footprint BEFORE
    // navigating, mirroring popup.js's own "Dashboard →" button (which
    // grows the window before switching this way) - same centered-resize
    // approach, for the same reason documented there (window.screen's
    // available-area APIs aren't reliable across monitors, and
    // browser.system.display needs its own permission and isn't even
    // implemented in Firefox). Without this, the window sits at the full
    // dashboard size until popup.js's own resizeToFit() finishes its own
    // async round trip through storage after the page loads - this just
    // gets it into the right neighborhood immediately so that doesn't read
    // as a stuck/broken layout in the meantime.
    try {
      const current = await browser.windows.getCurrent();
      const width = 320;
      const height = 160;
      const centerX = current.left + current.width / 2;
      const centerY = current.top + current.height / 2;
      const left = Math.round(centerX - width / 2);
      const top = Math.round(centerY - height / 2);
      await browser.windows.update(current.id, { width, height, left, top });
    } catch (err) {
      console.warn("Couldn't resize before switching to Manifest:", err);
    }
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
