# Remielle Desktop Agent

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="" />
</p>

A desktop companion: **蕾米埃尔 (Remielle Dan)** floats on your desktop with a
transparent background, plays an idle animation, and opens an LLM-backed chat
panel when you click her. Her animation follows what the model is doing —
idle → thinking → drawing.

> **Unofficial, non-commercial fan project.** Not affiliated with, endorsed by,
> or approved by HoYoverse. The bundled artwork is CC BY-NC-SA 4.0 and may not be
> used commercially — see [NOTICE.md](NOTICE.md).

---

## Status

Both desktop platforms build, run, and ship: releases carry a macOS dmg and
Windows installers for x64 and ARM64. The overlay, chat panel, streaming,
provider support, tool loop, web search, settings and ambient behaviour are
implemented, with 216 Rust tests and 106 frontend tests.

| Platform | State |
|---|---|
| macOS (Apple Silicon) | Builds, runs, released. Runs as an accessory process; transparency confirmed. |
| macOS (Intel) | Configured, never built. |
| Windows (ARM64) | Built, run and verified in a Windows 11 VM; released. |
| Windows (x64) | Cross-compiled from the ARM64 VM and released; not yet run on x64 hardware. |

Still unbuilt: fullscreen-game auto-hide (a Windows feature to write, not a
call to wire) and the macOS Intel build. `session/HANDOFF.md` records the
full history and the reasoning.

## Features

- Transparent always-on-top sprite that does not block clicks to what is
  underneath — hit-tested in Rust against the current animation frame's alpha
- Chat panel with streaming responses, expandable reasoning, copy / regenerate
- Providers: OpenAI-compatible (OpenAI, DeepSeek, Grok, OpenRouter, Ollama) and
  Google Gemini
- API keys stored per-user — DPAPI on Windows, a 0600 file on macOS (the
  Keychain is deliberately out: its ACLs bind to the binary's signature, which
  a locally-built app changes every rebuild). Never readable from JavaScript:
  there is no command that returns a key
- A fixed catalog of typed tools with enum-constrained parameters. No shell tool,
  and a test fails the build if one is ever added
- Sessions are **not** kept by default; you are asked whether to save on close
- Export to Markdown, JSON, or a handoff for another assistant
- Occasional proactive behaviour with quiet hours, a daily cap and a "not today"
- Keyless web search (Wikipedia, DuckDuckGo, GDELT, Google News) routed and
  fetched in Rust — the model picks among results; it can never name a URL
- Light and dark panel themes, both opaque, both measured against WCAG AA
- UI in Simplified Chinese; tray, menus and fault panels also in English. A
  full English UI is open work, not a shipped feature.

## Tech stack

Tauri v2 · React 19 · TypeScript · Rust

Typography is **Noto Serif SC**, vendored as ~100 `unicode-range` subsets under
the SIL Open Font License — see [NOTICE.md](NOTICE.md). It is committed rather
than fetched because the app must render with no network and the webview's CSP
blocks external hosts.

## Layout

```
src/           React frontend — overlay, chat panel, settings, state
src-tauri/     Rust backend — windowing, click-through, LLM, tools, secrets
assets/        Her animation pack and registration offsets
program/       Finished builds, one folder per platform
  macos/         .app and .dmg
  windows/       .exe installer
session/       Handoff notes, design decisions, deletion ledger
scripts/       Font vendoring, layout regression check, demo inliner
```

`program/*/README.md` explains how each platform's artefacts are produced.
Build outputs there are gitignored; the READMEs are not.

## Development

```bash
pnpm install
pnpm tauri dev
```

The repository pins pnpm 10 via `packageManager`; with Corepack enabled the
right version is fetched automatically.

```bash
pnpm typecheck       # TypeScript
pnpm test            # frontend tests
pnpm layout:check    # Playwright layout regression on the chat panel
pnpm demo            # browser demo of the real components, no Tauri
pnpm demo:build      # → demo-standalone.html, one self-contained file

cd src-tauri
cargo test           # the Rust suite
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Building

Bundling needs the target platform's webview and packager, so installers are
produced per-platform — with one exception that works in practice: the released
x64 Windows build is a `--target x86_64-pc-windows-msvc` cross-compile from an
ARM64 Windows host.
`bundle.targets` is `["nsis", "app", "dmg"]` and Tauri skips whichever do not
apply, so the same command is correct on both.

```bash
pnpm tauri icon src-tauri/icons/icon.png   # first time only, generates icon.icns
pnpm tauri build
```

See [`program/macos/README.md`](program/macos/README.md) and
[`program/windows/README.md`](program/windows/README.md) for the per-platform
details, including the caveats of the icon step and how to get a Windows
installer without a Windows machine.

Neither platform is code-signed, so a downloaded build warns once. On current
macOS the right-click → Open trick no longer works: it is System Settings →
Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine` from
a terminal). Windows shows a SmartScreen warning — *More info* → *Run anyway*.
Released downloads are shaped so neither platform needs a command: Windows
ships an NSIS installer, macOS a drag-to-Applications `.dmg`.

### Linux

Not a target. The Rust side compiles there for CI and type-checking, which is
what `.github/workflows/check.yml` uses — none of the tests need a webview. It
needs the usual Tauri system dependencies:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
```

Note that `macOSPrivateApi` is enabled in `tauri.conf.json` (required for window
transparency on macOS); this makes the app ineligible for the Mac App Store,
which is fine for a project that cannot be distributed commercially anyway.

## License

- **Code** — [MIT](LICENSE)
- **Assets in `assets/`** — [CC BY-NC-SA 4.0](LICENSE-ASSETS)

Full attribution chain in [NOTICE.md](NOTICE.md): character © HoYoverse,
animation by 森哈_Yeah, asset pack by
[ZanyZebra1127](https://github.com/ZanyZebra1127/Little-Remielle).
