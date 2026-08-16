// Tiny vanilla-DOM helpers shared across tab modules - no framework, but
// avoids repeating the same createElement/textContent boilerplate in every
// tab. Every string value passed here goes through textContent, never
// innerHTML, so scraped/externally-sourced names can never be interpreted
// as markup (see the XSS guardrail note in the migration plan).

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") {
      node.textContent = value;
    } else if (key === "class") {
      node.className = value;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Creates a <tr> for the "click a row to select/load it" pattern used by
// the Blueprints and Assembly tabs' requirement tables, and the Plan tab's
// result tables (materials needed / ore to mine) - previously four
// near-identical, mouse-only copies of the same code across three files.
// A bare <tr> isn't natively focusable or operable by keyboard at all, so
// without this, none of those rows could be reached or selected without a
// mouse. This makes each row focusable (tabindex="0", so it takes its
// place in the natural DOM tab order right where the table sits), gives it
// role="button" + an aria-label so screen readers announce what selecting
// it does, and handles Enter/Space the same as a click. Still toggles a
// shared `.selected` class among sibling rows the same way the old
// per-tab code did, since other code (e.g. "Remove Selected" buttons)
// looks for `tr.selected`.
export function selectableRow(attrs, label, cells, onSelect) {
  const row = el("tr", { ...attrs, tabindex: "0", role: "button", "aria-label": label }, cells);
  const activate = () => {
    const tbody = row.parentElement;
    if (tbody) for (const r of tbody.querySelectorAll("tr")) r.classList.remove("selected");
    row.classList.add("selected");
    onSelect();
  };
  row.addEventListener("click", activate);
  row.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    activate();
  });
  return row;
}

// Wires up "ghost text" inline autocomplete on a text input: as the user
// types, the first candidate name that starts with what they've typed
// (case-insensitive) is filled in ahead of the cursor with the remainder
// highlighted/selected, so pressing Tab (or Enter, or just continuing to
// type) accepts it immediately - unlike a plain <list>-attribute
// <datalist> dropdown, which requires arrowing down and hitting Enter (or
// clicking) to accept a suggestion at all. The input can still also have a
// `list` attribute pointing at a <datalist> alongside this - the dropdown
// stays available for browsing every match, while this handles the common
// "type a few letters, hit Tab" case directly.
//
// `getCandidates` is a function, not a plain array, so callers whose
// candidate list changes at runtime (e.g. Assembly's output-item field,
// which depends on current inventory + existing blueprints) always get the
// live list without needing to separately re-wire this on every update.
export function enableInlineAutocomplete(input, getCandidates) {
  input.addEventListener("input", (e) => {
    // Only auto-extend on typed/inserted/pasted text, never while
    // deleting - otherwise backspacing "Novastone" down to "Nova" would
    // immediately re-autocomplete right back to "Novastone", making
    // backspace impossible to use for narrowing/correcting a search.
    if (e.inputType && e.inputType.startsWith("delete")) return;
    const value = input.value;
    if (!value) return;
    const needle = value.toLowerCase();
    const match = getCandidates().find((name) => name.length > value.length && name.toLowerCase().startsWith(needle));
    if (!match) return;
    input.value = match;
    input.setSelectionRange(value.length, match.length);
  });
}
