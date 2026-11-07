// Shown once, on first install (see background.js's runtime.onInstalled
// listener). Its button takes this tab to the game, where the Manifest
// Setup window walks a new player through setup - a plain link, so no
// WebExtension API calls and no browser-compat shim needed.
document.getElementById("dismiss").addEventListener("click", () => {
  location.href = "https://forgedspace.com/";
});
