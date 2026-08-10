// About tab - shows the same permission/privacy disclaimer as the one-time
// install splash (welcome.html/welcome.js), but always reachable on demand
// rather than relying solely on browser.runtime.onInstalled firing (which
// doesn't reliably trigger for temporary/debug-loaded extensions, only real
// installs). Text is intentionally duplicated rather than shared with
// welcome.html - that page is static markup while this one renders via the
// el() helper, and the message is short enough that a shared-text module
// isn't worth the extra indirection. Keep both in sync if the wording ever
// changes.
//
// Wording mirrors the actual conditions Coops (Forged Space's developer) set
// for this extension to exist at all: local-only (no network requests,
// ever), strictly read-only (no clicking/submitting/automating anything in
// the game), and open source. Don't loosen this text without re-confirming
// with Coops' stated terms - these are promises the code needs to keep, not
// just marketing copy.

import { el } from "./dom-helpers.js";

export function initAboutTab(app, container) {
  container.appendChild(
    el("div", { class: "about-panel" }, [
      el("h2", { text: "About Forged Space Shipping Manifest" }),
      el("p", { text: "This extension was developed with explicit permission from Coops, the developer of Forged Space." }),
      el("p", {
        text: "It makes no network requests of any kind and never transmits anything anywhere. The only data it stores is your own Forged Space game data (inventory, recipes, builds, and settings), saved locally in your browser and nowhere else.",
      }),
      el("p", {
        text: "It is strictly read-only: it only reads what's already on the page you're looking at. It never clicks anything, fills in a form, or takes any action in the game on your behalf.",
      }),
      el("p", {}, [
        "The source code is public on ",
        el("a", { href: "https://github.com/Depleted86/forged-space-shipping-manifest", target: "_blank", rel: "noopener noreferrer", text: "GitHub" }),
        " so you (or anyone) can verify all of the above for yourself, rather than just taking our word for it.",
      ]),
      el("p", {
        text: "This is an independently maintained fan tool, not an official part of the game. Forged Space itself is still being actively rebuilt, and its pages can be restyled or rewritten with no notice - when that happens, this extension can break in ways that look wrong or show bad numbers. If something stops working after a Forged Space update, that means this extension needs fixing - not that your game or your save is broken.",
      }),
    ])
  );
}
