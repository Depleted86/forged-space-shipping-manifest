// Shown once, on first install (see background.js's runtime.onInstalled
// listener) - just needs to close its own tab on dismiss, no WebExtension
// API calls involved, so this is a plain classic script (no browser-compat
// shim needed).
document.getElementById("dismiss").addEventListener("click", () => {
  window.close();
});
