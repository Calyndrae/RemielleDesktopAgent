# Remielle Desktop Agent v0.1.1

蕾米埃尔·丹 — a desktop companion that lives on your screen, not in a browser tab.

## Download

| Your computer | Download this | Then |
|---|---|---|
| **Windows — almost everyone** (Intel or AMD) | `Remielle Desktop Agent_0.1.1_x64-setup.exe` | Double-click it |
| **Windows on ARM** — only Snapdragon / Surface Pro X | `Remielle Desktop Agent_0.1.1_arm64-setup.exe` | Double-click it |
| **Mac** (Apple Silicon — M1 and newer) | `Remielle Desktop Agent_0.1.1_aarch64.dmg` | Double-click it |

No commands to type, nothing to unzip. **If you are unsure on Windows, take the
x64 one** — that is nearly every PC. To be certain: Settings → System → About →
*System type*; it says either "x64-based processor" or "ARM-based processor".

Picking the ARM one on a normal PC installs fine and then never opens, because
an Intel/AMD machine cannot run ARM programs at all.

## First run

Both platforms will warn you once, because this app is not signed by a
certificate authority yet (that costs money and an adult's identity documents —
see *Known limitations*). Clicking through the warning is a one-time thing.

**Windows**

1. Double-click the downloaded `…-setup.exe`.
2. *If* a blue "Windows protected your PC" box appears → click **More info** →
   **Run anyway**. Some machines never show it; that is normal and fine.
3. The installer runs. It never asks for an admin password, because she installs
   into your own user profile rather than for the whole computer.
4. She's in the Start Menu as **Remielle Desktop Agent**.

She has **no window and no taskbar button** — that is deliberate. What you get
is her sprite floating on the desktop, and a **tray icon** near the clock (which
Windows often hides behind the `^` arrow). If you want proof she is running,
Task Manager lists `remielle-desktop-agent.exe` at about 40 MB.

**macOS**

1. Double-click the `.dmg`, then drag **Remielle Desktop Agent** onto the
   **Applications** folder shown beside it.
2. Open Applications and double-click her. macOS says it "could not verify"
   the developer → click **Done**.
3. Open **System Settings** → **Privacy & Security**, scroll down to
   **Security**. There is a line saying she was blocked → click **Open Anyway**,
   confirm with Touch ID or your password, then **Open Anyway** once more.
4. That's it, permanently. She opens normally from now on.

Then open 设置 (Settings) and add an API key for your provider (DeepSeek, OpenAI,
Groq, Ollama, or any OpenAI-compatible endpoint). The key is stored per-user on
your machine — never sent anywhere except to the provider you chose.

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
- **Windows gets a real installer.** Double-click, Start Menu entry, proper
  uninstall — no more running a portable `.exe` out of your Downloads folder.
- Both new tools were exercised on Windows 11 against a live window, with the
  resulting geometry sampled and verified — not just API return codes.

The catalog stays enum-only: no free-form commands, paths, or URLs; no shell
tool, ever, by design.

## What she does

- Floats over your desktop, click-through everywhere except where she is
- Chat with markdown, LaTeX, and citations that carry their source's favicon
- Web search that needs no API key (Wikipedia, DuckDuckGo, GDELT, Google News)
- Presses your media keys and arranges your windows, when you ask
- Speaks unprompted now and then — she has her own voice, not a configurable one
- A small, enum-constrained tool catalog (no shell access, ever, by design)

## Known limitations

- **Not code-signed.** Hence the one-time warning above. For Windows, the
  intended fix is SignPath.io's free Foundation certificate for open-source
  projects; on macOS it needs a paid Apple Developer ID.
- On macOS, the media and window tools need Accessibility granted once; she
  walks you there on first use.
- macOS Intel is untested; Linux is unbuilt.

## Uninstalling

**Windows**: Settings → Apps → Installed apps → Remielle Desktop Agent →
Uninstall. **macOS**: drag her from Applications to the Trash.

## For people who prefer the command line

Neither is required — the downloads above do the same thing.

```powershell
irm https://raw.githubusercontent.com/Calyndrae/RemielleDesktopAgent/main/scripts/install.ps1 | iex
```
```bash
curl -fsSL https://raw.githubusercontent.com/Calyndrae/RemielleDesktopAgent/main/scripts/install.sh | sh
```

`SHA256SUMS.txt` lists the checksum of every file in this release, if you want
to verify a download yourself.

## How these were built

macOS on Apple Silicon natively; both Windows installers in a Windows 11 ARM64
VM (`scripts/win/` documents the toolchain and the provisioning script). The
x64 build is a cross-compile from that host — `--target x86_64-pc-windows-msvc`.
