#!/bin/sh
# Fails if a built .dmg contains an app macOS would call "damaged".
#
#   scripts/check-macos-dmg.sh path/to/Remielle....dmg
#
# Three macOS releases shipped an app whose only signature was the one the
# linker applies automatically: no `_CodeSignature/CodeResources`, while the
# binary's signature said resources must be present. Gatekeeper reads that
# combination as corruption and refuses with "damaged … move it to the Trash"
# — a hard block with no "Open Anyway", so the first-run instructions in the
# release notes could not be followed and the app was simply unusable on
# anyone else's Mac. It passed unnoticed here because the *installed* copy is
# re-signed locally after the dmg is built, so the developer's machine never
# sees what the download contains.
#
# `codesign --verify --deep --strict` is the whole test. It costs a second
# and it is the difference between shipping and shipping something broken.
set -e

DMG="${1:?usage: check-macos-dmg.sh <path to .dmg>}"
MOUNT=$(mktemp -d)
trap 'hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; rmdir "$MOUNT" 2>/dev/null || true' EXIT

hdiutil attach "$DMG" -mountpoint "$MOUNT" -nobrowse -quiet
APP=$(find "$MOUNT" -maxdepth 1 -name "*.app" | head -1)
[ -n "$APP" ] || { echo "no .app inside $DMG"; exit 1; }

if [ ! -d "$APP/Contents/_CodeSignature" ]; then
  echo "FAIL: $(basename "$APP") has no _CodeSignature — Gatekeeper will call it damaged."
  echo "      bundle.macOS.signingIdentity must be set so Tauri signs before it builds the dmg."
  exit 1
fi

codesign --verify --deep --strict "$APP"
echo "OK: $(basename "$APP") carries a valid signature."
