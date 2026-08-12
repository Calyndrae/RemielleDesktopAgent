# Remielle Desktop Agent v0.1.0

蕾米埃尔·丹 — a desktop companion that lives on your screen, not in a browser tab.

## Downloads

| File | Platform | Notes |
|---|---|---|
| `Remielle Desktop Agent_0.1.0_aarch64.dmg` | macOS (Apple Silicon) | Installer. Unsigned — see below. |
| `Remielle Desktop Agent_0.1.0_x64.exe` | Windows 10/11 (Intel/AMD) | Portable executable — no install, just run. |
| `Remielle Desktop Agent_0.1.0_arm64.exe` | Windows on ARM | Portable executable. |

## First run

**Windows** will show a SmartScreen warning ("unknown publisher") because these
binaries are not signed by a certificate authority. Click *More info* →
*Run anyway*. Signing is tracked below.

**macOS** will refuse to open an unsigned app from the internet: right-click the
app → *Open*, or run
`xattr -dr com.apple.quarantine "/Applications/Remielle Desktop Agent.app"`.

Then open 设置 (Settings) and add an API key for your provider (DeepSeek, OpenAI,
Groq, Ollama, or any OpenAI-compatible endpoint). The key is stored per-user on
your machine — never sent anywhere except to the provider you chose.

## What she does

- Floats over your desktop, click-through everywhere except where she is
- Chat with markdown, LaTeX, and citations that carry their source's favicon
- Web search that needs no API key (Wikipedia, DuckDuckGo, GDELT, Google News)
- Speaks unprompted now and then — she has her own voice, not a configurable one
- A small, enum-constrained tool catalog (no shell access, ever, by design)

## Known limitations

- **Not code-signed.** Both platforms warn on first launch. For Windows, the
  intended fix is SignPath.io's free Foundation certificate for open-source
  projects (requires a public repo and maintainer application).
- **No Windows installer yet.** The `.exe` files are portable; the NSIS
  installer step needs a build host where 32-bit tooling runs.
- macOS Intel is untested; Linux is unbuilt.
