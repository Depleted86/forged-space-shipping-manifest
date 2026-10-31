// Corp tab - lets a player pick which build (from the same named builds
// used in Plan a Build) is the active CORP project, and shows that build's
// requirement totals - including Assembly-produced Commodities cascaded
// down into their own ore/material ingredients via expandCommodities(), so
// e.g. an order for Graviton Emitters also surfaces the specific ore needed
// to assemble them - against the corporation's shared Corp Store: need vs.
// have per item, plus how many farming trips (using this player's own cargo
// capacity) would close any shortfall.
//
// Deliberately a SEPARATE "active corp build" selection from Plan a Build's
// activeBuildName (see storage.js's loadActiveCorpBuildName()) - a corp
// project like an Outpost buildout is usually a different thing entirely
// from whatever a player is personally building, so the two shouldn't be
// forced to track each other. Both selections can point at the same build
// name if that's genuinely what's wanted, but nothing requires it.
//
// Trips are based on the SHORTFALL still to be farmed and contributed, not
// on stock already sitting in the Store - this tab is for coordinating
// contributions toward a shared target, not for tracking what could be
// withdrawn (see toStorableCorpData() in calc-engine.js).

import { el, clear } from "./dom-helpers.js";
import { entriesToTotals, expandCommodities, toStorableCorpData, toCorpCsv, parseCorpCsv } from "./calc-engine.js";
import * as storage from "./storage.js";

export function initCorpTab(app, container) {
  const buildSelectLabel = el("label", { for: "corp-build-select", text: "Active corp build:" });
  const buildSelect = el("select", { id: "corp-build-select", class: "list-select" });

  const summary = el("div", { class: "summary-text" });
  const table = el("table", { class: "data-table" });
  const tableWrap = el("div", { class: "scroll-table" }, [table]);

  // ---- Bulk "Create Corp Plan" grid ----
  // Typing entries one at a time into Plan a Build (blueprint-by-blueprint or
  // item-by-item) doesn't scale to a large corp order (dozens of items
  // spanning ore/refined/commodity/assembly/planet categories, matching the
  // kind of spreadsheet corps already track these against by hand) - this
  // is a flat checklist instead: every known item, grouped and alphabetized
  // by category, each with its own quantity box, so filling one out is just
  // scanning down the list rather than repeating an add-item workflow per
  // entry. Saving produces an ordinary build (same storage.builds entries
  // Plan a Build itself uses - kind "material" per entry, exactly what
  // addMaterialToPlan() already pushes there), so it's editable there too
  // afterward if needed. Need/build-name are ONLY ever changed here - three
  // ways in: "Create Corp Plan" ({}, "") starts completely empty, not pre-
  // filled with whatever the last plan happened to need; "Edit Current Corp
  // Plan" pre-fills from whatever build is currently the active corp build
  // instead; "Import CSV" pre-fills from a file. Have is a separate,
  // SHARED concern edited inline in the main comparison table instead (see
  // renderRows()) - not duplicated here.
  let corpPlanQtys = {}; // itemName -> qty (Need), scratch state until Save
  let corpPlanQtysSnapshot = {}; // corpPlanQtys as of the last openCorpPlanGrid(), for Cancel's dirty check
  const corpPlanSection = el("div", { class: "corp-plan-grid", style: "display:none" });
  const corpPlanNameInput = el("input", { id: "corp-plan-name", type: "text", placeholder: "Build name" });

  function itemCategories() {
    const assemblyNames = new Set(Object.keys(app.assemblyPlans));
    // "Commodities" = anything ever seen as a plain named item (personal or
    // corp inventory) that ISN'T one of the categories above - there's no
    // master list of every possible commodity anywhere in this extension,
    // only what's actually been observed via a live sync.
    const commodityNames = new Set([...Object.keys(app.inventory.other || {}), ...Object.keys(app.corpInventory || {})]);
    for (const n of assemblyNames) commodityNames.delete(n);
    // Both source dicts are flat, unfiltered name->qty maps - inventory.other
    // even picks up planet resources (applyItemsToInventory() only checks
    // ore/material at ingestion time, not findPlanetResource), and
    // corpInventory is built straight from every Corp Store row with no
    // filtering at all, since the Store legitimately stocks ore/materials
    // too, not just finished goods. So bucket membership alone can't be
    // trusted - anything the catalog actually recognizes as ore/material/
    // planet_resource has to be excluded here explicitly.
    for (const name of [...commodityNames]) {
      const [kind] = app.catalog.classify(name);
      if (kind !== "unknown") commodityNames.delete(name);
    }
    return [
      { label: "Ore", names: app.catalog.oreNames() },
      { label: "Refined Items", names: app.catalog.materialNames() },
      { label: "Commodities", names: [...commodityNames].sort() },
      { label: "Assembly", names: [...assemblyNames].sort() },
      { label: "Planet Items", names: app.catalog.planetResourceNames() },
    ];
  }

  // Builds one item's name+qty row, wired to commit into corpPlanQtys on
  // change - shared by both the auto-populated list and manually-added rows
  // (addColumnItem() below), so they behave identically either way.
  function buildQtyRow(name) {
    // aria-label (not a for/id <label> pair) - this grid can have 50+ of
    // these rows across its 5 categories, and per-row unique ids would only
    // add bookkeeping for no real benefit over naming the input directly.
    const qtyInput = el("input", { type: "text", "aria-label": `${name} quantity`, value: corpPlanQtys[name] ? String(corpPlanQtys[name]) : "" });
    qtyInput.addEventListener("change", () => {
      const raw = qtyInput.value.trim();
      const qty = parseFloat(raw);
      // Empty is a normal "not needed" state in a bulk grid like this one -
      // no warning for that. Only flag genuinely invalid non-empty text
      // (NaN, negative, zero) - a red outline rather than alert(), since
      // this grid can hold dozens of inputs side by side and interrupting
      // on every blur would make filling the rest of it painful.
      if (!raw) {
        delete corpPlanQtys[name];
        qtyInput.classList.remove("field-invalid");
      } else if (Number.isNaN(qty) || qty <= 0) {
        delete corpPlanQtys[name];
        qtyInput.classList.add("field-invalid");
      } else {
        corpPlanQtys[name] = qty;
        qtyInput.classList.remove("field-invalid");
      }
    });
    return el("div", { class: "field-row" }, [el("label", { text: name }), qtyInput]);
  }

  // initialQtys/initialName seed the grid's starting state - three ways in
  // all end up here: "Create Corp Plan" ({}, "") starts completely empty,
  // not pre-filled with whatever the last plan happened to need;
  // "Edit Current Corp Plan" passes the active corp build's own existing
  // quantities + name, so touching up an existing order doesn't mean
  // retyping everything from scratch; "Import CSV" passes whatever
  // parseCorpCsv() extracted from an imported spreadsheet instead.
  function renderCorpPlanGrid(initialQtys, initialName) {
    clear(corpPlanSection);
    corpPlanQtys = { ...(initialQtys || {}) };
    // Snapshot of the prefilled state, so Cancel can tell whether anything
    // was actually typed/changed since the grid opened and only confirm
    // when there's something real to lose (see cancelCorpPlanGrid()).
    corpPlanQtysSnapshot = { ...corpPlanQtys };
    corpPlanNameInput.value = initialName || "";

    const columns = itemCategories().map(({ label, names }) => {
      const rowsContainer = el("div", { class: "corp-plan-rows" });
      const seenNames = new Set();
      for (const name of [...names].sort()) {
        seenNames.add(name);
        rowsContainer.appendChild(buildQtyRow(name));
      }

      // Every category's list is only as complete as what this extension
      // already knows about (the catalog for Ore/Refined/Planet, whatever's
      // been imported for Assembly) or has actually observed via a live
      // sync (Commodities, which has no master list anywhere at all) - so
      // there's always a chance something's missing, Commodities most of
      // all. This lets a genuinely missing item be added straight into the
      // right column without leaving the grid or losing anything already
      // typed elsewhere (only this column's row list changes).
      const addNameInput = el("input", { type: "text", placeholder: `Add ${label.toLowerCase()} item…`, "aria-label": `New ${label} item name`, class: "corp-plan-add-name" });
      const addQtyInput = el("input", { type: "text", placeholder: "Qty", "aria-label": `New ${label} item quantity`, class: "corp-plan-add-qty" });
      function addColumnItem() {
        const name = addNameInput.value.trim();
        if (!name) {
          alert("Enter an item name.");
          return;
        }
        if (seenNames.has(name)) {
          alert(`"${name}" is already listed in ${label}.`);
          return;
        }
        const qty = parseFloat(addQtyInput.value);
        if (Number.isNaN(qty) || qty <= 0) {
          alert("Enter a positive quantity.");
          return;
        }
        seenNames.add(name);
        corpPlanQtys[name] = qty;
        rowsContainer.appendChild(buildQtyRow(name));
        addNameInput.value = "";
        addQtyInput.value = "";
        addNameInput.focus();
      }
      const addBtn = el("button", { text: "+", title: `Add a new ${label} item not already listed`, onclick: addColumnItem });
      addQtyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addColumnItem();
        }
      });
      const addRow = el("div", { class: "corp-plan-add-row" }, [addNameInput, addQtyInput, addBtn]);

      return el("div", { class: "corp-plan-category" }, [el("h4", { text: label }), addRow, rowsContainer]);
    });

    const saveBtn = el("button", { text: "Save as Corp Plan", onclick: saveCorpPlan });
    const cancelBtn = el("button", { text: "Cancel", onclick: cancelCorpPlanGrid });

    corpPlanSection.append(
      el("div", { class: "toolbar" }, [el("label", { for: "corp-plan-name", text: "Build name:" }), corpPlanNameInput, saveBtn, cancelBtn]),
      el("div", { class: "corp-plan-columns" }, columns)
    );
  }

  function closeCorpPlanGrid() {
    corpPlanSection.style.display = "none";
    clear(corpPlanSection);
  }

  // Cancel button only - distinct from closeCorpPlanGrid() itself, which
  // saveCorpPlan() also calls after a successful save and shouldn't ever
  // prompt (the data's already safely persisted by then). This grid can
  // hold dozens of typed quantities, so losing it to a stray click deserves
  // the same confirm-before-discard guard every other editor in the app has
  // (see tab-blueprints.js/tab-assembly.js's confirmDiscard()).
  function cancelCorpPlanGrid() {
    if (JSON.stringify(corpPlanQtys) !== JSON.stringify(corpPlanQtysSnapshot)) {
      if (!confirm("Discard this corp plan? Quantities you've typed will be lost.")) return;
    }
    closeCorpPlanGrid();
  }

  function openCorpPlanGrid(initialQtys, initialName) {
    renderCorpPlanGrid(initialQtys, initialName);
    corpPlanSection.style.display = "";
    corpPlanStatus.textContent = "";
  }

  function openCorpPlanGridForEdit() {
    if (!app.activeCorpBuildName) {
      alert("No active corp build selected yet - pick one above, or use Create Corp Plan to start a new one.");
      return;
    }
    const qtys = {};
    for (const [, name, qty] of app.builds[app.activeCorpBuildName] || []) qtys[name] = qty;
    openCorpPlanGrid(qtys, app.activeCorpBuildName);
  }

  async function saveCorpPlan() {
    const name = corpPlanNameInput.value.trim();
    if (!name) {
      alert("Enter a build name for this corp plan.");
      return;
    }
    const entries = Object.entries(corpPlanQtys).map(([itemName, qty]) => ["material", itemName, qty]);
    if (entries.length === 0) {
      alert("Enter at least one quantity.");
      return;
    }
    // This grid only ever loaded/prefilled from whatever build was ALREADY
    // the active corp build when it opened (see renderCorpPlanGrid()) - so
    // saving under any OTHER existing build name (e.g. a player's own Plan
    // a Build entry, very plausibly named "1" the same as the default
    // personal build) would otherwise silently overwrite unrelated data
    // with no way to recover it.
    if (app.builds[name] && name !== app.activeCorpBuildName) {
      if (!confirm(`A build named "${name}" already exists and will be overwritten with this corp plan. Continue?`)) return;
    }
    app.builds[name] = entries;
    await storage.saveBuilds(app.builds);
    app.activeCorpBuildName = name;
    await storage.saveActiveCorpBuildName(name);
    populateBuildOptions();
    await recalc();
    closeCorpPlanGrid();
    // Inline, non-blocking - the two alert()s above are genuine input
    // errors worth interrupting for; a routine successful save shouldn't
    // also force a click-to-dismiss dialog.
    corpPlanStatus.textContent = `Saved corp plan "${name}" (${entries.length} item(s)).`;
    corpPlanStatus.className = "status-text status-ok";
  }

  const createPlanBtn = el("button", { text: "Create Corp Plan", onclick: () => openCorpPlanGrid({}, "") });
  const editPlanBtn = el("button", { text: "Edit Current Corp Plan", onclick: openCorpPlanGridForEdit });
  const corpPlanStatus = el("div", { class: "status-text" });

  // ---- CSV export ----
  // A plain <a download> blob click - no "downloads" permission needed,
  // this is standard web-platform behavior available to any extension
  // page. For corp-mates who'd rather work the current need/have/shortfall
  // list in a real spreadsheet (sort, filter, cross things off) than
  // install the extension themselves - see toCorpCsv() in calc-engine.js
  // for the exact row shape.
  function exportCorpCsv() {
    if (!lastCorpData || !lastCorpData.available) {
      alert("Nothing to export yet - select a build above first.");
      return;
    }
    const csv = toCorpCsv(lastCorpData);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const safeName = (app.activeCorpBuildName || "corp-plan").replace(/[^a-z0-9_-]+/gi, "_");
    const a = el("a", { href: url, download: `${safeName}-${dateStamp}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  const exportCsvBtn = el("button", { text: "Export CSV", onclick: exportCorpCsv });

  // ---- CSV import ----
  // Reads a CSV (this tab's own export, or a corp-mate's edited copy of
  // one) back in via parseCorpCsv() and opens it in the same review-before-
  // save grid Create/Edit Corp Plan already use - never writes straight to
  // a build, so a bad or reordered file gets a chance to be checked/fixed
  // by hand before anything's actually saved. A hidden file input, clicked
  // via the visible button - the standard way to trigger a file picker from
  // an ordinary button rather than an unstyleable native <input type=file>.
  const importFileInput = el("input", { type: "file", accept: ".csv,text/csv", style: "display:none" });
  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files[0];
    importFileInput.value = ""; // reset so re-selecting the same file still fires "change"
    if (!file) return;
    const text = await file.text();
    // needs -> Need column (target quantities), haves -> Have column (a
    // corp-mate's reported stock) - see parseCorpCsv()'s own doc comment.
    // Either can be present without the other (a stock-only report file
    // might have no Need column filled in at all, and vice versa), so both
    // are checked before giving up on the file.
    const { needs, haves } = parseCorpCsv(text);
    if (Object.keys(needs).length === 0 && Object.keys(haves).length === 0) {
      alert('Couldn\'t find any usable rows - the file needs "Item" and "Need" and/or "Have" columns (e.g. one exported from this tab).');
      return;
    }

    // Have values apply immediately, merged straight into
    // app.corpHaveOverrides - no review step, since Have is edited the
    // same direct/immediate way in the main comparison table (see
    // buildHaveInput()) rather than through this review-before-save grid.
    let haveCount = 0;
    for (const [name, qty] of Object.entries(haves)) {
      if (app.corpHaveOverrides[name] !== qty) {
        app.corpHaveOverrides[name] = qty;
        haveCount++;
      }
    }
    if (haveCount > 0) {
      await storage.saveCorpHaveOverrides(app.corpHaveOverrides);
      await recalc();
    }

    if (Object.keys(needs).length > 0) {
      // Strip a trailing "-YYYY-MM-DD" date stamp this tab's own Export CSV
      // adds (see exportCorpCsv()) - re-importing a file exported earlier
      // shouldn't suggest saving it back under a name with a now-stale date
      // baked in, which would otherwise keep compounding on every export/
      // import round trip.
      const suggestedName = file.name.replace(/\.csv$/i, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
      openCorpPlanGrid(needs, suggestedName);
    } else if (haveCount > 0) {
      corpPlanStatus.textContent = `Imported ${haveCount} known-have report(s) from "${file.name}".`;
      corpPlanStatus.className = "status-text status-ok";
    }
  });
  const importCsvBtn = el("button", { text: "Import CSV", onclick: () => importFileInput.click() });

  function populateBuildOptions() {
    clear(buildSelect);
    buildSelect.appendChild(el("option", { value: "", text: "(none selected)" }));
    for (const name of Object.keys(app.builds).sort()) {
      buildSelect.appendChild(el("option", { value: name, text: app.buildLabels[name] || `Build ${name}` }));
    }
    buildSelect.value = app.activeCorpBuildName || "";
  }

  // Both buttons only ever clear the CORP-side tracking (activeCorpBuildName).
  // Neither one deletes the underlying build from app.builds unless nothing
  // else references it: a corp order and a personal Plan a Build entry can
  // point at the very same build name on purpose (see this file's header
  // comment), and this tab has no way to know whether Plan a Build is still
  // using it - silently deleting shared data out from under another tab
  // would be a real surprise. Only when this player's own activeBuildName
  // ISN'T the build being removed here is it actually safe to delete the
  // build entirely; otherwise it's left in place and just unlinked from the
  // Corp tab, exactly like picking "(none selected)" in the dropdown does.
  // Complete vs. Delete are functionally identical (neither touches
  // corpHaveOverrides - see storage.js's loadCorpHaveOverrides() for why
  // that's a standing fact, not order-specific tracking to reset) - kept as
  // two separate buttons anyway for the player's own mental model of
  // "finished" vs. "abandoned," not because the code path differs.
  async function finishCorpOrder(complete) {
    const name = app.activeCorpBuildName;
    if (!name) return;
    const sharedWithPersonalBuild = name === app.activeBuildName;
    const sharedWarning = sharedWithPersonalBuild
      ? ` This build is also your active Plan a Build selection - it'll be LEFT IN PLACE there instead of deleted, since removing it would take your personal plan down too.`
      : " This removes it from the builds list.";
    const question = complete ? `Mark corp order "${name}" complete?${sharedWarning}` : `Delete corp order "${name}"?${sharedWarning}`;
    if (!confirm(question)) return;

    if (!sharedWithPersonalBuild) {
      delete app.builds[name];
      await storage.saveBuilds(app.builds);
    }
    app.activeCorpBuildName = null;
    await storage.saveActiveCorpBuildName(null);
    populateBuildOptions();
    await recalc();
  }

  let lastCorpData = null; // most recent toStorableCorpData() result, kept for the Export CSV button

  // Suppressed while a Have input in the table below has focus, so a live
  // storage-driven recalc() (Corp Store syncs every ~2s while that screen
  // is open, see content.js) doesn't tear down and rebuild the table -
  // and the focused input along with it - out from under someone mid-edit.
  // Same class of bug this codebase has already hit and fixed for the
  // batch-count input in js/overlay-manifest.js and the harvester roster in
  // tab-planets.js. Data still updates and saves normally while suppressed
  // (see recalc()) - only the visual rebuild is deferred, until the
  // input's own blur handler re-renders with whatever's current by then.
  let suppressTableRender = false;

  // Which of the 5 category groups are currently collapsed in the table -
  // session-only UI state (not persisted to storage), reset on every page
  // load. A Set of category labels rather than a boolean per category so
  // "collapsed" is just membership - nothing to initialize for categories
  // that don't exist in the current build.
  const collapsedCorpCategories = new Set();

  const CATEGORY_LABELS = { ore: "Ore", assembly: "Assembly", planetary: "Planetary", commodity: "Commodity" };

  // Editable Have cell - pre-filled with the current computed have (live
  // Corp Store balance, or a standing override if one's already set - see
  // toStorableCorpData()'s `have` precedence in calc-engine.js), directly
  // overridable here and committed on blur/Enter.
  // Writes straight to app.corpHaveOverrides, the SAME shared/standing
  // report Export CSV reads from and Import CSV writes into - so typing a
  // correction here, saving, and exporting is exactly how a corp-mate with
  // better visibility (e.g. holding the "bank alt" a leader sweeps
  // deposits into) gets everyone else's shortfall to reflect reality.
  function buildHaveInput(row) {
    const startingValue = String(row.have);
    const input = el("input", {
      type: "text",
      class: "corp-have-input",
      "aria-label": `${row.name} have - editable`,
      title: `Known total ${row.name} - overrides the live Corp Store figure when changed, and is shared with anyone who imports your export`,
      value: startingValue,
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("focus", () => {
      suppressTableRender = true;
    });
    const commit = async () => {
      const raw = input.value.trim();
      if (raw === startingValue) {
        suppressTableRender = false;
        return; // untouched - no write, no re-render needed
      }
      const val = parseFloat(raw);
      if (raw === "" || Number.isNaN(val) || val < 0) {
        input.value = startingValue; // revert invalid input
        suppressTableRender = false;
        return;
      }
      app.corpHaveOverrides[row.name] = val;
      await storage.saveCorpHaveOverrides(app.corpHaveOverrides);
      suppressTableRender = false;
      await recalc(); // reflect the change (and anything else that happened while suppressed)
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur(); // triggers commit via the blur handler above
      }
    });
    return input;
  }

  function renderRows(data) {
    clear(table);
    const items = data.items || [];
    const refined = data.refined || [];
    if (!data.available || (items.length === 0 && refined.length === 0)) {
      summary.textContent = app.activeCorpBuildName
        ? "Corp Store already covers everything this build needs."
        : "Select a build above to compare its requirements against the Corp Store.";
      return;
    }

    // One flat list spanning every category - Ore/Assembly/Planetary/
    // Commodity come straight from `items`; Refined materials are
    // flattened out of their by-ore grouping into the SAME row shape
    // (their own `need` field is already the shortfall - see
    // toStorableCorpData() - so the true target is reconstructed as
    // need+have) rather than kept in a separate, differently-shaped
    // section. The ore/law/raw_needed breakdown that grouping carried is
    // still available via Export CSV's own by-category blocks; this table
    // stays a single uniform Item/Need/Have/Shortfall list so every item -
    // not just Commodities - gets the same editable Have field.
    const rows = items.map((item) => ({
      category: CATEGORY_LABELS[item.category] || "Commodity",
      name: item.name,
      need: item.need,
      have: item.have,
      shortfall: item.shortfall,
    }));
    for (const group of refined) {
      for (const m of group.materials) {
        rows.push({ category: "Refined", name: m.name, need: Math.round((m.need + m.have) * 10) / 10, have: m.have, shortfall: m.need });
      }
    }
    // No item-count/cargo-capacity summary line here anymore - the table
    // itself (grouped, collapsible, alphabetized) already shows everything
    // directly, so a separate "N item(s) tracked" figure was just noise on
    // top of it. `summary` is still used for the empty-state messages
    // above, so it's cleared here rather than removed outright.
    summary.textContent = "";

    // Grouped by category (fixed order) rather than one flat list, each
    // group a clickable header row that collapses/expands its items - and
    // alphabetized by name WITHIN each category, rather than by need, so a
    // specific item can actually be found by scanning rather than hunting
    // through a shortfall-sorted list. No separate "Category" column
    // anymore - the group header already says which category these rows
    // belong to, so repeating it on every single row would just be noise.
    const categoryOrder = ["Ore", "Refined", "Assembly", "Planetary", "Commodity"];
    const byCategory = new Map();
    for (const row of rows) {
      if (!byCategory.has(row.category)) byCategory.set(row.category, []);
      byCategory.get(row.category).push(row);
    }
    for (const list of byCategory.values()) list.sort((a, b) => a.name.localeCompare(b.name));

    // No "Trips to farm" column here - that figure only ever makes sense
    // for raw ore (something actually hauled in cargo-hold loads), but
    // this table mixes in every category, where a trip count is
    // meaningless at best and misleading at worst. The Manifest overlay
    // already gets this right (see js/overlay-manifest.js's renderCorpRow(),
    // which only shows trips when item.kind === "ore") - this table just
    // drops the column outright rather than needing the same per-row
    // conditional.
    const thead = el("thead", {}, [el("tr", {}, [el("th", { text: "Item" }), el("th", { text: "Need" }), el("th", { text: "Have" }), el("th", { text: "Shortfall" })])]);
    const tbody = el("tbody");
    for (const category of categoryOrder) {
      const catRows = byCategory.get(category);
      if (!catRows || catRows.length === 0) continue;
      const collapsed = collapsedCorpCategories.has(category);
      const toggleGroup = () => {
        if (collapsedCorpCategories.has(category)) collapsedCorpCategories.delete(category);
        else collapsedCorpCategories.add(category);
        renderRows(data); // cheap re-render of already-computed data, no recalc() needed
      };
      const headerRow = el(
        "tr",
        { class: "corp-category-header", tabindex: "0", role: "button", "aria-expanded": String(!collapsed), "aria-label": `${collapsed ? "Expand" : "Collapse"} ${category} (${catRows.length} item(s))` },
        [el("td", { colspan: "4" }, [`${collapsed ? "▸" : "▾"} ${category} (${catRows.length})`])]
      );
      headerRow.addEventListener("click", toggleGroup);
      headerRow.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggleGroup();
      });
      tbody.appendChild(headerRow);
      if (collapsed) continue;
      for (const row of catRows) {
        const short = row.shortfall > 0;
        tbody.appendChild(
          el("tr", {}, [
            el("td", { text: row.name }),
            el("td", { text: row.need.toLocaleString() }),
            el("td", { class: short ? "status-warn" : "status-ok" }, [buildHaveInput(row)]),
            el("td", { text: short ? row.shortfall.toLocaleString() : "0" }),
          ])
        );
      }
    }
    table.append(thead, tbody);
  }

  async function recalc() {
    const name = app.activeCorpBuildName;
    const entries = name ? app.builds[name] : null;
    if (!entries || entries.length === 0) {
      const empty = { available: false, cargo_capacity: 0, items: [], refined: [] };
      lastCorpData = empty;
      await storage.saveCorpToMineData(empty);
      if (!suppressTableRender) renderRows(empty);
      return;
    }
    const totals = entriesToTotals(app.blueprints, entries);
    // Cascade Assembly-produced Commodities down into their own ore/material
    // ingredient totals, so a corp order for a finished commodity also
    // surfaces the specific ore needed to assemble it, not just the
    // commodity's own name. Deliberately always cascades, unlike the
    // personal Plan a Build pipeline (see background.js's
    // recalculateActiveBuildCorpData()) - per-item Buy/Mine is a personal
    // acquisition preference (settings.item_acquisition_mode), and doesn't
    // change what the corp target itself is actually made of.
    const { expanded } = expandCommodities(app.catalog, totals, app.assemblyPlans, { other: app.corpInventory || {} });
    const cargoCapacity = Number(app.settings.cargo_capacity || 600);
    // Same per-player ore_choices setting Personal mining uses, so "which
    // ore sources this material" reflects this player's own configured
    // preference even for a shared corp target.
    const oreChoices = {};
    for (const [item, oreName] of Object.entries(app.settings.ore_choices || {})) {
      const ore = app.catalog.findOre(oreName);
      if (ore) oreChoices[item] = ore;
    }
    const data = toStorableCorpData(app.catalog, app.assemblyPlans, oreChoices, expanded, app.corpInventory || {}, cargoCapacity, app.corpHaveOverrides || {});
    lastCorpData = data;
    await storage.saveCorpToMineData(data);
    if (!suppressTableRender) renderRows(data);
  }

  buildSelect.addEventListener("change", async () => {
    app.activeCorpBuildName = buildSelect.value || null;
    await storage.saveActiveCorpBuildName(app.activeCorpBuildName);
    await recalc();
  });

  // Re-populate the build list (a build may have been renamed/added/removed
  // on the Plan a Build tab) and recompute whenever something relevant
  // changes - registered under its own id so dashboard.js's storage.onChanged
  // listener can call it without pulling this tab into the personal-
  // inventory refresh cascade (refreshAfterInventoryUpdate), which this data
  // has nothing to do with.
  app.refreshHooks.corp = async () => {
    populateBuildOptions();
    await recalc();
  };

  const markCompleteBtn = el("button", { class: "corp-order-btn", text: "Mark Corp Order Complete", onclick: () => finishCorpOrder(true) });
  const deleteOrderBtn = el("button", { class: "danger corp-order-btn", text: "Delete Corp Order", onclick: () => finishCorpOrder(false) });

  populateBuildOptions();
  recalc();

  container.append(
    el("div", { class: "field-row" }, [buildSelectLabel, buildSelect, markCompleteBtn, deleteOrderBtn]),
    el("div", { class: "toolbar" }, [createPlanBtn, editPlanBtn, exportCsvBtn, importCsvBtn, importFileInput]),
    corpPlanStatus,
    corpPlanSection,
    summary,
    tableWrap
  );
}
