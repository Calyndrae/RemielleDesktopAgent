# Windows

All Windows program data, executables and installers live here.

**This folder is currently empty of artefacts, and that is not an oversight.**
Tauri bundles against the host's own webview and packager, so there is no
cross-compile: a Windows `.exe` has to be produced on Windows. The Mac this was
built on can produce the macOS half and nothing more.

## What lands in this folder

| | |
|---|---|
| `Remielle Desktop Agent_0.1.0_x64-setup.exe` | The NSIS installer. `installMode` is `currentUser`, so it needs no administrator rights. |

Gitignored, like the macOS artefacts — see `session/DELETED.md`.

## Getting one

### On a Windows machine

```bash
pnpm install
pnpm tauri icon src-tauri/icons/icon.png
pnpm tauri build
```

Output at `src-tauri/target/release/bundle/nsis/*.exe`. Copy it here.

### Without a Windows machine

`.github/workflows/build.yml` builds it on a `windows-latest` runner and uploads
it as an artifact named `remielle-windows-x64`. It needs a GitHub remote, which
this repository does not currently have — it is local-only.

**The workflow has never been executed.** Its YAML parses and nothing more.
Treat the first run as unproven and read the job log rather than assuming it
works; `check.yml` is the cheaper one to get green first.

## Signing

Not signed. SmartScreen will warn on first run until the binary builds
reputation or a certificate is bought. Open decision in `session/HANDOFF.md` §9.

## Windows-specific behaviour that has never been run

These are implemented and unit-tested but have not been exercised on real
Windows, so treat them as unproven rather than working:

- Click-through hit testing uses `GetCursorPos` on Windows, against
  `AppHandle::cursor_position` elsewhere.
- API keys go to the Credential Manager via DPAPI, against Keychain on macOS.
- `security_scan` is `Platform::Windows` and is never offered on a Mac —
  Defender has no macOS equivalent worth faking.
- `src-tauri/src/platform/windows.rs` has foreground-window detection for
  hiding her over fullscreen games. Nothing calls it yet.

One macOS-driven fix in this tree is worth knowing about if you are chasing
Windows behaviour: the activation policy is now set explicitly in
`src-tauri/src/lib.rs`, guarded by `#[cfg(target_os = "macos")]`. It does not
affect the Windows build, where `skipTaskbar` already does that job.
