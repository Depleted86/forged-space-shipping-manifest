// Planets tab - filterable planet browser + fixed harvester-slot roster
// editor with a live rate-summary lookup. Port of gui.py's
// _build_planets_tab and its handlers.

import { el, clear } from "./dom-helpers.js";
import { harvesterTotals } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initPlanetsTab(app, container) {
  let planetSearch = "";
  let selectedResource = "";

  // --- Systems Lexicon sync hint ---
  // Unlike inventory/Corp Store/Assembler Plans (all scraped continuously
  // while their screen is open during normal play), opening the Lexicon's
  // Manufacturing > "Planet Types & Resources" panel is a deliberate, rare
  // action - this hint is the only way a player would know that's what
  // triggers a sync at all. See content.js's checkLexiconPlanets().
  const lexiconHint = el("div", {
    class: "hint",
    text: 'New planet types sync automatically - in-game, open the Systems Lexicon, go to Manufacturing, and expand "Planet Types & Resources".',
  });
  const planetSyncStatus = el("div", { class: "status-text" });
  async function renderPlanetSyncStatus() {
    const meta = await storage.loadPlanetSyncStatus();
    planetSyncStatus.textContent = meta
      ? `Planet data last synced ${new Date(meta.syncedAt).toLocaleString()} - ${meta.count} type(s) known.`
      : "No Lexicon sync yet - open the Systems Lexicon in-game to sync.";
  }

  // --- Planet browser ---
  const searchLabel = el("label", { for: "planets-search-input", text: "Search:" });
  const searchInput = el("input", {
    id: "planets-search-input",
    type: "text",
    placeholder: "Search planet or resource...",
    oninput: (e) => { planetSearch = e.target.value; renderPlanetTable(); },
  });
  const planetTbody = el("tbody");
  const planetTable = el("table", { class: "data-table" }, [
    el("thead", {}, [el("tr", {}, ["Planet Type", "Description", "Resources"].map((h) => el("th", { text: h })))]),
    planetTbody,
  ]);

  function renderPlanetTable() {
    clear(planetTbody);
    const needle = planetSearch.trim().toLowerCase();
    const planets = [...app.catalog.planetTypes.values()].filter((pt) => {
      if (!needle) return true;
      if (pt.name.toLowerCase().includes(needle)) return true;
      return pt.resources.some((r) => r.name.toLowerCase().includes(needle));
    });
    for (const pt of planets) {
      planetTbody.appendChild(
        el("tr", {}, [
          el("td", { text: pt.name }),
          el("td", { text: pt.description }),
          el("td", { text: pt.resources.map((r) => r.name).join(", ") }),
        ])
      );
    }
  }

  // --- Quick rate lookup ---
  const resourceSelectLabel = el("label", { for: "planets-resource-select", text: "Resource:" });
  const resourceSelect = el(
    "select",
    {
      id: "planets-resource-select",
      onchange: (e) => { selectedResource = e.target.value; renderHarvesterSummary(); },
    },
    [el("option", { value: "", text: "(choose a resource)" }), ...app.catalog.planetResourceNames().map((n) => el("option", { value: n, text: n }))]
  );
  const summaryLabel = el("div", { class: "summary-text" });

  // resourceSelect's options are only built once at tab-init time (unlike
  // renderRoster()'s per-slot selects, which already rebuild fresh on every
  // refresh) - a newly-Lexicon-scraped resource needs this to pick it up.
  function refreshResourceSelectOptions() {
    const current = resourceSelect.value;
    clear(resourceSelect);
    resourceSelect.appendChild(el("option", { value: "", text: "(choose a resource)" }));
    for (const n of app.catalog.planetResourceNames()) resourceSelect.appendChild(el("option", { value: n, text: n }));
    resourceSelect.value = current;
  }

  function renderHarvesterSummary() {
    if (!selectedResource) {
      summaryLabel.textContent = "Choose a resource to see current harvester coverage.";
      return;
    }
    const totals = harvesterTotals(app.harvesterSlots);
    const rate = totals[selectedResource] || 0;
    const assignedSlots = app.harvesterSlots
      .map((slot, i) => (slot.resource === selectedResource ? i + 1 : null))
      .filter((n) => n !== null);
    if (assignedSlots.length === 0) {
      summaryLabel.textContent = "No harvesters currently assigned to this resource.";
    } else {
      summaryLabel.textContent = `Gathering at ${rate}/hr — harvester(s) ${assignedSlots.map((n) => "#" + n).join(", ")}`;
    }
  }

  // --- Harvester roster ---
  const usageLabel = el("div", { class: "status-text" });
  const rosterBody = el("div");

  function renderRoster() {
    clear(rosterBody);
    for (let i = 0; i < app.maxHarvesters; i++) {
      const slot = app.harvesterSlots[i] || { resource: null, rate: 0 };
      const resourceSelId = `harvester-${i}-resource`;
      const rateInputId = `harvester-${i}-rate`;
      const resourceSel = el(
        "select",
        { id: resourceSelId },
        [el("option", { value: "", text: "(idle)" }), ...app.catalog.planetResourceNames().map((n) => el("option", { value: n, text: n, selected: n === slot.resource ? "" : undefined }))]
      );
      resourceSel.value = slot.resource || "";
      const rateInput = el("input", { id: rateInputId, type: "text", value: String(slot.rate ?? 0) });

      const commit = () => updateSlot(i, resourceSel.value, rateInput.value);
      resourceSel.addEventListener("change", commit);
      rateInput.addEventListener("blur", commit);
      rateInput.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });

      rosterBody.appendChild(
        el("div", { class: "field-row" }, [
          el("label", { for: resourceSelId, text: `Harvester ${i + 1}:` }),
          resourceSel,
          el("label", { for: rateInputId, text: "Rate (units/hr):" }),
          rateInput,
        ])
      );
    }
  }

  async function updateSlot(index, resourceValue, rateValue) {
    const resource = resourceValue || null;
    const rate = parseFloat(rateValue);
    if (Number.isNaN(rate) || rate < 0) {
      alert("Invalid rate - enter a number 0 or greater.");
      renderRoster();
      return;
    }
    app.harvesterSlots[index] = { resource, rate: resource ? rate : 0 };
    await storage.saveHarvesterSlots(app.harvesterSlots);
    // Deliberately NOT renderRoster() here (only on the invalid-input path
    // above) - this fires from resourceSel's "change" and rateInput's
    // "blur", i.e. WHILE the user may still be tabbing through the roster.
    // renderRoster() tears down and rebuilds every <select>/<input> in the
    // roster, including whichever one currently has focus - destroying the
    // focused element mid-Tab-keypress makes the browser lose track of
    // where "next" should go, which is exactly what caused tabbing to loop
    // back to Harvester 1 instead of continuing to Harvester 2's rate. The
    // fields already show the just-committed values (they're the source of
    // the commit), so nothing here actually needs the roster DOM rebuilt.
    renderUsage();
    renderHarvesterSummary();
  }

  function renderUsage() {
    const used = app.harvesterSlots.filter((s) => s.resource).length;
    usageLabel.textContent = `${used} / ${app.maxHarvesters} harvester slots assigned`;
  }

  container.appendChild(
    el("div", {}, [
      lexiconHint,
      planetSyncStatus,
      el("div", { class: "toolbar" }, [searchLabel, searchInput]),
      el("div", { class: "scroll-table" }, [planetTable]),
      el("h3", { class: "section-title", text: "Quick rate lookup" }),
      el("div", { class: "toolbar" }, [resourceSelectLabel, resourceSelect]),
      summaryLabel,
      el("h3", { class: "section-title", text: `Harvesters (${app.maxHarvesters} max at a time)` }),
      rosterBody,
      usageLabel,
    ])
  );

  renderPlanetTable();
  renderHarvesterSummary();
  renderRoster();
  renderUsage();
  renderPlanetSyncStatus();

  app.refreshHooks.planets = () => {
    renderRoster();
    renderUsage();
    renderHarvesterSummary();
    // The three below only matter after a Systems Lexicon scrape actually
    // changed app.catalog's planet data - harmless (and cheap) to also run
    // them on every other refreshHooks.planets call (e.g. max-harvesters
    // changes in Settings), since they're all pure re-renders from current
    // state, not mutations.
    renderPlanetTable();
    refreshResourceSelectOptions();
    renderPlanetSyncStatus();
  };
}
