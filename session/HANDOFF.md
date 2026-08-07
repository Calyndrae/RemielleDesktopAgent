# Handoff — 蕾米埃尔 AI Desktop Agent

Everything a fresh assistant needs to pick this up without re-deriving it.
Written for the Claude Code session that continues this on a Mac.

**Working tree:** `~/GIT/RemielleDesktopAgent` on the Mac. This is a **local
repository with no remote** — it was reconstructed from `RemielleDesktopAgent.zip`
rather than cloned, so it shares no history with the GitHub copy below. Anything
needing a remote (notably the Windows build via Actions) is blocked until one is
added.

**Recovery point:** commit `57d9aeb`, tag `zip-baseline` — all 220 files exactly
as the zip shipped them. `session/DELETED.md` records what was removed after it.

**Upstream, for reference:** `Calyndrae/RemielleDesktopAgent`, branch
`claude/remiel-ai-desktop-agent-btntmu`, last commit `0250e64` at packing time.
The Mac work is not pushed there.

---

## 1. What this is

A Windows-first (macOS-ready) desktop companion. **蕾米埃尔·丹 / Remielle Dan**
from 《绝区零》 floats on the desktop playing an idle animation; clicking her
opens a chat panel backed by a real LLM provider; she can run a small set of
typed tools against the machine; she does things on her own when left alone.

Non-commercial fan project. Code MIT, assets CC BY-NC-SA 4.0. See `NOTICE.md`.

### Her character, because it drives the writing

Mihoyo v3.1 (2026-07-29), S-rank, 流明/Lumen attribute, 「虚狩·流明错时」.
狡黠戏谑, 信守承诺, 对无辜者心怀柔软; sweet and unflappable, closes distance
quickly but keeps a deliberate margin; a thread of melancholy from being
temporally displaced. Second person, light teasing, occasional 「呢~」, never
fawning, gives the answer but leaves a little in reserve. On errors she is
wry, not apologetic.

**Every user-facing string in the app is written in this voice.** The persona
itself is `DEFAULT_SYSTEM_PROMPT` in `src/state/config.ts` — four lines, editable
in Settings, with a "restore default". `assets/persona/` is an empty placeholder
already wired into `bundle.resources`, kept for the day the persona outgrows a
string literal and wants swappable files; there is nothing in it today.

---

## 2. Build and run

```bash
pnpm install
pnpm tauri dev          # run it
pnpm test               # 78 frontend tests
pnpm typecheck
pnpm layout:check       # Playwright layout regression on the chat panel
pnpm demo               # browser demo of the real components (no Tauri)
pnpm demo:build         # → demo-standalone.html, one self-contained file

cd src-tauri
cargo test              # 157 tests
cargo clippy --all-targets
cargo fmt --check
```

### Producing installers

**The macOS binary now exists; the Windows one still does not.** Tauri bundles
against the host's own webview and packager, so there is no cross-compile:
Windows needs Windows, macOS needs macOS. The Mac half was built on 2026-08-07
(§4.1) and lives in `program/macos/`. The Windows half needs either a Windows
machine or `.github/workflows/build.yml`, which in turn needs a git remote this
repository does not have.

| Target | Command | Output |
|---|---|---|
| Windows | `pnpm tauri build` on Windows | `src-tauri/target/release/bundle/nsis/*.exe` |
| macOS | `pnpm tauri build` on macOS | `src-tauri/target/release/bundle/{macos/*.app,dmg/*.dmg}` |

`bundle.targets` is `["nsis", "app", "dmg"]`; Tauri skips whichever do not
apply to the host, so the same command is right on both.

**Before the first macOS build:** run `pnpm tauri icon src-tauri/icons/icon.png`
to generate `icon.icns`. It is deliberately not checked in and deliberately not
listed in `bundle.icon` — naming a file that is not there fails the bundle on
*every* platform, not just the one that wanted it.

**For Windows without a Windows machine:** `.github/workflows/build.yml` builds
both platforms on GitHub's runners (`windows-latest`, and `macos-latest` twice
for Apple Silicon and Intel) and uploads the installers as artifacts. Trigger it
from the Actions tab or by pushing a `v*` tag. It has never been executed —
it is written and its YAML parses, nothing more. Expect to fix something on the
first run.

Neither platform is code-signed. Windows shows a SmartScreen warning; macOS
needs a right-click → Open, or `xattr -dr com.apple.quarantine`. Signing costs
money and is §9.2.

---

## 3. Architecture, and the decisions that are load-bearing

### One transparent overlay window, not two

The close animation requires the panel to fly along a parabola and vanish
*behind* the character. Cross-window z-order cannot do that reliably and the
two would not share a transform space. So the character and the panel live in
one frameless transparent always-on-top window sized to the monitor work area.
`z-index`: panel 5, sprite 10, menus 20, fault panel 30.

### Click-through is the highest-risk piece, and it is solved in Rust

The window ignores cursor events by default so you can click your desktop
through it. **A window that ignores the cursor receives no `mousemove`**, so
the webview can never notice the cursor arriving on an opaque pixel — the
obvious two-stage design is circular and does not work.

So: the frontend computes a 48×48 alpha mask from the current animation frame
and ships it to Rust with the sprite's screen rect; Rust polls the OS cursor at
60 Hz (`GetCursorPos` on Windows, `AppHandle::cursor_position` elsewhere), does
the hit test itself, and toggles `set_ignore_cursor_events`.
See `src-tauri/src/window/passthrough.rs`.

**Gotcha already hit:** calling `set_ignore_cursor_events(true)` in `setup()`
panics under an unrealized GTK widget. It must run *after* `window.show()` —
it lives in `overlay_ready()`.

### The API key never enters JavaScript

Stored in the OS credential store (`keyring` → DPAPI on Windows, Keychain on
macOS). There is **no `getKey` command** — only `store_key`, `has_key`,
`delete_key`, `key_hint` (masked). All HTTP happens in Rust. Do not add a way
to read it back.

### No shell tool, ever

`src-tauri/src/tools/mod.rs` opens with why. The model never composes a
command; it picks a named tool from a fixed catalog and fills **enum-constrained**
parameters. `src-tauri/src/tools/system.rs` matches those validated enums
against *complete compile-time literals* — there is no code path that builds an
argument list out of model output. A test,
`the_catalog_contains_no_free_form_execution`, fails the build if any tool ever
takes free text.

This matters because the user runs weak models (Gemini Flash, DeepSeek). The
design has to be safe against *incompetence*, not just malice.

---

## 4. What is built

| Area | State |
|---|---|
| Transparent overlay, click-through, spring drag, wheel zoom, right-click menu | done |
| Chat panel: placement, open/close parabolic flight with squash & stretch | done |
| Streaming: SSE, `<think>` extraction, reasoning, usage, citations | done |
| Providers: OpenAI / DeepSeek / Grok / OpenRouter / Ollama / Gemini / custom | done |
| Key onboarding: format check, live verification, credential storage | done |
| Settings window: provider, key, model, temperature, persona, tools, ambient, history, size, theme | done |
| Tool loop: schemas → call → validate → execute → results → next round | done |
| Confirm-tier round trip (oneshot → UI → answer) | done |
| Local history: save last session, resume chip, delete-on-disable | done |
| Export: Markdown / JSON / handoff-to-another-assistant | done |
| Ambient: schedule, quiet hours, daily cap, "not today", doze after 12 min | done |
| Assets: all 7 animations + registration offsets, sizes read from the files | done |
| Light + dark panel themes, both opaque, both WCAG AA verified | done |
| macOS: bundle targets, accessory policy, osascript tools | **built and launched on a Mac** — see §4.1 |
| CI: test suites on push, installer build for Windows + both Macs | **never executed** |

**157 Rust tests, 78 frontend tests, clippy clean, rustfmt clean.**
All of that now verified on `aarch64-apple-darwin`, not only on Linux.

### 4.1 The macOS build, 2026-08-07

First time this project produced a binary on any platform. `pnpm tauri build`
on an Apple Silicon Mac, Rust 1.96, Command Line Tools only — no full Xcode
needed. Output is a `.app` and a `.dmg`, collected in `program/macos/`.

Confirmed by running it:

- **Transparency works.** The wallpaper reads through the space around her; no
  opaque rectangle. `macOSPrivateApi` is doing its job.
- **She is an accessory process.** `lsappinfo` reports
  `ApplicationType="UIElement"`: no Dock icon, no menu bar, absent from ⌘-Tab.
  This took a code change — see bug 13 below.
- **Resources bundle correctly.** All seven animations, `pack.json` and the
  persona directory are present under `Contents/Resources/`.

Still unverified: **click-through**. Whether a click on the empty space around
her reaches the desktop underneath has not been exercised end-to-end on macOS.
The hit-test logic has unit tests and the Rust path uses
`AppHandle::cursor_position` off Windows, but nobody has clicked a desktop icon
through her yet. Do this before believing the platform is done.

The build is ad-hoc signed (linker signature only). Built locally it launches
without complaint because it never receives a quarantine attribute; copied to
another machine it will need `xattr -dr com.apple.quarantine`.

---

## 5. What is NOT built — start here

Ordered by what actually unblocks daily use.

### 5.1 Shippability (highest value, nothing depends on it)

- **Tray icon.** There is none. The only quit path is her right-click menu, so
  if she is ever hidden she is unreachable. `tray-icon` is already a Tauri
  feature in `Cargo.toml` and unused.
- **Run at login.** `tauri-plugin-autostart` is a dependency and unwired.
- **Fullscreen game auto-hide.** `src-tauri/src/platform/windows.rs` has the
  foreground-window detection; nothing calls it. The user plays 绝区零 and
  explicitly wants her to get out of the way.
- **Multi-monitor / DPI.** `onScaleChanged` re-places the overlay, but nothing
  handles a monitor being unplugged — she can end up anchored off-screen.
- **A green CI run.** The two workflows exist but have never run once. Getting
  `check.yml` green is quick and tells you the Linux dependency list is right;
  getting `build.yml` green is what actually produces the Windows installer.

### 5.2 The proactive-greeting branch is a deliberate stub

`src/overlay/useAmbient.ts` picks `emote` or `greeting`; **both currently just
change the pose**, and the comment says so. Finishing it needs: a narration box
component, a generated line (time of day, idle duration, active app), and a
"今天别再打扰我" button wired to `useAmbientStore.muteForToday()` — which
already exists and is tested.

Do not ship a hardcoded greeting. The whole point is that it is hers.

### 5.3 Slash command palette

`/emote change <name>` with **hover-preview at the character's position** —
the assets are in now, so the preview has something real to show. Also
`/tools`, `/model`, `/new`, `/save`, `/help`. Nothing exists yet.

### 5.4 Agentic search for providers without native search

DeepSeek and most OpenAI-compatible servers have no built-in web search. The
plan the user designed: AI emits a query → app searches → **hands the result
list back to the AI to pick links** → app fetches and extracts → answers.
Needs a Google Programmable Search key, which **the user must obtain**.

### 5.5 Context profile

An "about you" local file (name, timezone, preferences) injected into each new
chat, with per-field toggles and a **live preview of exactly what gets sent**.
This matters more than usual because sessions are short.

---

## 6. Bugs already found and fixed — do not reintroduce

Each of these cost real time. They are all in commit messages too.

1. **SSE:** a `\r\n` split across two chunks read as two terminators, cutting
   events short. The decoder holds back a trailing lone `\r`.
2. **Tool calls:** arguments are a JSON string split across chunks. Nothing may
   be parsed until the run ends; `index` is the identity, not `id`; later
   fragments repeat fields as empty strings and must not erase what arrived.
3. **Noto Serif SC is a variable font.** Requesting `wght@400;600` returns the
   same file twice and 600 renders as fake-bold. Request `wght@200..900`.
4. **Google's subset URL index is not unique.** Deriving filenames from it
   silently overwrites subsets. Use a counter plus an assertion.
5. **Demo inliner:** splitting the stylesheet on `@font-face` discards the app's
   own CSS (it lives before the first rule and after the last).
6. **Minified CSS drops the final `;`** — a `unicode-range:([^;]+);` regex
   matches nothing and every subset is silently skipped.
7. **Frames are not all the same size** (257×278 … 302×298) and the offsets
   assume natural size. `object-fit: contain` gives each animation a different
   scale factor — she changes size on every state change.
8. **`ch` is the wrong unit for CJK.** It measures a Latin "0"; a `34ch` cap
   holds ~17 Han glyphs.
9. **Settings is a separate webview.** Nothing propagated changes until
   `src/state/sync.ts` existed — every setting saved correctly and did nothing.
10. **`.menu__item { color: inherit }`** picked up a host page's `body` colour
    and rendered labels near-black on the dark menu. Self-contained surfaces set
    their own text colour.
11. **Gemini `functionCall` parts carry no text**, so a `let Some(text) = … else
    { continue }` guard skipped them entirely. Read the call before the guard.
12. **Gemini rejects `google_search` alongside `functionDeclarations`.** It is a
    genuine either/or; web search wins when enabled.

The next two were found on the first Mac this ever ran on. Both were invisible
on Linux — not by coincidence, but because Linux is the one platform where the
wrong behaviour and the right behaviour look identical.

13. **`LSUIElement` in `Info.plist` does not survive startup.** She launched
    with a menu bar, a Dock icon and a place in ⌘-Tab, on a bundle whose plist
    plainly said `LSUIElement => true`. The plist only chooses the policy Cocoa
    *starts* with; tao then calls `setActivationPolicy(Regular)` while building
    the `NSApplication`, after the plist has been read, and the later call wins.
    Fixed by calling `app.set_activation_policy(ActivationPolicy::Accessory)` in
    `setup()`, which runs after tao. **Keep the plist as well** — it governs the
    window between process start and that line, so removing it flashes a Dock
    icon on every launch. Diagnose with
    `lsappinfo info -only ApplicationType "Remielle Desktop Agent"`; it should
    say `UIElement`, not `Foreground`.
14. **A test can pass by being vacuously true on the host that wrote it.**
    `disabled_tools_are_not_offered_to_the_model` enabled `set_system_theme` and
    expected it back only under `target_os = "windows"`. Correct when that tool
    was `Platform::Windows`; stale once it gained a macOS implementation and
    became `Platform::Desktop`. On Linux both sides of the comparison are `0`, so
    it passed here and could only ever fail on a Mac. The lesson generalises:
    **a platform-conditional assertion evaluated on a third platform proves
    nothing.** Prefer a `Platform::Any` fixture and let the dedicated platform
    test carry the gating.

---

## 7. Design rules the UI is built on

Breaking these will make it look wrong in ways that are hard to name.

- **The accent is spent exactly twice**: the send button fill and the agent
  mark. Not the title, not the caret, not the scrollbar. A focus border at 45%
  is the deliberate limit.
- **Neutrals are cool** so the warm pink reads as light against cold shadow —
  which is also the right image for 「流明错时」.
- **Radius scale 8 / 14 / 16**, plus 999 for pills and 50% for circles. A
  container is never rounded less than what sits inside it.
- **Both themes are opaque.** No `backdrop-filter` anywhere. Translucency picks
  up the wallpaper and looks grubby — it is the AI-slop default.
- **No emoji anywhere in the UI.** All icons are inline SVG in
  `src/overlay/chat/icons.tsx`.
- **Font is Noto Serif SC**, vendored as ~100 unicode-range subsets.
- **Turn spacing is 6 / 10 / 14 / 18 / 24 via adjacent-sibling margins**, not
  `gap` — the rhythm is asymmetric and `gap` cannot express that.
- **`cursor: default` on buttons** is deliberate: native desktop feel.
- **Every flex child with text gets `min-width: 0`** and every text surface
  `overflow-wrap: anywhere`.
- Contrast was **measured**, not eyeballed. Both themes clear WCAG AA. There is
  a script pattern for this in the git history if you need to re-check.

---

## 8. Things the user has said that are standing constraints

- Tools must be **easy for a weak model to use**; letting it run a shell would
  be dangerous. (This is why the catalog exists.)
- **Do not copy the reference screenshots** — use them as structure only.
- **No pure emoji in the UI.**
- **She must not sit in a "working" pose while idle** — the drawing animations
  mean "writing you a reply".
- **Panels must not be transparent** — that is what AI-slop UIs do.
- UI must be **functional**, not merely good-looking.
- Consider what the user *feels*: hierarchy, alignment, contrast, colour.

---

## 9. Outstanding decisions for the user

1. **Google Programmable Search key** — needed only for §5.4.
2. **Whether to sign the macOS build.** Unsigned means Gatekeeper warnings.
3. Whether to publish releases from CI or build locally.
