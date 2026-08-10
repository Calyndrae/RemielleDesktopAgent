#!/bin/sh
# Signs a built .app with the local stable identity, if present.
#
# Ad-hoc signatures change on every build, and the macOS Keychain keys its
# ACLs to the signature — so every rebuild re-prompted for every stored API
# key. A self-signed identity named below, created once in the login keychain
# (see session/HANDOFF.md §signing), gives every build the same designated
# requirement: the Keychain asks once, ever. Gatekeeper on *other* machines
# still warns — this is a local-development identity, not distribution
# signing, which remains the §9 decision.
#
# No identity → quiet no-op, so CI and other machines build unchanged.
set -e

APP="${1:?usage: sign-macos.sh <path to .app>}"
IDENTITY="Remielle Local Signing"

if ! security find-identity -p codesigning -v 2>/dev/null | grep -q "$IDENTITY"; then
  echo "sign-macos: identity '$IDENTITY' not present; leaving ad-hoc signature"
  exit 0
fi

codesign --force --deep -s "$IDENTITY" "$APP"
echo "sign-macos: signed with '$IDENTITY'"
codesign -dr - "$APP" 2>&1 | grep "designated" || true
