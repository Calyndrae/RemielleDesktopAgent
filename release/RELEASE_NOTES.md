# Remielle Desktop Agent v0.1.3

蕾米埃尔·丹 — a desktop companion that lives on your screen, not in a browser tab.

## Download

| Your computer | Download this | Then |
|---|---|---|
| **Windows — almost everyone** (Intel or AMD) | `Remielle Desktop Agent_0.1.3_x64-setup.exe` | Double-click it |
| **Windows on ARM** — only Snapdragon / Surface Pro X | `Remielle Desktop Agent_0.1.3_arm64-setup.exe` | Double-click it |
| **Mac** (Apple Silicon — M1 and newer) | `Remielle Desktop Agent_0.1.3_aarch64.dmg` | Double-click it |

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

## What's new in 0.1.3

- **The Mac download works now.** Every previous release's `.dmg` contained an
  app with an incomplete signature, which macOS refuses with "damaged and
  should be moved to the Trash" — a hard block with no Open Anyway. If that
  happened to you: this release is the fix. Download the 0.1.3 dmg and the
  normal first-run steps below apply. (The one-line install script always
  worked, because it cleared the flag the dmg tripped.)
- **She keeps a ledger.** Settings gains 她动过什么: every change she makes to
  the machine is listed with a time and her own description. Readings are
  deliberately excluded — a list of which apps you had open all day is a
  record this app promises not to keep. Capped at 100, one clear button.
- **A summon hotkey.** Record a combination in Settings and she appears from
  anywhere, chat open — even if her display was unplugged.
- **Four more window moves**: snap to the top or bottom half, centre, and
  restore. Also fixed underneath: macOS silently ignores window sizes with
  fractional pixels, which could make snapping a no-op on some screens.
- **An uninstaller in Settings.** 把她请走: on macOS everything goes to the
  Trash (recoverable); on Windows it hands over to the real uninstaller after
  clearing stored keys. Behind a native confirmation.
- **Her tools stopped exaggerating.** Two catalog entries reported success
  without doing anything (stay-on-top, open apps); both now actually act, and
  a failure is reported as one. `open_app` gained its missing allowlist UI —
  pick applications with the system file dialog, she can open only those.
- **A language toggle** (Settings → 角色): follow the OS, 中文, or English.
  The app's own controls translate; what she says is hers. (The full English
  settings translation is still in progress — menus and core controls first.)
- Quieter reliability work: replies that die silently now say why, tools that
  hang are killed at a deadline, a virus scan no longer blocks the app for
  hours, and CI now actually builds every platform on every push.

## What's new in 0.1.2

- **"Always on top" now really stays on top of fullscreen apps on Windows.**
  Ticking it always did set the flag — the catch is that Windows keeps every
  topmost window in one band, and whichever was activated last leads it. A video
  or game going fullscreen marks itself topmost too, so it took the lead and she
  slipped behind, with nothing reporting an error. She now restates her position
  twice a second while the setting is on, and does it without stealing focus
  from whatever you are watching.

  *One limit worth knowing:* a game in true **exclusive** fullscreen bypasses the
  desktop compositor entirely, and no application can draw over that. If she
  vanishes over a game, switching it to borderless-windowed mode brings her back.

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

Easiest on either platform: her own 设置 → 把她请走, which also cleans up
stored keys and settings. Or the traditional ways — **Windows**: Settings →
Apps → Installed apps → Remielle Desktop Agent → Uninstall; **macOS**: drag
her from Applications to the Trash.

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
