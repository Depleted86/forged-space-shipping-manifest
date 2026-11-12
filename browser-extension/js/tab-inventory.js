// Inventory tab - live item table (fed by background.js's storage scrape,
// not a manual refresh - there's no CSV fallback here) + the refining jobs
// counted from the game (background.js's handleRefiningJobs()). Port of
// gui.py's _build_inventory_tab and its handlers.

import { el, clear } from "./dom-helpers.js";
import * as storage from "./storage.js";
import { Inventory } from "./calc-engine.js";

export function initInventoryTab(app, container) {
  let search = "";

  const statusLine = el("div", { class: "status-text" });

  const searchInput = el("input", {
    type: "text",
    placeholder: "Search item...",
    oninput: (e) => { search = e.target.value; renderInventoryTable(); },
  });
  const invTbody = el("tbody");
  const invTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Category", "Item", "Quantity"].map((h) => el("th", { text: h })))]),
    invTbody,
  ]);

  async function renderStatusLine() {
    const meta = await storage.loadInventorySyncStatus();
    if (!meta) {
      statusLine.textContent = "No sync yet - open the storage screen in-game to sync inventory.";
      return;
    }
    const stamp = new Date(meta.syncedAt).toLocaleTimeString();
    statusLine.textContent = `Synced from browser (live storage scrape, ${stamp}) — ${meta.matched} matched, ${meta.unmatched} other items.`;
    statusLine.className = "status-text status-ok";
  }

  function renderInventoryTable() {
    clear(invTbody);
    const rows = [];
    for (const [ore, qty] of app.inventory.rawOre.entries()) rows.push(["Raw Ore", ore.name, qty]);
    for (const [mat, qty] of app.inventory.refined.entries()) rows.push(["Refined", mat.name, qty]);
    // inventory.other holds both true Commodities (Assembly outputs) and
    // planet-harvested resources - they're stored the same flat way since
    // both are read identically during planning (see planMining()'s
    // `else { have = inventory.other[name] ... }` branch), but the display
    // label should still tell them apart. kindLabel() re-classifies each
    // name against the full catalog (including planetResources), rather
    // than assuming everything here is a Commodity.
    for (const [name, qty] of Object.entries(app.inventory.other)) rows.push([app.kindLabel(name), name, qty]);
    rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

    const needle = search.trim().toLowerCase();
    for (const [category, name, qty] of rows) {
      if (needle && !name.toLowerCase().includes(needle)) continue;
      invTbody.appendChild(
        el("tr", {}, [el("td", { text: category }), el("td", { text: name }), el("td", { text: String(qty) })])
      );
    }
  }

  // --- Refining in progress (read-only, from the game) ---
  const pendingTbody = el("tbody");
  const pendingTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Ore", "Batches", "Raw Committed", "Pending Output"].map((h) => el("th", { text: h })))]),
    pendingTbody,
  ]);

  function renderPendingTable() {
    clear(pendingTbody);
    for (const [oreName, batches] of Object.entries(app.pendingRefining)) {
      if (batches <= 0) continue;
      const ore = app.catalog.findOre(oreName);
      if (!ore) continue;
      const rawCommitted = batches * ore.batch;
      const outputAmount = Math.round(batches * ore.refinedQ);
      const outputsStr = ore.outputs.map((m) => `${m.name} +${outputAmount}`).join(", ");
      const shown = Math.round(batches * 10) / 10;
      pendingTbody.appendChild(el("tr", {}, [el("td", { text: oreName }), el("td", { text: String(shown) }), el("td", { text: String(Math.round(rawCommitted)) }), el("td", { text: outputsStr })]));
    }
  }

  // Storage scrapes merge into this list (see background.js's
  // handleStorageScrape()) so a filtered storage screen can't wipe it - which
  // means an item used up entirely keeps its last count. This empties the
  // list so the next unfiltered storage visit rebuilds it from scratch.
  async function clearStoredInventory() {
    if (!confirm("Clear the stored inventory? Open your storage screen in-game, with no filter, to rebuild it.")) return;
    app.inventory = new Inventory();
    await storage.saveInventory(app.inventory);
    renderInventoryTable();
    browser.runtime.sendMessage({ type: "fsc-refresh-manifest-selection" }).catch(() => {});
    browser.runtime.sendMessage({ type: "fsc-refresh-manifest-corp-selection" }).catch(() => {});
  }

  container.appendChild(
    el("div", {}, [
      statusLine,
      el("div", { class: "hint", text: "Opening your Commercial Storage with the search box empty refreshes the whole list. While searching, only the items shown are updated and the rest keep their last count, so the in-game filter is safe to use." }),
      el("div", { class: "toolbar" }, [el("label", { text: "Search:" }), searchInput, el("button", { text: "Clear stored inventory", onclick: clearStoredInventory })]),
      el("div", { class: "scroll-table" }, [invTable]),
      el("h3", { class: "section-title", text: "Refining In Progress" }),
      el("div", { class: "hint", text: "Filled in from the game: open the Refining Center at a refinery, or Info → Refining for all of them, and every job not yet collected is counted once. Collected jobs come off by themselves." }),
      el("div", { class: "scroll-table" }, [pendingTable]),
    ])
  );

  renderStatusLine();
  renderInventoryTable();
  renderPendingTable();

  app.refreshHooks.inventory = () => {
    renderStatusLine();
    renderInventoryTable();
    renderPendingTable();
  };
}
