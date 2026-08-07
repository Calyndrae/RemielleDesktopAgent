# Start here

This is 蕾米埃尔 AI Desktop Agent, packed up to move to your Mac.

## Read this part first, because it changes what you expect to find

**There is no `.exe` and no `.app` in this zip.** Not an oversight — the session
that built this ran in a Linux container, and Tauri bundles an app against the
host machine's own webview and packager. A Windows installer has to be built on
Windows; a macOS app has to be built on macOS. There is no cross-compile, so
neither binary could be produced there, and I am not going to claim otherwise.

What is here instead is everything needed to produce both, and the two things
that are usually the hard part are already done:

- The platform configuration is complete for both. `bundle.targets` is
  `["nsis", "app", "dmg"]`, the macOS side has `LSUIElement` and a minimum
  system version, and the system tools have real macOS implementations rather
  than Windows-only stubs.
- `.github/workflows/build.yml` builds **both** installers on GitHub's runners
  and uploads them. That is your route to a Windows `.exe` without owning a
  Windows machine — push the branch, open the Actions tab, run *Build
  installers*, download the artifact.

## What to do

1. Open this folder in Claude Code on the Mac.
2. Paste the contents of **`PROMPT-FOR-NEW-SESSION.md`** as the first message.
   It tells the new session to read the handoff, reorganise the tree the way you
   asked, and build for real.

That's it. Everything else it needs, it reads.

## What is in here

| | |
|---|---|
| `HANDOFF.md` | The memory. Architecture, the decisions that are load-bearing and why, what is built, what is not, the twelve bugs already found and fixed, the design rules. Written for the next assistant, but readable. |
| `PROMPT-FOR-NEW-SESSION.md` | The message to paste. |
| `demo-standalone.html` | The chat panel as a single self-contained file. Double-click it — no build, no install, no network. Real components with fake data, so you can look at the light and dark themes and click through the menus right now. |
| `src/`, `src-tauri/`, `assets/` | The application: React frontend, Rust backend, and her animation pack with the registration offsets. |
| `.github/workflows/` | `check.yml` runs the test suites on every push; `build.yml` produces the installers. |
| `NOTICE.md` | The attribution chain. Code is MIT, assets are CC BY-NC-SA 4.0, and this is a non-commercial fan project — that last part is a licence condition, not a disclaimer. |

`node_modules/` and the Rust build directory are not included; `pnpm install`
restores the first and the first build restores the second.

## State at the time of packing

157 Rust tests, 78 frontend tests, `cargo clippy` clean, `cargo fmt` clean,
`pnpm typecheck` clean, the Playwright layout check passing, and the production
frontend build succeeding. Every one of those was run, not assumed.

The branch is `claude/remiel-ai-desktop-agent-btntmu` and everything in this zip
is pushed to it, so the zip and the repo agree.
