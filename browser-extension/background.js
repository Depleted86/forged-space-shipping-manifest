// MV3 background service worker (not a persistent background page -
// Chrome MV3 requires this, and Firefox's MV3 support follows the same
// service_worker manifest key for a single cross-browser manifest.json).
//
// Classifies a scraped storage-screen snapshot from content.js and writes it
// straight into browser.storage.local, instead of relaying it to the Python
// bridge over HTTP the way the pre-migration version did.
//
// Unlike the old persistent background page, a service worker can be
// terminated by the browser whenever it's idle and restarted later on the
// next event (a message, an action click, etc.) - it does NOT keep running
// in the background the whole time the browser is open. This is fine for
// this file: handleStorageScrape() and the action click handler are both
// pure event-response functions with no reliance on state surviving between
// invocations (see findToMineWindow() below, which deliberately queries
// live window state each time instead of remembering a window id in a
// variable, since any such variable would silently reset to its initial
// value every time the worker restarts).
//
// The old GET /to-mine.json polling loop that used to live here is gone:
// the "To Mine" window (popup.html/popup.js) reads storage.local's
// `toMineData` key directly (extension pages have storage access, so no
// relay was needed), and the dashboard's Plan a Build tab writes that key
// on every calculation.
//
// The toolbar icon opens/focuses that "To Mine" window as a real floating
// browser window (type: "popup"), not an action dropdown - a dropdown
// always closes on blur/outside-click with no way to override that, which
// didn't fit the user's ask for something that stays open and can be
// dragged beside the game window. The dashboard is reached by navigating
// that SAME window (popup.js's "Dashboard" button sets window.location),
// not by opening a separate tab - see popup.js and dashboard.js's
// "← To Mine" switcher for the round trip.

import "./js/browser-compat.js";
import { Catalog } from "./js/catalog.js";
import { applyItemsToInventory } from "./js/inventory-classify.js";
import * as storage from "./js/storage.js";

const catalog = new Catalog();

// One-time permission/privacy disclaimer, shown as a new tab the first time
// the extension is installed - NOT on every browser start or on updates
// (details.reason is "install" only once, ever, per install; "update" fires
// on every version bump and "browser_update" on browser upgrades, neither
// of which should re-show this).
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") return;
  browser.tabs.create({ url: browser.runtime.getURL("welcome.html") });
});

// Finds an already-open "To Mine" window by looking for a tab pointing at
// this extension's own popup.html - not by remembering a window id, since
// an in-memory variable wouldn't survive a service-worker restart. Reading
// tab.url for the extension's own pages doesn't require the "tabs"
// permission (only reading OTHER sites' tab URLs does).
async function findToMineWindow() {
  const popupUrl = browser.runtime.getURL("popup.html");
  const wins = await browser.windows.getAll({ populate: true });
  return wins.find((win) => win.tabs && win.tabs.some((tab) => tab.url === popupUrl)) || null;
}

browser.action.onClicked.addListener(async () => {
  const existing = await findToMineWindow();
  if (existing) {
    await browser.windows.update(existing.id, { focused: true });
    return;
  }
  // Small starting size - popup.js measures its own rendered content and
  // resizes this window to fit (widest row / row count) right after first
  // render, so this is just a placeholder that's visible for a moment.
  await browser.windows.create({
    url: browser.runtime.getURL("popup.html"),
    type: "popup",
    width: 300,
    height: 160,
  });
});

// items: [{name, quantity}, ...] scraped from the storage screen by
// content.js. Classifies against the shared Catalog and merges into
// whatever's currently in storage.local's `inventory` key - the same
// classification logic used to live in inventory_import.py's
// apply_items_to_inventory, called from the Python bridge's POST handler.
async function handleStorageScrape(items) {
  const itemsDict = {};
  for (const item of items || []) {
    if (item && item.name && item.quantity !== null && item.quantity !== undefined) {
      itemsDict[String(item.name)] = Number(item.quantity);
    }
  }
  const inventory = await storage.loadInventory(catalog);
  const { matched, unmatched } = applyItemsToInventory(catalog, inventory, itemsDict);
  await storage.saveInventory(inventory);
  await storage.saveInventorySyncStatus({ syncedAt: new Date().toISOString(), matched, unmatched });
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "fsc-storage-scrape") {
    handleStorageScrape(msg.items);
  }
});
