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

export function option(value, label, selected = false) {
  return el("option", { value, selected: selected ? "" : undefined, text: label });
}
