// Read-only content script for https://forgedspace.com/*. Scrapes the
// storage screen's item rows and relays them to background.js for
// inventory sync. Deliberately does NOT modify the page's DOM/appearance in
// any way - an earlier version injected a "To Mine" panel directly into the
// game's UI, but that was reverted in favor of a toolbar-triggered floating
// window (popup.html/popup.js) that shows the same data outside the game
// page entirely.

// Storage screen: each item is a row like
//   <div class="p-3 rounded border cursor-pointer transition-colors
//                bg-gray-800/30 border-gray-600/30 hover:border-blue-500/40">
//     <div class="font-medium text-cyan-100 text-sm">Chloracite Ore</div>
//     <div class="text-xs text-gray-400">19 units</div>
//     ...
// confirmed via live inspection - not virtualized, all rows exist in the DOM
// at once even when scrolled out of view.
const STORAGE_ROW_SELECTOR = 'div[class*="cursor-pointer"][class*="bg-gray-800/30"][class*="border-gray-600/30"]';
const STORAGE_NAME_SELECTOR = ".font-medium.text-cyan-100.text-sm";
const STORAGE_QTY_SELECTOR = ".text-xs.text-gray-400";
const STORAGE_POLL_MS = 2000;

let lastStorageSnapshot = null;

// Scrapes whatever storage rows are currently in the DOM. Returns [] if the
// storage screen isn't open (selector matches nothing).
function scrapeStorageRows() {
  const rows = document.querySelectorAll(STORAGE_ROW_SELECTOR);
  const items = [];
  rows.forEach((row) => {
    const nameEl = row.querySelector(STORAGE_NAME_SELECTOR);
    const qtyEl = row.querySelector(STORAGE_QTY_SELECTOR);
    if (!nameEl || !qtyEl) return;
    const name = nameEl.textContent.trim();
    // "1,276 units" - strip thousands separators before parseFloat, which
    // would otherwise stop at the comma and read this as 1.
    const quantity = parseFloat(qtyEl.textContent.replace(/,/g, ""));
    if (!name || Number.isNaN(quantity)) return;
    items.push({ name, quantity });
  });
  return items;
}

// Same bounded-polling approach as elsewhere in this project - a plain
// interval, not a MutationObserver, since a first version using
// observer.observe(document.body, {subtree: true}) tripped Firefox's "this
// extension is slowing down your browser" warning on this live, frequently
// re-rendering game UI. A single querySelectorAll() every 2s is cheap and
// bounded by comparison. Only sends a message (and thus only triggers a
// storage.local write in background.js) when the scraped snapshot actually
// changed since the last tick, so leaving the storage screen open and idle
// doesn't write every 2s.
function checkStorage() {
  const items = scrapeStorageRows();
  if (items.length === 0) return;
  const snapshot = JSON.stringify(items);
  if (snapshot === lastStorageSnapshot) return;
  lastStorageSnapshot = snapshot;
  browser.runtime.sendMessage({ type: "fsc-storage-scrape", items }).catch(() => {});
}

setInterval(checkStorage, STORAGE_POLL_MS);
