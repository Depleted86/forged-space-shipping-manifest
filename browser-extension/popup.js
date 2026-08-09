// Content for the floating "To Mine" window (opened by background.js's
// action.onClicked as a type:"popup" browser window, not an action
// dropdown - see background.js for why). Shows the last computed "To Mine"
// plan without touching the game page's DOM at all - replaces the older
// approach of injecting a panel directly into forgedspace.com's UI (see
// content.js's header comment for why that was reverted).
//
// The "Dashboard" button switches THIS SAME window to the full dashboard
// (dashboard.html has its own "← To Mine" button to switch back) rather
// than opening a separate tab, per the user's ask for a single window that
// toggles between the compact list and the full planner. Since the
// dashboard needs real width for its result tables (unlike this window,
// which is deliberately kept small - see resizeToFit()), the window is
// resized up before navigating away.

import "./js/browser-compat.js";

const listEl = document.getElementById("ore-list");
let currentData = { available: false };

// Content-size bounds (viewport px, not window/outer px - see resizeToFit).
// Rows never wrap (.ore-row is white-space: nowrap in popup.css), so
// listEl.scrollWidth reflects the widest row's true intrinsic width even
// though it's visually clipped with ellipsis past MAX_CONTENT_WIDTH -
// scrollWidth measures unclipped content regardless of overflow/ellipsis
// styling. MIN_CONTENT_WIDTH exists mainly for the empty-plan state, where
// the header's own title+button need more room than a short message would.
const MIN_CONTENT_WIDTH = 260;
const MAX_CONTENT_WIDTH = 480;
const MIN_CONTENT_HEIGHT = 90;
const MAX_CONTENT_HEIGHT = 640;
const DASHBOARD_WIDTH = 1000;
const DASHBOARD_HEIGHT = 700;

function emptyMessage() {
  if (!currentData.available) {
    return "No plan calculated yet - open the dashboard's Plan a Build tab";
  }
  return "Nothing left to mine";
}

function render() {
  listEl.innerHTML = "";
  listEl.style.maxHeight = "none"; // let content size naturally before measuring
  const ores = (currentData && currentData.ores) || [];
  if (ores.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-message";
    empty.textContent = emptyMessage();
    listEl.appendChild(empty);
  } else {
    ores.forEach((ore) => {
      const row = document.createElement("div");
      row.className = "ore-row";
      const tripLabel = ore.trips === 1 ? "trip" : "trips";
      row.textContent = `${ore.name} — ${Math.round(ore.to_mine).toLocaleString()} (${ore.trips} ${tripLabel})`;
      row.title = row.textContent;
      listEl.appendChild(row);
    });
  }
  requestAnimationFrame(resizeToFit);
}

// Shrinks/grows the actual OS window to fit the rendered content - width to
// the widest row, height to however many rows are showing - clamped so a
// huge plan doesn't produce a window bigger than the screen. Re-runs on
// every render(), so the window continuously tracks the current plan.
async function resizeToFit() {
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

  // Only the list scrolls internally when clamped - the header stays fixed.
  if (naturalHeight > MAX_CONTENT_HEIGHT) {
    const headerHeight = document.querySelector(".popup-header").getBoundingClientRect().height;
    listEl.style.maxHeight = `${Math.max(0, contentHeight - headerHeight)}px`;
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
  if (area !== "local" || !changes.toMineData) return;
  currentData = changes.toMineData.newValue || { available: false };
  render();
});

browser.storage.local.get("toMineData").then((result) => {
  currentData = result.toMineData || { available: false };
  render();
});

document.getElementById("switch-to-dashboard").addEventListener("click", async () => {
  const win = await browser.windows.getCurrent();
  await browser.windows.update(win.id, { width: DASHBOARD_WIDTH, height: DASHBOARD_HEIGHT });
  window.location.href = "dashboard.html";
});
