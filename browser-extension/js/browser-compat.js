// Minimal Chrome/Edge <-> Firefox compatibility shim.
//
// NOT the full official webextension-polyfill package - that ships as a
// non-ESM UMD build (an IIFE relying on top-level `this` as the global
// object) which breaks under ES module strict-mode semantics (`this` is
// undefined in a module's top-level scope), so it can't be cleanly
// `import`-ed into this project's module-based contexts (the MV3 service
// worker, dashboard.js, and - via dynamic import() - overlay-manifest.js/
// overlay-blueprint-modal.js). content.js itself is a classic (non-module)
// content script - see its own header comment for why - so this file loads
// there the older way too: its own separate entry in manifest.json's
// content_scripts "js" array, listed before content.js.
//
// Firefox exposes a native, promise-based `browser` global; Chrome/Edge
// only expose `chrome`, historically callback-based. Since MV3 already
// requires Chrome 88+, and Chrome's extension APIs return Promises when
// called without a callback as of that version, simply aliasing `browser`
// to `chrome` where `browser` doesn't already exist is enough to make every
// `browser.*` call in this codebase work unchanged on both. This only needs
// to cover what this extension actually calls: storage, runtime messaging,
// tabs, windows, action - not the full WebExtension API surface.
if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined") {
  globalThis.browser = globalThis.chrome;
}
