// Ore Database tab - pure filterable read-only table. Port of gui.py's
// _build_ore_tab/_refresh_ore_view. No state mutation.

import { el, clear } from "./dom-helpers.js";
import { TIER_ORDER } from "./ores-data.js";

export function initOreDatabaseTab(app, container) {
  let tierFilter = "All";
  let search = "";

  const tierSelect = el(
    "select",
    { onchange: (e) => { tierFilter = e.target.value; render(); } },
    ["All", ...TIER_ORDER].map((t) => el("option", { value: t, text: t }))
  );
  const searchInput = el("input", {
    type: "text",
    placeholder: "Search material...",
    oninput: (e) => { search = e.target.value; render(); },
  });

  const tbody = el("tbody");
  const table = el("table", { class: "data-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        "Raw Ore", "Tier", "Law", "Value (cr)", "Batch", "Refined Q", "Refined Outputs",
      ].map((h) => el("th", { text: h }))),
    ]),
    tbody,
  ]);

  function render() {
    clear(tbody);
    const needle = search.trim().toLowerCase();
    const ores = [...app.catalog.ores.values()]
      .filter((o) => tierFilter === "All" || o.tier === tierFilter)
      .filter((o) => {
        if (!needle) return true;
        if (o.name.toLowerCase().includes(needle)) return true;
        return o.outputs.some((m) => m.name.toLowerCase().includes(needle));
      })
      .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.value - b.value);

    for (const ore of ores) {
      tbody.appendChild(
        el("tr", {}, [
          el("td", { text: ore.name }),
          el("td", { text: ore.tier }),
          el("td", { text: String(ore.law) }),
          el("td", { text: String(ore.value) }),
          el("td", { text: String(ore.batch) }),
          el("td", { text: String(ore.refinedQ) }),
          el("td", { text: ore.outputs.map((m) => m.name).join(", ") }),
        ])
      );
    }
  }

  container.appendChild(
    el("div", {}, [
      el("div", { class: "toolbar" }, [
        el("label", { text: "Filter tier:" }), tierSelect,
        el("label", { text: "Search material:" }), searchInput,
      ]),
      el("div", { class: "scroll-table" }, [table]),
    ])
  );

  render();
}
