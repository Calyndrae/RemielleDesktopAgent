# macOS

All macOS program data, executables and bundles live here.

## What lands in this folder

| | |
|---|---|
| `Remielle Desktop Agent.app` | The application bundle. Runnable in place — double-click it, or `open "Remielle Desktop Agent.app"`. |
| `Remielle Desktop Agent_0.1.0_aarch64.dmg` | The installer disk image. Contains the same `.app`, plus the drag-to-Applications layout. |

Both are gitignored. They are build outputs, reproducible from source, and a
fresh pair is about 57 MB — see `session/DELETED.md` for the reasoning.

## Producing them

```bash
pnpm tauri icon src-tauri/icons/icon.png
pnpm tauri build
cp -R "src-tauri/target/release/bundle/macos/Remielle Desktop Agent.app" program/macos/
cp "src-tauri/target/release/bundle/dmg/"*.dmg program/macos/
```

The icon step generates `src-tauri/icons/icon.icns`, which is deliberately not
checked in and deliberately absent from `bundle.icon` — naming a file that is
not there fails the bundle on *every* platform, not only the one that wanted it.

Two things that command does which you probably do not want to keep: it
overwrites `src-tauri/icons/icon.png` with an upscale of itself, so running it
repeatedly degrades the source a little each time, and it emits iOS, Android and
Windows Store icon sets this project ships none of. Restore the source and drop
the extras afterwards:

```bash
git checkout -- src-tauri/icons/icon.png src-tauri/icons/icon.ico
rm -rf src-tauri/icons/android src-tauri/icons/ios src-tauri/icons/64x64.png src-tauri/icons/Square*Logo.png src-tauri/icons/StoreLogo.png
```

## Architecture

`pnpm tauri build` with no `--target` builds for the machine you are on. This
folder currently holds an **aarch64** (Apple Silicon) build. For Intel, or for
both, pass the target explicitly:

```bash
pnpm tauri build --target x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

Cross-architecture builds need the matching Rust target installed
(`rustup target add x86_64-apple-darwin`).

## Signing

Not signed — the bundle carries an ad-hoc linker signature only. Built locally
it runs without complaint, because it never gets a quarantine attribute. Copied
from another machine or downloaded, Gatekeeper will refuse it until:

```bash
xattr -dr com.apple.quarantine "Remielle Desktop Agent.app"
```

or a right-click → Open. Real signing needs a paid Apple Developer certificate;
it is an open decision in `session/HANDOFF.md` §9.

## The icon is soft, and that is a source problem

`src-tauri/icons/icon.png` is 256×256. macOS wants 1024×1024 for the largest
`.icns` slot, so the icon in Finder and Get Info is an upscale. Fixing it needs a
≥1024×1024 original — regenerating from the 256 cannot recover detail that was
never there.

## Verified on this build

- The overlay window is genuinely transparent; the wallpaper reads through the
  space around her.
- She is an accessory process — `lsappinfo` reports
  `ApplicationType="UIElement"`, no Dock icon, no menu bar, absent from ⌘-Tab.
  This required a code change; `LSUIElement` in `Info.plist` was necessary but
  not sufficient. See the commit for `src-tauri/src/lib.rs`.
- Bundled resources are present: all seven animations, `pack.json`, and the
  persona directory.

Not yet verified: that clicks pass through the empty space around her to what is
underneath. The mechanism has unit tests, but the end-to-end behaviour has not
been exercised on a Mac.
