#!/bin/sh
# Remielle Desktop Agent — macOS installer
#
#   curl -fsSL https://raw.githubusercontent.com/Calyndrae/RemielleDesktopAgent/main/scripts/install.sh | sh
#
# Downloads the published .dmg, installs to /Applications, and clears the
# quarantine flag — which is the step that otherwise makes an unsigned app
# refuse to open with "damaged and can't be opened". Nothing here needs sudo
# unless /Applications is locked down.

set -e

REPO="Calyndrae/RemielleDesktopAgent"
APP="Remielle Desktop Agent.app"

printf '蕾米埃尔 · Remielle Desktop Agent\n'

case "$(uname -m)" in
  arm64) : ;;
  *) printf '  This build is Apple Silicon only; an Intel build is not published yet.\n'; exit 1 ;;
esac

api="https://api.github.com/repos/$REPO/releases/latest"
url=$(curl -fsSL "$api" | grep -o 'https://[^"]*\.dmg' | head -1)
[ -n "$url" ] || { printf '  No .dmg in the latest release.\n'; exit 1; }

tmp=$(mktemp -d)
trap 'hdiutil detach "$tmp/mnt" -quiet 2>/dev/null || true; rm -rf "$tmp"' EXIT

printf '  downloading   %s\n' "$(basename "$url")"
curl -fsSL "$url" -o "$tmp/remielle.dmg"

# Verify against the published checksums when they are available.
sums=$(curl -fsSL "$api" | grep -o 'https://[^"]*SHA256SUMS\.txt' | head -1)
if [ -n "$sums" ]; then
  expected=$(curl -fsSL "$sums" | grep '\.dmg' | awk '{print $1}' | head -1)
  actual=$(shasum -a 256 "$tmp/remielle.dmg" | awk '{print $1}')
  if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
    printf '  checksum mismatch — download discarded.\n'
    exit 1
  fi
  [ -n "$expected" ] && printf '  checksum      verified\n'
fi

mkdir -p "$tmp/mnt"
hdiutil attach "$tmp/remielle.dmg" -mountpoint "$tmp/mnt" -nobrowse -quiet

rm -rf "/Applications/$APP"
cp -R "$tmp/mnt/$APP" /Applications/
hdiutil detach "$tmp/mnt" -quiet

# The app is not notarised, so macOS quarantines it on download. Removing the
# attribute is what the right-click-Open dance does, minus the dance.
xattr -dr com.apple.quarantine "/Applications/$APP" 2>/dev/null || true

printf '\n  installed to  /Applications/%s\n\n' "$APP"
printf 'Launching…\n'
open "/Applications/$APP"
