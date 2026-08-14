# Remielle Desktop Agent v0.1.1

蕾米埃尔·丹 — a desktop companion that lives on your screen, not in a browser tab.

## What's new in 0.1.1

- **She can work the music now.** A `media_control` tool: play/pause, next,
  previous, volume up/down, mute — the system media keys, pressed for you.
  On macOS this needs Accessibility; if it isn't granted she opens the right
  System Settings pane herself and tells you what to tick.
- **She can move the window you're looking at.** An `arrange_window` tool:
  minimize, maximize, snap left, snap right — always the *frontmost* window,
  never one she names herself, and there is deliberately no way to close
  anything. Fullscreen windows on macOS are refused politely instead of
  silently mangled.
- **The tool list reads as what she can touch.** Settings now groups her
  toolkit by domain — 她自己 / 这台电脑 / 正在放的东西 / 你眼前的窗口 / 别的应用 —
  instead of one flat list.
- Both new tools were exercised on Windows 11 against a live window, with the
  resulting geometry sampled and verified — not just API return codes.

The catalog stays enum-only: no free-form commands, paths, or URLs; no shell
tool, ever, by design.

## Install in one line

**Windows** (PowerShell — picks x64 or ARM64 for you, verifies the checksum,
adds a Start Menu entry):

```powershell
irm https://raw.githubusercontent.com/Calyndrae/RemielleDesktopAgent/main/scripts/install.ps1 | iex
```

**macOS** (Apple Silicon — installs to /Applications and clears the quarantine
flag, so she opens without the right-click dance):

```bash
curl -fsSL https://raw.githubusercontent.com/Calyndrae/RemielleDesktopAgent/main/scripts/install.sh | sh
```

Or download a file directly:

| File | Platform | Notes |
|---|---|---|
| `Remielle Desktop Agent_0.1.1_aarch64.dmg` | macOS (Apple Silicon) | Installer. Unsigned — see below. |
| `Remielle Desktop Agent_0.1.1_x64.exe` | Windows 10/11 (Intel/AMD) | Portable executable — no install, just run. **Most people want this one.** |
| `Remielle Desktop Agent_0.1.1_arm64.exe` | Windows on ARM | Portable executable. |

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
- Presses your media keys and arranges your windows, when you ask
- Speaks unprompted now and then — she has her own voice, not a configurable one
- A small, enum-constrained tool catalog (no shell access, ever, by design)

## Known limitations

- **Not code-signed.** Both platforms warn on first launch. For Windows, the
  intended fix is SignPath.io's free Foundation certificate for open-source
  projects (requires a public repo and maintainer application).
- **No Windows installer yet.** The `.exe` files are portable; the NSIS
  installer step needs a build host where 32-bit tooling runs.
- On macOS, the media and window tools need Accessibility granted once; she
  walks you there on first use.
- macOS Intel is untested; Linux is unbuilt.

## Verifying your download

`SHA256SUMS.txt` lists the checksum of every file here.

```bash
shasum -a 256 -c SHA256SUMS.txt     # macOS / Linux
```
```powershell
Get-FileHash "Remielle Desktop Agent_0.1.1_x64.exe" -Algorithm SHA256   # Windows
```

## How these were built

macOS on Apple Silicon natively; both Windows binaries in a Windows 11 ARM64 VM
(`scripts/win/` documents the toolchain and the provisioning script). The x64
build is a cross-compile from that host — `--target x86_64-pc-windows-msvc`.
