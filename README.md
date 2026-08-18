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

Windows-first by design; **macOS builds and runs**. The overlay, chat panel,
streaming, provider support, tool loop, settings and ambient behaviour are
implemented, with 157 Rust tests and 78 frontend tests.

| Platform | State |
|---|---|
| macOS (Apple Silicon) | Builds, launches, runs as an accessory process. Transparency confirmed. |
| macOS (Intel) | Configured, never built. |
| Windows | Configured and unit-tested, **never built or run**. |

Not yet built at all: tray icon, run-at-login, fullscreen-game auto-hide, slash
commands, and the proactive-greeting UI. `session/HANDOFF.md` §5 has the
prioritised list and the reasoning.

## Features

- Transparent always-on-top sprite that does not block clicks to what is
  underneath — hit-tested in Rust against the current animation frame's alpha
- Chat panel with streaming responses, expandable reasoning, copy / regenerate
- Providers: OpenAI-compatible (OpenAI, DeepSeek, Grok, OpenRouter, Ollama) and
  Google Gemini
- API keys stored in the OS credential store — Keychain on macOS, Credential
  Manager via DPAPI on Windows. Never in a config file, and never readable from
  JavaScript: there is no command that returns a key
- A fixed catalog of typed tools with enum-constrained parameters. No shell tool,
  and a test fails the build if one is ever added
- Sessions are **not** kept by default; you are asked whether to save on close
- Export to Markdown, JSON, or a handoff for another assistant
- Occasional proactive behaviour with quiet hours, a daily cap and a "not today"
- Light and dark panel themes, both opaque, both measured against WCAG AA
- Bilingual UI (简体中文 / English)

Planned, not built: web search with an agentic search → pick-links → fetch loop
for providers without native search, and `/emote change <name>` with live
previews.

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
pnpm test            # 78 frontend tests
pnpm layout:check    # Playwright layout regression on the chat panel
pnpm demo            # browser demo of the real components, no Tauri
pnpm demo:build      # → demo-standalone.html, one self-contained file

cd src-tauri
cargo test           # 157 tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Building

There is no cross-compile. Tauri bundles against the host's own webview and
packager, so each platform's installer must be produced on that platform.
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
