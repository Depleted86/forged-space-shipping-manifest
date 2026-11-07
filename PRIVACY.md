# Privacy Policy — Forged Space Shipping Manifest

_Last updated: 2026-11-07_

Forged Space Shipping Manifest is a browser extension for the game
[Forged Space](https://forgedspace.com), developed with explicit
permission from Coops, the game's developer. This policy explains, in
plain terms, what the extension does and does not do with your data.

## Summary

This extension does not collect, transmit, sell, or share any of your
data, personal or otherwise. It has no server to send anything to. It
does not use analytics, tracking, or any third-party service. Everything
it does happens locally, inside your own browser.

## What data the extension accesses

- **Forged Space game data**: while you're on forgedspace.com, the
  extension reads the game screens you open to keep its own local planning
  data in sync: your Commercial Storage listing, the Corp Store, the
  blueprint stores, the Assembly Facility and R&D Office plan lists, the
  Character Skills window, the planet reference in the Systems Lexicon,
  and your Captain level and cargo/Ore Hold sizes from the game's top bar.
  It only reads what those screens show. It never interacts with the
  game's own interface: it does not click anything, fill in a form, or
  take any action in the game on your behalf. It adds its own UI to the
  page - a floating "Manifest" overlay, a "Manifest Setup" checklist for
  new players and short notices when a blueprint is saved - but those are
  separate, self-contained elements the
  extension draws and controls itself; they don't write to or change the
  game's own page content in any way.
- **Your own extension data**: saved builds, harvester assignments, corp
  plans and choices that you enter into the extension yourself.

## What the extension does NOT do

- It makes no network requests of any kind. It cannot send data anywhere,
  because it never tries to.
- It does not use cookies, analytics, or any third-party tracking or
  advertising service.
- It does not collect or transmit any personally identifiable
  information.
- It does not access any website other than forgedspace.com, and only to
  read the page - never to submit or modify anything on it.

## Where your data is stored

Everything the extension uses is stored locally in your own browser, via
the standard `browser.storage.local` extension API, scoped to your
browser profile. It is never uploaded, synced to a remote server, or
shared with anyone - including the developer of this extension.
Uninstalling the extension, or clearing its storage from your browser's
extension settings, removes this data completely.

The Settings tab can export your blueprints, builds and harvester setup to
a file, and the Corp tab can export a CSV. These files are only created
when you click Export, are saved by your browser to your own computer, and
are never sent anywhere. Importing a file only reads the file you pick.

## Permissions this extension requests, and why

- **`storage`** — used only to save the data described above locally in
  your browser.
- **Access to `forgedspace.com`** — used only so the extension's content
  script can read the game screens described above.
  It is not used to make requests to that site or anywhere else.

## Changes to this policy

If this policy ever changes, the updated version will be posted at this
same location, in the same public source repository as the rest of the
extension's code.

## Source code and verification

This extension's full source code is public specifically so that
everything above can be independently verified rather than taken on
faith: https://github.com/Depleted86/forged-space-shipping-manifest

## Contact

Questions or concerns can be raised via
[GitHub Issues](https://github.com/Depleted86/forged-space-shipping-manifest/issues)
on the project repository.
