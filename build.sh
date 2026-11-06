#!/usr/bin/env bash
# Builds the store packages from browser-extension/ (test/ excluded):
#   forged-space-shipping-manifest-<ver>.zip         Firefox (AMO), manifest as-is
#   forged-space-shipping-manifest-chrome-<ver>.zip  Chrome Web Store
#   forged-space-shipping-manifest-edge-<ver>.zip    Edge Add-ons
# Chrome and Edge get the same Chromium manifest: background.scripts and
# browser_specific_settings stripped, since Chromium flags both as errors.
# The unpacked Chromium build stays in dist/chromium for "Load unpacked".
set -euo pipefail
cd "$(dirname "$0")"

src=browser-extension
ver=$(jq -r .version "$src/manifest.json")
name=forged-space-shipping-manifest

rm -f "$name-$ver.zip" "$name-chrome-$ver.zip" "$name-edge-$ver.zip"
(cd "$src" && zip -qr "../$name-$ver.zip" . -x 'test/*')

rm -rf dist/chromium
mkdir -p dist/chromium
(cd "$src" && tar cf - --exclude=./test .) | tar xf - -C dist/chromium
jq 'del(.browser_specific_settings) | .background |= del(.scripts)' \
  "$src/manifest.json" > dist/chromium/manifest.json
(cd dist/chromium && zip -qr "../../$name-chrome-$ver.zip" .)
cp "$name-chrome-$ver.zip" "$name-edge-$ver.zip"

ls -l "$name-$ver.zip" "$name-chrome-$ver.zip" "$name-edge-$ver.zip"
