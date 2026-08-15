// Inventory tab - live item table (fed by background.js's storage scrape,
// not a manual refresh - there's no CSV fallback here) + pending-refining
// tracker. Port of gui.py's _build_inventory_tab and its handlers.

import { el, clear, selectableRow } from "./dom-helpers.js";
import * as storage from "./storage.js";

// Deducts (newBatches - oldBatches) * ore.batch raw ore from inventory
// immediately (optimistic local update, ahead of the next live scrape sync)
// - but ONLY on an increase. Deliberately never reversed on decrease/clear:
// a real sync will correct that instead, to avoid double-crediting ore that
// was already spent. Port of gui.py's _apply_local_pending_deduction.
export async function applyLocalPendingDeduction(app, ore, oldBatches, newBatches) {
  if (newBatches <= oldBatches) return;
  const delta = (newBatches - oldBatches) * ore.batch;
  const current = app.inventory.rawOre.get(ore) || 0;
  app.inventory.rawOre.set(ore, Math.max(0, current - delta));
  await storage.saveInventory(app.inventory);
}

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

  // --- Pending refining ---
  const pendingOreSelect = el(
    "select",
    {},
    app.catalog.oreNames().map((n) => el("option", { value: n, text: n }))
  );
  const pendingBatchesInput = el("input", { type: "text", value: "0", style: "width:70px" });
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
      const outputAmount = batches * ore.refinedQ;
      const outputsStr = ore.outputs.map((m) => `${m.name} +${outputAmount}`).join(", ");
      const row = selectableRow(
        { "data-ore": oreName },
        `Select ${oreName}, ${batches} batches pending`,
        [el("td", { text: oreName }), el("td", { text: String(batches) }), el("td", { text: String(rawCommitted) }), el("td", { text: outputsStr })],
        () => {}
      );
      pendingTbody.appendChild(row);
    }
  }

  async function setPendingRefining() {
    const oreName = pendingOreSelect.value;
    const batches = parseInt(pendingBatchesInput.value, 10);
    if (!oreName || Number.isNaN(batches) || batches < 0) {
      alert("Choose an ore and enter a whole number of batches (0 or more).");
      return;
    }
    const ore = app.catalog.findOre(oreName);
    const oldBatches = app.pendingRefining[oreName] || 0;
    await applyLocalPendingDeduction(app, ore, oldBatches, batches);
    if (batches <= 0) delete app.pendingRefining[oreName];
    else app.pendingRefining[oreName] = batches;
    await storage.savePendingRefining(app.pendingRefining);
    renderInventoryTable();
    renderPendingTable();
  }

  async function clearSelectedPending() {
    const row = pendingTbody.querySelector("tr.selected");
    if (!row) return;
    delete app.pendingRefining[row.dataset.ore];
    await storage.savePendingRefining(app.pendingRefining);
    renderPendingTable();
  }

  container.appendChild(
    el("div", {}, [
      statusLine,
      el("div", { class: "toolbar" }, [el("label", { text: "Search:" }), searchInput]),
      el("div", { class: "scroll-table" }, [invTable]),
      el("h3", { class: "section-title", text: "Refining In Progress" }),
      el("div", { class: "toolbar" }, [
        pendingOreSelect,
        el("label", { text: "Batches:" }),
        pendingBatchesInput,
        el("button", { text: "Set", onclick: setPendingRefining }),
      ]),
      el("div", { class: "scroll-table" }, [pendingTable]),
      el("div", { class: "toolbar" }, [el("button", { text: "Clear Selected", onclick: clearSelectedPending })]),
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
