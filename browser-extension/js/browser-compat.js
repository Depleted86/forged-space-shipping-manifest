// Minimal Chrome/Edge <-> Firefox compatibility shim.
//
// NOT the full official webextension-polyfill package - that ships as a
// non-ESM UMD build (an IIFE relying on top-level `this` as the global
// object) which breaks under ES module strict-mode semantics (`this` is
// undefined in a module's top-level scope), so it can't be cleanly
// `import`-ed into this project's module-based contexts (the MV3 service
// worker, popup.js, dashboard.js). Content scripts avoid that problem by
// loading this as a classic (non-module) script instead - see manifest.json.
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
