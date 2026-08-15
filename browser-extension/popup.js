// Content for the floating "Manifest" window (opened by background.js's
// action.onClicked as a type:"popup" browser window, not an action
// dropdown - see background.js for why). Shows the last computed plan
// without touching the game page's DOM at all - replaces the older
// approach of injecting a panel directly into forgedspace.com's UI (see
// content.js's header comment for why that was reverted).
//
// The "Dashboard" button switches THIS SAME window to the full dashboard
// (dashboard.html has its own "← Manifest" button to switch back) rather
// than opening a separate tab, per the user's ask for a single window that
// toggles between the compact list and the full planner. Since the
// dashboard needs real width for its result tables (unlike this window,
// which is deliberately kept small - see resizeToFit()), the window is
// resized up before navigating away.

import "./js/browser-compat.js";

const listEl = document.getElementById("ore-list");
const personalBtn = document.getElementById("view-personal");
const corpBtn = document.getElementById("view-corp");

let currentView = "personal"; // "personal" | "corp"
let personalData = { available: false };
let corpData = { available: false, items: [] };
// render() fully rebuilds the row list (listEl.innerHTML = "") on every
// storage change - live inventory syncs fire every ~2s while the game's
// storage screen is open, which would otherwise destroy a batch-count
// <input> (see renderPersonalRow()) out from under the player mid-typing,
// the same class of bug tab-planets.js's harvester roster hit and was fixed
// for earlier in this project. Suppressed here instead while that input has
// focus; storage.onChanged still updates the underlying data so the next
// render() (triggered on blur) reflects whatever changed while suppressed.
let suppressRenderWhileEditing = false;

// Content-size bounds (viewport px, not window/outer px - see resizeToFit).
// Rows never wrap (.ore-row is white-space: nowrap in popup.css), so
// listEl.scrollWidth reflects the widest row's true intrinsic width even
// though it's visually clipped with ellipsis past MAX_CONTENT_WIDTH -
// scrollWidth measures unclipped content regardless of overflow/ellipsis
// styling. MIN_CONTENT_WIDTH exists mainly for the empty-plan state, where
// the header's own title+button need more room than a short message would.
// MAX_CONTENT_WIDTH gives a bit of headroom for the Mining view's batch
// input/remaining controls and longer item names generally.
const MIN_CONTENT_WIDTH = 260;
const MAX_CONTENT_WIDTH = 600;
const MIN_CONTENT_HEIGHT = 90;
const MAX_CONTENT_HEIGHT = 640;
const DASHBOARD_WIDTH = 1000;
const DASHBOARD_HEIGHT = 700;

function emptyMessage() {
  if (currentView === "corp") {
    if (!corpData.available) {
      return "No corp build selected - pick one on the dashboard's Corp tab";
    }
    return "Corp Store already covers everything needed";
  }
  if (!personalData.available) {
    return "No plan calculated yet - open the dashboard's Plan a Build tab";
  }
  return "Nothing left to mine";
}

function setPendingBatches(oreName, batches) {
  browser.runtime.sendMessage({ type: "fsc-set-pending-batches", oreName, batches }).catch(() => {});
}

// Mining/ores is the TOTAL raw ore still needed (direct use + refining
// combined - see toStorableToMineData() in calc-engine.js). Batch tracking
// lives on the Refined section's group headers below instead (that's
// specifically about refining runs), but the refining share of THIS row's
// total is still called out inline - "(refined: N)" - right on the row
// itself, so the connection to the Refined section is obvious at a glance
// without having to cross-reference between the two.
function renderPersonalRow(ore) {
  const row = document.createElement("div");
  row.className = "ore-row";
  const tripLabel = ore.trips === 1 ? "trip" : "trips";
  const refinedText = ore.refined_portion > 0 ? ` (refined: ${Math.round(ore.refined_portion).toLocaleString()})` : "";
  row.textContent = `${ore.name}: ${Math.round(ore.to_mine).toLocaleString()}${refinedText} (${ore.trips} ${tripLabel})`;
  // Law only goes in the tooltip, not the always-visible row text - it's
  // useful context on hover without adding length to every row.
  row.title = `${row.textContent} — Law ${ore.law}`;
  return row;
}

// "[typed X] / remaining" batch-tracking control, shared between whatever
// row/header needs it. X is an editable count of batches currently started
// (typed in directly, not incremented - matches the real workflow: type the
// count when a run starts, reset to 0 once you've collected the output and
// are between runs). "remaining" is a plain static number, not editable -
// how many MORE batches are still needed beyond whatever's typed into X.
function buildBatchControls(name, pendingBatches, remainingBatches) {
  const controls = document.createElement("span");
  controls.className = "batch-controls";

  const batchLabel = document.createElement("span");
  batchLabel.className = "batch-label";
  batchLabel.textContent = "Batch:";

  const batchInput = document.createElement("input");
  batchInput.type = "text";
  batchInput.className = "batch-input";
  // title alone isn't a reliable accessible name across screen readers -
  // this is the only interactive control in the compact popup besides the
  // two view-toggle buttons (which already have aria-pressed), so it
  // shouldn't be the one thing here with no accessible name at all.
  batchInput.setAttribute("aria-label", `Batches of ${name} currently started refining`);
  batchInput.value = String(pendingBatches);
  // Sized to whichever is wider - "remaining"'s digit count (the practical
  // upper bound on what you'd normally type) or the current value's own
  // digit count (in case it's already bigger, e.g. right after remaining
  // drops post-sync) - floored at 2 so a single-digit row still has enough
  // room to comfortably see/edit a 2-digit value while typing, not just
  // whatever's already there.
  const digits = Math.max(2, String(remainingBatches).length, String(pendingBatches).length);
  // +6px compensates for the input's own padding+border (2px+2px+1px+1px,
  // see .batch-input in popup.css) - with box-sizing:border-box, those eat
  // into a plain "Nch" width, leaving less than N full characters of actual
  // visible text room (e.g. a 3-digit batch count wouldn't actually show
  // all 3 digits without this).
  batchInput.style.width = `calc(${digits}ch + 6px)`;
  batchInput.title = `Batches of ${name} currently started refining (not yet collected) - type a number and press Enter/click away to save`;
  const commit = () => {
    const batches = parseInt(batchInput.value, 10);
    if (Number.isNaN(batches) || batches < 0) {
      batchInput.value = String(pendingBatches); // revert invalid input
      return;
    }
    setPendingBatches(name, batches);
  };
  batchInput.addEventListener("click", (e) => e.stopPropagation());
  batchInput.addEventListener("focus", () => { suppressRenderWhileEditing = true; });
  batchInput.addEventListener("blur", () => {
    suppressRenderWhileEditing = false;
    commit();
    render(); // reflect anything that changed elsewhere while suppressed
  });
  batchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      batchInput.blur(); // triggers commit via the blur handler above
    }
  });

  const remainingLabel = document.createElement("span");
  remainingLabel.className = "batch-remaining";
  remainingLabel.textContent = `/ ${remainingBatches}`;
  // "remaining" counts only what's actually been collected and synced into
  // inventory - NOT reduced by batches merely typed in as started/pending
  // (see toStorableToMineData()'s Refined section in calc-engine.js). It
  // won't drop just because you typed a bigger batch-input number; it only
  // moves once the refined material itself actually shows up in inventory.
  remainingLabel.title = `${remainingBatches} total batch(es) of ${name} still needed, counting only what's actually been collected - starting more batches (left number) doesn't reduce this until they're actually collected`;

  controls.append(batchLabel, batchInput, remainingLabel);
  return controls;
}

// Ores grouped under a sub-label per Law level - e.g. "Law 15" grouping
// Thracium, Feltonite, Kelsalt together - rather than a flat list. Ascending
// numeric order (lowest Law first), same reasoning as renderPlanetaryGroups.
function renderMiningGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `Law ${item.law}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => parseFloat(a.slice(4)) - parseFloat(b.slice(4)));
  for (const key of sortedKeys) {
    listEl.appendChild(sectionLabel(key, true));
    groups.get(key).forEach((item) => listEl.appendChild(renderPersonalRow(item)));
  }
}

// Refined materials, grouped by which ore sources them (multiple materials
// can share one ore - refining it yields all 3 outputs at once, see
// toStorableToMineData()/toStorableCorpData() in calc-engine.js) - shared
// between Personal Farm and Corp, since both produce the identical
// {ore, law, raw_needed, materials: [{name, need, have}]} group shape
// (Personal groups also carry pending_batches/remaining_batches - Corp
// groups don't, since batch tracking is a personal-only mechanic). Mining
// itself is untouched; this is purely additive context on top of it.
function renderRefinedRow(item) {
  const row = document.createElement("div");
  row.className = "ore-row";
  row.textContent = `${item.name}: ${Math.round(item.have).toLocaleString()} / ${Math.round(item.need).toLocaleString()}`;
  row.title = `${item.name}: have ${item.have} / need ${item.need}`;
  return row;
}

function renderRefinedGroups(groups) {
  for (const group of groups) {
    // Only Personal groups carry batch-tracking fields (Corp never has
    // them - see toStorableCorpData() in calc-engine.js) - reused here to
    // also pick the right wording: Personal's Mining rows already show this
    // same raw ore inline ("(refined: N)" - see renderPersonalRow()), so
    // the group header here just names the ore/Law without repeating the
    // figure. Corp's "Ore" section was never combined with refining need in
    // the first place, so its raw_needed isn't shown anywhere else - that
    // one stays.
    const isPersonal = group.pending_batches !== undefined;
    const lawText = group.law != null ? ` (Law ${group.law})` : "";
    const rawText = Math.round(group.raw_needed).toLocaleString();
    const labelText = isPersonal ? `${group.ore}${lawText}` : `${group.ore}${lawText} — ${rawText} raw needed`;
    const header = document.createElement("div");
    header.className = "section-label sub-label";
    if (isPersonal) {
      header.classList.add("sub-label-with-controls");
      const label = document.createElement("span");
      label.textContent = labelText;
      header.append(label, buildBatchControls(group.ore, group.pending_batches, group.remaining_batches));
    } else {
      header.textContent = labelText;
    }
    listEl.appendChild(header);
    group.materials.forEach((item) => listEl.appendChild(renderRefinedRow(item)));
  }
}

function renderAssemblyRow(item) {
  const row = document.createElement("div");
  row.className = "ore-row assembly-row";
  // No "at Assembly" suffix - the section label above these rows already
  // says "Assembly", so repeating it on every row is just noise.
  const hoursText = item.hours != null ? `${item.hours}h` : "rate unknown";
  row.textContent = `${item.name}: ${Math.round(item.need).toLocaleString()} (${hoursText})`;
  row.title = row.textContent;
  return row;
}

function renderPlanetaryRow(item) {
  const row = document.createElement("div");
  row.className = "ore-row planetary-row";
  // "idle" matches the Planets tab's own term for an unassigned harvester
  // slot (see tab-planets.js's "(idle)" option), rather than a separate
  // phrase for the same thing. No planet-name suffix here - the group's
  // sub-label above already says which planet type(s), see
  // renderPlanetaryGroups().
  const hoursText = item.hours != null ? `${item.hours}h` : "idle";
  row.textContent = `${item.name}: ${Math.round(item.need).toLocaleString()} (${hoursText})`;
  row.title = row.textContent;
  return row;
}

// Planet resources grouped under a sub-label per planet type (or combined
// type set, for a resource offered by more than one) - e.g. "Ice World"
// grouping White Iron and Glacite Ore together - rather than repeating the
// planet name on every single row.
function renderPlanetaryGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.planets && item.planets.length ? [...item.planets].sort().join(" / ") : "Unknown source";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const key of [...groups.keys()].sort()) {
    listEl.appendChild(sectionLabel(key, true));
    groups.get(key).forEach((item) => listEl.appendChild(renderPlanetaryRow(item)));
  }
}

function sectionLabel(text, sub = false) {
  const el = document.createElement("div");
  el.className = sub ? "section-label sub-label" : "section-label";
  el.textContent = text;
  return el;
}

// Same grouping treatment as renderMiningGroups() for the personal view -
// Corp items classified "ore" grouped under a "Law N" sub-label.
function renderCorpOreGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.law != null ? `Law ${item.law}` : "Unknown Law";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const numA = parseFloat(a.slice(4));
    const numB = parseFloat(b.slice(4));
    if (Number.isNaN(numA) || Number.isNaN(numB)) return a.localeCompare(b);
    return numA - numB;
  });
  for (const key of sortedKeys) {
    listEl.appendChild(sectionLabel(key, true));
    groups.get(key).forEach((item) => listEl.appendChild(renderCorpRow(item)));
  }
}

// Same grouping treatment as renderPlanetaryGroups() for the personal view.
function renderCorpPlanetaryGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.planets && item.planets.length ? [...item.planets].sort().join(" / ") : "Unknown source";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const key of [...groups.keys()].sort()) {
    listEl.appendChild(sectionLabel(key, true));
    groups.get(key).forEach((item) => listEl.appendChild(renderCorpRow(item)));
  }
}

function renderCorpRow(item) {
  // Fully-covered items never reach here at all (toStorableCorpData()
  // drops shortfall<=0 entirely, same as personal's oreToMine), so every
  // row shown is by definition something still to gather - "need"/"have"
  // aren't actionable for the actual workflow (gather the shortfall,
  // deposit it to the corp), only the shortfall matters, plus a trip count
  // for RAW ORE specifically (item.kind === "ore") - that's the only thing
  // actually hauled in cargo-hold trips. Refined material (even though it's
  // grouped into the same "Mining" section, by Law), Assembly output, and
  // Planetary resources are all contributed if/when you happen to have
  // them from your own refining/producing/harvesting, not farmed in a
  // deliberate trip count, so "trips" isn't shown for those.
  const row = document.createElement("div");
  row.className = "ore-row";
  const shortfallText = Math.round(item.shortfall).toLocaleString();
  if (item.kind === "ore") {
    const tripLabel = item.trips === 1 ? "trip" : "trips";
    row.textContent = `${item.name}: ${shortfallText} (${item.trips} ${tripLabel})`;
  } else {
    row.textContent = `${item.name}: ${shortfallText}`;
  }
  row.title = row.textContent;
  return row;
}

// Flat "buy N of this" list - Commodity/Assembly items the player chose
// "Buy" for individually in the dashboard's Item sources list (see
// storage.js's DEFAULT_SETTINGS.item_acquisition_mode), plus any Commodity
// with no known Assembly recipe at all - both cases skip expandCommodities()'
// cascade (see calc-engine.js's toStorableToMineData()), so there's no ore/
// hours breakdown to show, just the flat quantity still needed beyond
// what's already in inventory.
function renderBuyRow(item) {
  const row = document.createElement("div");
  row.className = "ore-row";
  row.textContent = `${item.name}: ${Math.round(item.need).toLocaleString()}`;
  row.title = row.textContent;
  return row;
}

function appendEmpty() {
  const empty = document.createElement("div");
  empty.className = "empty-message";
  empty.textContent = emptyMessage();
  listEl.appendChild(empty);
}

// Shared by both views - top-level section labels only when more than one
// kind is present (no point labeling a list that's entirely one thing).
// Sub-labels within a section (Law level / planet type, see
// renderMiningGroups()/renderPlanetaryGroups() and their Corp counterparts)
// always show regardless, since those distinguish groups even within a
// single top-level section.
function renderSections(sections) {
  const nonEmpty = sections.filter((s) => s.items.length > 0);
  if (nonEmpty.length === 0) {
    appendEmpty();
    return;
  }
  const showLabels = nonEmpty.length > 1;
  for (const section of nonEmpty) {
    if (showLabels) listEl.appendChild(sectionLabel(section.label));
    section.render(section.items);
  }
}

function render() {
  listEl.innerHTML = "";
  listEl.style.maxHeight = "none"; // let content size naturally before measuring
  personalBtn.setAttribute("aria-pressed", String(currentView === "personal"));
  corpBtn.setAttribute("aria-pressed", String(currentView === "corp"));

  if (currentView === "corp") {
    // 5 top-level categories - Ore, Refined, Assembly, Planetary,
    // Commodities - same split as the Corp tab's "Create Corp Plan" grid,
    // see toStorableCorpData()'s category classification in calc-engine.js.
    // Refined comes from its own corpData.refined (ore-grouped), not
    // corpData.items - materials are pulled out of the flat items list
    // there, same reasoning as Personal's ores/refined/assembly/planetary
    // already being separate arrays instead of one flat list.
    const byCategory = { ore: [], assembly: [], planetary: [], commodity: [] };
    for (const item of corpData.items || []) {
      (byCategory[item.category] || byCategory.commodity).push(item);
    }
    const flatRender = (items) => items.forEach((item) => listEl.appendChild(renderCorpRow(item)));
    renderSections([
      { label: "Ore", items: byCategory.ore, render: renderCorpOreGroups },
      { label: "Refined", items: corpData.refined || [], render: renderRefinedGroups },
      { label: "Assembly", items: byCategory.assembly, render: flatRender },
      { label: "Planetary", items: byCategory.planetary, render: renderCorpPlanetaryGroups },
      { label: "Commodities", items: byCategory.commodity, render: flatRender },
    ]);
  } else {
    // Mining is the TOTAL raw ore still needed (direct use + refining
    // combined - see toStorableToMineData() in calc-engine.js for why
    // splitting it would be actively misleading: stored raw ore is one
    // shared pool, not reserved per purpose). Refined's raw_needed is a
    // BREAKDOWN of how much of that same Mining total is attributable to
    // refining, not an additional amount - renderRefinedGroups()'s wording
    // says so explicitly, so the same ore appearing in both sections doesn't
    // read as a duplicate or something to add together.
    renderSections([
      { label: "Mining", items: personalData.ores || [], render: renderMiningGroups },
      { label: "Refined", items: personalData.refined || [], render: renderRefinedGroups },
      { label: "Assembly", items: personalData.assembly || [], render: (items) => items.forEach((item) => listEl.appendChild(renderAssemblyRow(item))) },
      { label: "Planetary", items: personalData.planetary || [], render: renderPlanetaryGroups },
      { label: "Buy", items: personalData.buy || [], render: (items) => items.forEach((item) => listEl.appendChild(renderBuyRow(item))) },
    ]);
  }
  requestAnimationFrame(resizeToFit);
}

// Guards against overlapping resizeToFit() calls - toMineData and
// corpToMineData update in separate storage writes just milliseconds apart
// (background.js's handleStorageScrape() recalculates both, sequentially,
// on every ~2s sync poll - see content.js), each triggering its own
// render()->resizeToFit(). Two concurrent async windows.update() calls have
// no ordering guarantee, so without this, the window's final size would
// depend on whichever call's promise happened to resolve last rather than
// the most recently measured content - a visible double-resize flicker in
// the worst case. Calls that arrive while one is already in flight just
// mark a pending flag instead of firing their own overlapping update; the
// in-flight call re-runs once more (against then-current DOM state) right
// before it finishes, so nothing already requested gets silently dropped.
let resizeInFlight = false;
let resizePending = false;

async function resizeToFit() {
  if (resizeInFlight) {
    resizePending = true;
    return;
  }
  resizeInFlight = true;
  try {
    await performResize();
  } finally {
    resizeInFlight = false;
    if (resizePending) {
      resizePending = false;
      resizeToFit();
    }
  }
}

// Shrinks/grows the actual OS window to fit the rendered content - width to
// the widest row, height to however many rows are showing - clamped so a
// huge plan doesn't produce a window bigger than the screen. Re-runs on
// every render(), so the window continuously tracks the current plan.
async function performResize() {
  // scrollWidth alone can only detect "needs MORE than the current window
  // width" (via overflow) - a block-level body always stretches to fill
  // whatever width it's already given, so it can never reveal "needs LESS."
  // Without this, the window would grow for a long plan but then never
  // shrink back down for a shorter one. Forcing shrink-to-fit sizing during
  // the measurement (reverted immediately after, before the next paint)
  // gives the true intrinsic content width in both directions.
  const previousBodyWidth = document.body.style.width;
  document.body.style.width = "max-content";
  const contentWidth = Math.min(MAX_CONTENT_WIDTH, Math.max(MIN_CONTENT_WIDTH, document.body.scrollWidth));
  document.body.style.width = previousBodyWidth;

  const naturalHeight = document.body.scrollHeight;
  const contentHeight = Math.min(MAX_CONTENT_HEIGHT, Math.max(MIN_CONTENT_HEIGHT, naturalHeight));

  // Only the list scrolls internally when clamped - the header and the view
  // toggle row both stay fixed.
  if (naturalHeight > MAX_CONTENT_HEIGHT) {
    const headerHeight = document.querySelector(".popup-header").getBoundingClientRect().height;
    const toggleHeight = document.querySelector(".view-toggle").getBoundingClientRect().height;
    listEl.style.maxHeight = `${Math.max(0, contentHeight - headerHeight - toggleHeight)}px`;
  }

  // windows.update() sets the OUTER window size (including title bar/
  // borders), but scrollWidth/scrollHeight measure the inner viewport - add
  // back the chrome delta so the content itself ends up exactly the size
  // just measured, not the window frame.
  const chromeWidth = window.outerWidth - window.innerWidth;
  const chromeHeight = window.outerHeight - window.innerHeight;

  const win = await browser.windows.getCurrent();
  await browser.windows.update(win.id, {
    width: Math.round(contentWidth + chromeWidth),
    height: Math.round(contentHeight + chromeHeight),
  });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let changed = false;
  if (changes.toMineData) {
    personalData = changes.toMineData.newValue || { available: false };
    changed = true;
  }
  if (changes.corpToMineData) {
    corpData = changes.corpToMineData.newValue || { available: false, items: [] };
    changed = true;
  }
  // Data is always kept current even while suppressed - only the visual
  // rebuild is deferred, until the focused batch input's blur handler calls
  // render() itself (see suppressRenderWhileEditing's declaration above).
  if (changed && !suppressRenderWhileEditing) render();
});

browser.storage.local.get(["toMineData", "corpToMineData"]).then((result) => {
  personalData = result.toMineData || { available: false };
  corpData = result.corpToMineData || { available: false, items: [] };
  render();
});

personalBtn.addEventListener("click", () => {
  currentView = "personal";
  render();
});

corpBtn.addEventListener("click", () => {
  currentView = "corp";
  render();
});

document.getElementById("switch-to-dashboard").addEventListener("click", async () => {
  // windows.update() only resizes - it doesn't reposition. If this compact
  // window is sitting near a screen edge (e.g. parked on the right while
  // mining), growing it from the top-left corner without also moving it
  // pushes the far edge off-screen, since left/top stay fixed.
  //
  // Two earlier attempts to fix this by computing exact screen/monitor
  // bounds both failed in practice on a two-monitor setup: window.screen's
  // availLeft/availTop didn't reliably reflect the correct monitor, and
  // browser.system.display (which needs its own manifest permission) isn't
  // actually implemented in Firefox at all - calling it threw, and with no
  // error handling that silently killed the whole click handler before it
  // ever navigated ("the button does nothing"). Rather than lean on a THIRD
  // possibly-unreliable API, this just grows the window symmetrically
  // around its OWN current center point - using only browser.windows data,
  // no screen/display API or extra permission needed at all. It won't
  // perfectly guarantee on-screen placement in every case, but it's a much
  // smaller, safer expansion than anchoring at the top-left corner, and it
  // can't fail the way the display-lookup approaches did.
  //
  // Wrapped in try/catch so that if resizing/repositioning fails for any
  // reason, navigation to the dashboard still happens regardless - a
  // cosmetic positioning miss should never block the actual button action.
  try {
    const win = await browser.windows.getCurrent();
    const centerX = win.left + win.width / 2;
    const centerY = win.top + win.height / 2;
    const left = Math.round(centerX - DASHBOARD_WIDTH / 2);
    const top = Math.round(centerY - DASHBOARD_HEIGHT / 2);
    await browser.windows.update(win.id, { width: DASHBOARD_WIDTH, height: DASHBOARD_HEIGHT, left, top });
  } catch (err) {
    console.warn("Couldn't resize/reposition before switching to dashboard:", err);
  }
  window.location.href = "dashboard.html";
});
