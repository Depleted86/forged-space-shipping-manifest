// In-game "Manifest Setup" window: the same setup checklist as the
// dashboard's "Getting started" (steps from setup-steps.js), shown on the
// game page itself, since that's where most steps are done. Each step ticks
// off as the extension reads that screen, so a new player can work down the
// list without leaving the game; steps done on the dashboard have an Open
// button that opens it on the right tab.
//
// Its own Shadow DOM host, like the Manifest overlay, so the game's CSS
// can't touch it and it never touches the game's page. Starts at the left
// edge (the Manifest overlay opens on the right), moves by dragging its
// title bar, and remembers where it was left and whether it was minimised.
// Shown while setup isn't finished or skipped; the dashboard's About tab can
// bring it back.

import * as storage from "./storage.js";
import { SETUP_WATCHED_KEYS, loadSetupState, buildSetupSteps } from "./setup-steps.js";
import { makeDraggable } from "./overlay-manifest.js";

const MAX_Z_INDEX = 2147483647;

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .fss-panel {
    position: fixed;
    top: 200px;
    left: 80px;
    z-index: ${MAX_Z_INDEX};
    width: 300px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #22d3ee;
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    font: 13px system-ui, -apple-system, "Segoe UI", sans-serif;
    overflow: hidden;
  }
  .fss-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: #1e293b;
    border-bottom: 1px solid #334155;
    cursor: move;
    user-select: none;
  }
  .fss-header h1 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #67e8f9;
  }
  .fss-progress {
    font-size: 12px;
    color: #94a3b8;
    margin-right: auto;
  }
  button {
    font: inherit;
    font-size: 12px;
    color: #e2e8f0;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 2px 8px;
    cursor: pointer;
  }
  button:hover { border-color: #22d3ee; }
  .fss-icon { width: 24px; padding: 2px 0; }
  .fss-body {
    overflow-y: auto;
    padding: 8px 10px 10px;
  }
  .fss-body.fss-collapsed { display: none; }
  ol, ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  li {
    display: grid;
    grid-template-columns: 18px 1fr;
    gap: 6px;
  }
  .fss-mark {
    width: 15px;
    height: 15px;
    margin-top: 1px;
    border: 1.5px solid #475569;
    border-radius: 4px;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 700;
    color: #0f172a;
  }
  .fss-done .fss-mark { background: #4ade80; border-color: #4ade80; }
  .fss-title { font-weight: 600; }
  .fss-done .fss-title { color: #94a3b8; font-weight: 500; }
  .fss-where {
    margin-top: 2px;
    font-size: 12px;
    color: #94a3b8;
  }
  .fss-where button { margin-top: 4px; display: block; }
  .fss-sub {
    margin: 10px 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #94a3b8;
  }
  .fss-allset {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #4ade80;
  }
  .fss-allset span { margin-right: auto; }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
`;

function node(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") n.textContent = value;
    else if (key === "class") n.className = value;
    else if (key === "onclick") n.addEventListener("click", value);
    else if (value != null) n.setAttribute(key, value);
  }
  for (const child of children) if (child != null) n.append(child);
  return n;
}

// Merges `changes` into the stored setup progress (dismissed, position,
// minimised...) without dropping what else is there.
async function updateProgress(changes) {
  const progress = await storage.loadGettingStarted();
  await storage.saveGettingStarted({ ...progress, ...changes });
}

function stepItem(step) {
  return node("li", { class: step.done ? "fss-done" : "" }, [
    node("span", { class: "fss-mark", "aria-hidden": "true", text: step.done ? "✓" : "" }),
    node("div", {}, [
      node("span", { class: "fss-title", text: step.title }),
      step.done ? node("span", { class: "visually-hidden", text: " (done)" }) : null,
      step.done
        ? null
        : node("div", { class: "fss-where" }, [
            step.where,
            step.tab
              ? node("button", {
                  text: `Open ${step.tabLabel} tab`,
                  onclick: () => browser.runtime.sendMessage({ type: "fsc-open-dashboard", tab: step.tab }).catch(() => {}),
                })
              : null,
          ]),
    ]),
  ]);
}

// Set by initSetupPanel() for the session reminder below: the shadow root
// both windows live in, and whether Manifest Setup has rendered yet and is
// showing.
let sharedShadow = null;
let setupRendered = false;
let setupShowing = false;

export function initSetupPanel() {
  const host = document.createElement("div");
  host.id = "fsc-setup-panel-host";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  sharedShadow = shadow;
  const style = document.createElement("style");
  style.textContent = STYLE;
  shadow.appendChild(style);

  // Built once and only refilled on each render, so the drag listeners
  // makeDraggable() puts on the page are added a single time.
  const title = node("h1", { text: "Manifest Setup" });
  const progressText = node("span", { class: "fss-progress" });
  const collapseBtn = node("button", { class: "fss-icon" });
  const skipBtn = node("button", {
    class: "fss-icon",
    text: "×",
    title: "Skip setup - the dashboard's About tab can show it again",
    "aria-label": "Skip setup",
    onclick: () => updateProgress({ dismissed: true, showRequested: false }),
  });
  const header = node("div", { class: "fss-header" }, [title, progressText, collapseBtn, skipBtn]);
  const body = node("div", { class: "fss-body" });
  const panel = node("section", { class: "fss-panel", "aria-label": "Manifest Setup" }, [header, body]);
  panel.style.display = "none";
  shadow.appendChild(panel);
  makeDraggable(panel, header, (left, top) => updateProgress({ setupPanelPos: { left, top } }));
  let collapsed = false;
  collapseBtn.addEventListener("click", () => updateProgress({ setupPanelCollapsed: !collapsed }));

  let shownThisSession = false;
  let renderToken = 0;

  function place(pos) {
    if (!pos) return;
    const left = Math.min(Math.max(0, pos.left), window.innerWidth - 60);
    const top = Math.min(Math.max(0, pos.top), window.innerHeight - 40);
    panel.style.right = "auto";
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  async function render() {
    const token = ++renderToken;
    const state = await loadSetupState();
    if (token !== renderToken) return; // a newer render started meanwhile
    const { required, optional } = buildSetupSteps(state);
    const doneCount = required.filter((step) => step.done).length;
    const allDone = doneCount === required.length;
    const progress = state.progress;

    // showRequested: the dashboard's About tab asked to see it again, even
    // with setup already finished.
    setupRendered = true;
    if (progress.dismissed || (allDone && !shownThisSession && !progress.showRequested)) {
      panel.style.display = "none";
      setupShowing = false;
      return;
    }
    shownThisSession = true;
    setupShowing = true;
    panel.style.display = "";
    place(progress.setupPanelPos);
    body.replaceChildren();

    // Finished: just "all set" - unless the About tab asked to see the steps.
    if (allDone && !progress.showRequested) {
      progressText.textContent = "";
      collapseBtn.hidden = true;
      body.classList.remove("fss-collapsed");
      body.append(
        node("div", { class: "fss-allset", role: "status" }, [
          node("span", { text: "✓ You're all set." }),
          node("button", { text: "Close", onclick: () => updateProgress({ dismissed: true, showRequested: false }) }),
        ])
      );
      return;
    }

    collapsed = !!progress.setupPanelCollapsed;
    progressText.textContent = `${doneCount} of ${required.length} done`;
    collapseBtn.hidden = false;
    collapseBtn.textContent = collapsed ? "+" : "–";
    collapseBtn.title = collapsed ? "Expand" : "Minimise";
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand Manifest Setup" : "Minimise Manifest Setup");
    body.classList.toggle("fss-collapsed", collapsed);
    body.append(node("ol", {}, required.map(stepItem)), node("div", { class: "fss-sub", text: "Optional" }), node("ul", {}, optional.map(stepItem)));
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && SETUP_WATCHED_KEYS.some((key) => key in changes)) render();
  });
  render();
}

// ---- "Refresh your data" reminder ----
// Storage and skills change between play sessions, and the planner only sees
// them when those screens are opened. So each time the game page loads, once
// the player is in the game (content.js calls noteInGame() when the top bar
// is read), a small window lists both and ticks each off as it's read this
// session (noteRead()). It closes by itself once both are, or with ×. Never
// shown while Manifest Setup is (that covers both), when both were read
// before it got the chance, or with the reminder turned off in Settings.
const REMINDER_ITEMS = [
  { key: "storage", text: "Open Commercial Storage" },
  { key: "skills", text: "Open Skills (Ship Skills tab)" },
];
const REMINDER_DONE_MS = 4000;
const sessionRead = new Set();
let reminderState = "waiting"; // waiting -> checking -> showing -> closed
let reminderPanel = null;
let reminderList = null;

function closeReminder() {
  reminderState = "closed";
  if (reminderPanel) reminderPanel.remove();
  reminderPanel = null;
}

function renderReminderRows() {
  if (!reminderList) return;
  reminderList.replaceChildren(
    ...REMINDER_ITEMS.map((item) => {
      const done = sessionRead.has(item.key);
      return node("li", { class: done ? "fss-done" : "" }, [
        node("span", { class: "fss-mark", "aria-hidden": "true", text: done ? "✓" : "" }),
        node("div", {}, [node("span", { class: "fss-title", text: item.text }), done ? node("span", { class: "visually-hidden", text: " (done)" }) : null]),
      ]);
    })
  );
}

export async function noteInGame() {
  if (reminderState !== "waiting" || !sharedShadow || !setupRendered) return;
  if (setupShowing || REMINDER_ITEMS.every((item) => sessionRead.has(item.key))) {
    reminderState = "closed";
    return;
  }
  reminderState = "checking";
  const [settings, progress] = await Promise.all([storage.loadSettings(), storage.loadGettingStarted()]);
  if (settings.session_reminder === false || REMINDER_ITEMS.every((item) => sessionRead.has(item.key))) {
    reminderState = "closed";
    return;
  }
  const header = node("div", { class: "fss-header" }, [
    node("h1", { text: "Refresh your data" }),
    node("span", { class: "fss-progress" }),
    node("button", { class: "fss-icon", text: "×", title: "Close for this session", "aria-label": "Close the refresh reminder", onclick: closeReminder }),
  ]);
  reminderList = node("ol");
  const body = node("div", { class: "fss-body" }, [
    node("div", { class: "fss-where", text: "Storage and skills may have changed since last time - open these so the planner is up to date:" }),
    reminderList,
  ]);
  reminderList.style.marginTop = "8px";
  reminderPanel = node("section", { class: "fss-panel", "aria-label": "Refresh your data" }, [header, body]);
  sharedShadow.appendChild(reminderPanel);
  const pos = progress.setupPanelPos;
  if (pos) {
    reminderPanel.style.left = `${Math.min(Math.max(0, pos.left), window.innerWidth - 60)}px`;
    reminderPanel.style.top = `${Math.min(Math.max(0, pos.top), window.innerHeight - 40)}px`;
  }
  makeDraggable(reminderPanel, header, (left, top) => updateProgress({ setupPanelPos: { left, top } }));
  reminderState = "showing";
  renderReminderRows();
}

export function noteRead(kind) {
  if (sessionRead.has(kind)) return;
  sessionRead.add(kind);
  if (reminderState !== "showing") return;
  renderReminderRows();
  if (REMINDER_ITEMS.every((item) => sessionRead.has(item.key))) {
    reminderPanel.querySelector(".fss-body").replaceChildren(node("div", { class: "fss-allset", role: "status" }, [node("span", { text: "✓ Storage and skills refreshed." })]));
    setTimeout(closeReminder, REMINDER_DONE_MS);
  }
}
