# Privacy Policy — Forged Space Shipping Manifest

_Last updated: 2026-08-09_

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
  extension reads the page you're currently viewing — specifically your
  storage inventory listing — to keep its own local ore/inventory
  tracking in sync with what's actually in your in-game storage. It does
  not read any other part of the page, and it never interacts with the
  page beyond reading it: it does not click anything, fill in a form, or
  take any action in the game on your behalf.
- **Your own extension data**: recipes, inventory snapshots, saved
  builds, and settings that you enter into the extension yourself.

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

## Permissions this extension requests, and why

- **`storage`** — used only to save the data described above locally in
  your browser.
- **Access to `forgedspace.com`** — used only so the extension's content
  script can read the storage screen on that page, as described above.
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
