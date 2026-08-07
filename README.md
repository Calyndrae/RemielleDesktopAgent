# Remielle Desktop Agent

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="" />
</p>

A desktop companion for Windows: **蕾米埃尔 (Remielle Dan)** floats on your
desktop with a transparent background, plays an idle animation, and opens an
LLM-backed chat panel when you click her. Her animation follows what the model is
doing — idle → thinking → drawing.

> **Unofficial, non-commercial fan project.** Not affiliated with, endorsed by,
> or approved by HoYoverse. The bundled artwork is CC BY-NC-SA 4.0 and may not be
> used commercially — see [NOTICE.md](NOTICE.md).

---

## Status

Early development. Milestone **M0** (transparent overlay, click-through hit
testing, sprite rendering, drag) is in progress; nothing is shippable yet.

## Features (planned)

- Transparent always-on-top sprite that never blocks clicks to what's underneath
- Chat panel with streaming responses, expandable reasoning, copy / regenerate
- Providers: OpenAI-compatible (OpenAI, DeepSeek, Grok, OpenRouter, Ollama) and
  Google Gemini
- API keys stored in the **Windows Credential Manager**, never in a config file
- Web search — provider-native where available, with an agentic
  search → pick-links → fetch → answer loop for providers without it
- Sessions are **not** kept by default; you're asked whether to save on close
- Slash commands, including `/emote change <name>` with live previews
- Occasional proactive greetings, with granular control over what context gets
  sent to the model
- Bilingual UI (简体中文 / English)

## Tech stack

Tauri v2 · React 19 · TypeScript · Rust

Typography is **Noto Serif SC**, vendored under the SIL Open Font License —
see [NOTICE.md](NOTICE.md).

Windows is the shipping target. Platform-specific code is isolated in
`src-tauri/src/platform/` so a macOS port is additive rather than invasive.

## Development

```bash
pnpm install
pnpm tauri dev
```

Before the sprite will render you need to supply the animation files — see
[`assets/packs/little-remielle/README.md`](assets/packs/little-remielle/README.md).

```bash
pnpm typecheck                 # TypeScript
pnpm test                      # frontend unit tests
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
```

### Building on Linux

The app targets Windows, but the Rust side compiles on Linux for CI and
type-checking. It needs the usual Tauri system dependencies:

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
