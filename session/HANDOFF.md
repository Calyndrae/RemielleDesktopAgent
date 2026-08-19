# Handoff — 蕾米埃尔 AI Desktop Agent

Everything a fresh assistant needs to pick this up without re-deriving it.
Written for the Claude Code session that continues this on a Mac.

**Working tree:** `~/GIT/RemielleDesktopAgent` on the Mac, pushed to
`github.com/Calyndrae/RemielleDesktopAgent` (force-pushed over the old copy on
2026-08-12; three releases live there). The "local repository with no remote"
era this paragraph used to describe is over — CI runs on every push, and §12
records the day it was discovered to have been failing silently.

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

Two things remain unverified on macOS, both for the same reason — the session's
input tooling refuses to click the regions involved, so nobody has *actually*
done it:

- **Click-through.** Whether a click on the empty space around her reaches the
  desktop underneath. The hit-test logic has unit tests and the Rust path uses
  `AppHandle::cursor_position` off Windows, but no desktop icon has been clicked
  through her. Do this before believing the platform is done.
- **The tray menu's items.** The icon is confirmed in the menu bar and rendered
  in colour rather than flattened to a template silhouette. Show/hide, come back
  on screen, settings and quit compile and are unit-tested at the label level,
  but none has been clicked.
- **The run-at-login toggle.** No login item has been observed being written.
  Check for `~/Library/LaunchAgents/com.calyndrae.remielle-desktop-agent.plist`
  after flipping it.

All three are seconds of manual checking for anyone sitting at the machine.

**An agent cannot do them for you, and the reason is structural.** The accessory
policy from bug 13 is what removes her from the Dock and ⌘-Tab — and it also
removes her from the application list that screen-automation tooling resolves
names against. `request_access` finds her by neither display name nor bundle id,
because as far as the window server is concerned she is not an app you can
switch to. That is the behaviour we wanted; it just also means no agent can put
a click into her. Nothing binds a global shortcut either
(`tauri-plugin-global-shortcut` is initialised and never used), so there is no
keyboard path in as a fallback.

What an agent *can* do is read the log, which is why the logging exists. The
practical loop is: a person sends one message, the agent reads
`~/Library/Logs/com.calyndrae.remielle-desktop-agent/`.

The obstacle was the same each time and is worth recording so the next session
does not waste an hour on it: the agent tooling used here refuses to synthesise
a click unless it can attribute the target point to an allowlisted application,
and on this machine it resolved *every* point on the desktop — her sprite, the
Finder window beneath her, desktop icons, the menu-bar extras — to the Dock or
Control Center. It did so with the app fully quit, so it is a property of the
tooling and says nothing about the overlay. A human at the keyboard has no such
problem.

The build is ad-hoc signed (linker signature only). Built locally it launches
without complaint because it never receives a quarantine attribute; copied to
another machine it will need `xattr -dr com.apple.quarantine`.

---

## 5. What is NOT built — start here

Ordered by what actually unblocks daily use.

### 5.1 Shippability (highest value, nothing depends on it)

- ~~**Tray icon.**~~ **Done.** `src-tauri/src/window/tray.rs`: show/hide, come
  back on screen, settings, quit. Installed in `setup()` before anything that
  can fail, so it works even if the webview never loads. This also unblocked the
  "hide" item in her right-click menu, which had been written and deliberately
  withheld. Confirmed present in the macOS menu bar; **the menu items themselves
  have not been clicked** — see §4.1.
- ~~**Multi-monitor / DPI.**~~ **Done for the unplug case.** A stranding check
  rides the passthrough poller every ~2 s and re-places the overlay when its
  rect overlaps no connected display. Deliberately permissive — one overlapping
  pixel counts as on-screen, because recovery moves the user's window and a
  false positive is worse than a false negative. The tray's "come back on
  screen" is the manual escape hatch for everything subtler. Six unit tests in
  `window::overlay::tests`. Not covered: a display that changes *resolution*
  rather than disappearing.
- ~~**Run at login.**~~ **Done.** `src/lib/autostart.ts`, toggled from Settings.
  Deliberately *not* in the config store — the registry key and the
  `LaunchAgent` plist belong to the OS and can be removed from System Settings
  without this app knowing, so a stored copy would go stale and lie. Nothing is
  persisted; the OS is asked on open and again after every write, and
  `setAutostart` returns the re-read state rather than the requested one so a
  refused write cannot show as a ticked box. Seven tests. **The toggle has not
  been clicked** — see §4.1.
- **Fullscreen game auto-hide.** **The previous note here was wrong**, and it
  understated the work: `src-tauri/src/platform/windows.rs` contains exactly one
  function, `cursor_position`. There is no foreground-window detection anywhere
  to wire up — this is a feature to write, not a call to add. Note also that
  绝区零 has no native macOS build, so this is Windows-only value.
- **A green CI run.** The two workflows exist but have never run once. Getting
  `check.yml` green is quick and tells you the Linux dependency list is right;
  getting `build.yml` green is what actually produces the Windows installer.
  **Blocked:** the working tree is local with no remote (see the header).

### 5.2 The proactive-greeting branch is a deliberate stub

`src/overlay/useAmbient.ts` picks `emote` or `greeting`; **both currently just
change the pose**, and the comment says so. Finishing it needs: a narration box
component, a generated line (time of day, idle duration, active app), and a
"今天别再打扰我" button wired to `useAmbientStore.muteForToday()` — which
already exists and is tested.

Do not ship a hardcoded greeting. The whole point is that it is hers.

### ~~5.3 Slash command palette~~ — done, 2026-08-10

`/emote` with hover-preview lives in the composer: "/" turns the draft into a
command line, hovering a pose plays it on the real sprite at her position, and
closing without committing restores what she was doing. Also `/model`, `/new`,
`/save`, `/help`. `/tools` was dropped — the tool switches are consent, and
consent lives in Settings, not in a place a stray keystroke can reach.

### ~~5.4 Agentic search~~ — done, then rebuilt, 2026-08-10

Shipped first as two model-driven catalog tools and failed its first real use
three ways at once (see the commit "Search the way CyreneExtension does it").
Now: a router call decides if the message needs the web and compresses it to a
query, the app searches keyless backends (Wikipedia, DuckDuckGo IA, GDELT +
Google News RSS for news), and results are injected as context with a citation
rule. No second API key required; a Google Programmable Search key is an
optional full-web upgrade that is verified at save time and falls back to the
builtin path on failure. The model never drives search tools — that is the
lesson, and the reference implementation was the user's own CyreneExtension.

### ~~5.5 Context profile~~ — done, 2026-08-10

设置 → 角色 → 关于你: call-me, timezone (derived, never typed) and a capped
free-text field, each behind its own toggle, composed fresh at send time and
appended to the system prompt. The settings screen shows the exact block that
will be sent — the same `composeProfileBlock` output, byte for byte — or an
explicit "现在这一节什么都不会发送。" A filled field with its toggle off sends
nothing: the toggle is the consent, not the text box.

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
15. **macOS stamps a window's Space eligibility at creation, using the app's
    activation policy at that instant — and no later write undoes it.** The
    overlay had level 25, `CanJoinAllSpaces | FullScreenAuxiliary` (readback
    `0x151`), an accessory process… and `kCGWindowIsOnscreen` still went false
    whenever any fullscreen Space was active, because the window was born from
    `tauri.conf.json` in the gap where tao's `setActivationPolicy(Regular)`
    (bug 13) was in force. Re-setting the policy, re-setting the flags, and
    re-ordering the shown window all read back correctly and change nothing.
    Fixed by creating the overlay in `setup()` *after* the accessory line —
    the config's `windows` array is deliberately empty; do not put her back.
    Proven both directions with minimal AppKit harnesses: identical flags
    composite over a fullscreen Space when created accessory, and never do
    when created regular-then-switched. Verify with a self-made fullscreen
    Space (`toggleFullScreen` harness) — swiping by hand is not scriptable
    without Accessibility.
16. **A binary from plain `cargo build --release` boots to a blank webview.**
    Release asset embedding is behind the `custom-protocol` feature, which the
    tauri CLI passes and bare cargo does not; without it the app silently waits
    on `devUrl` (localhost:1420) forever — window at default 800×600, no log
    lines at all. For binary-swap debugging, build with
    `cargo build --release --features custom-protocol`.

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

## Signing (local, 2026-08-11)

Every build is now signed with **"Remielle Local Signing"** — a self-signed
code-signing certificate in the login keychain — via `scripts/sign-macos.sh`
(run it on the bundled .app after `tauri build`; it is a quiet no-op on
machines without the identity). The point is the Keychain: ACLs key on the
designated requirement, which for ad-hoc signatures changes every build
(→ password prompt per stored key per rebuild), and with this identity is
`identifier "com.calyndrae.remielle-desktop-agent" and certificate leaf =
H"fe409f80…"` — verified byte-identical across consecutive rebuilds. One
始终允许, ever.

To recreate on a new machine: openssl req -x509 with
`keyUsage=digitalSignature, extendedKeyUsage=codeSigning` (CN must be
"Remielle Local Signing"), export p12, `security import … -T
/usr/bin/codesign`, `security add-trusted-cert -p codeSign`. This is NOT
distribution signing — Gatekeeper on other machines still warns; that is
still §9's Apple-Developer decision.

---

## 10. State as of 2026-08-12 (post-§5 era)

Everything in §5 shipped, then two days of user-reported fixes reshaped core
plumbing. The commits tell the story; the short version:

- **Search** is Cyrene-style preflight (router → keyless backends → numbered
  citations). The router and the ambient greeting both needed *large*
  max_tokens (400/600) because deepseek-v4-flash reasons inside the budget and
  returns empty content when starved. This failure mode looks like "feature
  silently does nothing" — check it FIRST for any new model-driven feature.
- **Replies render** markdown + KaTeX (Prose.tsx); citations are favicon chips
  by number; remark-cjk-friendly handles CJK emphasis; single-$ math only when
  the body looks like TeX. The "transcript void" (phantom scrollHeight,
  WKWebView-only, correlates with display math) is NOT fixed — a witness in
  ChatPanel.tsx logs per-block forensics to the app log when it recurs.
- **Her voice lives in Rust** (`VOICE` beside `IDENTITY` in llm/mod.rs). The
  editable prompt field is extra instructions only; the old voice-as-default
  text migrates to empty (config.ts migrateSystemPrompt).
- **macOS keys: the Keychain is gone.** keys.json (0600) in the app data dir,
  in-process cache, legacy migration on first read. Zero prompts across
  rebuilds — the user had clicked 始终允许 30+ times, which was the design
  review. Windows keeps DPAPI keyring. secrets.rs docs carry the reasoning.
- **macOS builds are signed** with the local cert "Remielle Local Signing" via
  scripts/sign-macos.sh after every build (ad-hoc CDHash churn was breaking
  everything that keyed on the signature).
- **She greets at boot** (~90s, useAmbient.ts opening-line effect) and the
  ambient path logs spoke/failed/skipped to the app log via frontend_note.
- **Windows builds exist.** Both architectures compiled in the UTM VM on
  2026-08-12 and are in `program/windows/` + `release/`: x64 (0x8664, 11.6 MB)
  and ARM64 (0xaa64, 11.3 MB), both verified PE. The Rust backend — DPAPI
  keyring, Win32 cursor/foreground-window calls, platform dispatch — needed no
  code changes. `scripts/win/` has the provisioning script and runbook.

  Hard-won lessons, because every one of these cost an hour:
  1. **Nothing remote survives this network.** rust-lang.org, nodejs.org,
     rsproxy.cn, GitHub — all flap through the user's tunnel. Everything is
     staged on the Mac and served at 192.168.64.1:8765: the Rust dist mirror
     (rewrite channel-rust-stable.toml's URLs + regenerate its .sha256),
     node's ZIP (the MSI fails silently under the guest agent), the pnpm
     store, the cargo registry (keyed to plain crates.io, so do NOT point the
     guest at a mirror), and NSIS.
  2. **node_modules must be built on the Mac with `node-linker=hoisted` and
     `symlink=false`**, plus `pnpm.supportedArchitectures` in package.json
     (NOT .npmrc — pnpm ignores it there). Symlinked stores lose the win32
     native binaries; hoisted ships them as real files.
  3. **The guest agent kills long child processes when its RPC wedges**, which
     silently truncates tar extractions. Run anything slow as a scheduled task
     (`schtasks /create /ru SYSTEM ... & schtasks /run`) with a file marker.
  4. **cmd's `if exist` chokes on paths containing `@`** — it reports missing
     files that are present. Use PowerShell `Test-Path` for node_modules.
  5. **PowerShell's `-Encoding utf8` writes a BOM**, which Tauri's config
     parser rejects ("expected value at line 1 column 1"). Author JSON on the
     Mac and ship it.
  6. `pnpm build` fails in the guest (`'tsc' is not recognized`) because the
     Mac-built .bin has no Windows shims. Blank `beforeBuildCommand` and run
     `node node_modules/vite/bin/vite.js build` then the tauri CLI directly.

- **The Windows build has been RUN** (2026-08-13, in the VM): launches, renders
  the sprite with a transparent background, and click-through works — a File
  Explorer window behind her stayed fully usable. Process stable at ~40 MB.
  Screenshot evidence was taken; no crash, no missing-DLL dialog, no WebView2
  prompt. Not yet exercised on Windows: chat round-trip, tray menu, settings
  window, DPAPI key storage.

- **Not done on Windows**: the NSIS installer (makensis is 32-bit x86 and this
  ARM VM's emulation fails under SYSTEM — needs an x64 Windows host, or run
  the bundle step interactively) and code signing.
- **Pending**: the transcript void (witness armed); §9 real signing decision
  (the local cert fixes dev, not distribution); Windows build artefacts to
  land in program/windows once the VM builds.

Watch the disk: the VM's qcow2 is ~29GB and src-tauri/target regrows to ~6GB
per full build. The two do not fit comfortably at the same time on this Mac.

## 11. media_control + arrange_window verified on Windows (2026-08-13)

The tooltest example ran in the VM's interactive session against a real
Notepad window. All eight actions passed, with geometry proven, not assumed:

- `snap_right`: sampled `GetWindowRect` = 570→1140 on a 1140-wide work area —
  the exact right half. This validates the shared `work_area` split arithmetic
  that `snap_left` also uses.
- `maximize`: rect −7,−7→1148,675 — the canonical maximize border-overhang.
- `minimize`: `IsIconic` returned True AND the −32000-style minimized rect
  (scaled to −21333 by the VM's 150% DPI) appeared in samples.
- All four media keys (`volume_up/down`, `play_pause`×2) injected OK via
  `SendInput` in the interactive session.

Three build failures on the way, each a lesson:

1. **The guest's offline cargo cache goes stale when Cargo.toml grows.** New
   deps (objc2-core-graphics → objc2-metal) exist in the lockfile but not in
   the VM's registry index → "no matching package" even though the crates are
   macOS-only. Fix: tar the Mac's `registry/index/.cache` + the new `.crate`
   files, extract over the guest's cargo registry (see `cargo-delta` pattern).
2. **The guest C: is 39GB with CompactOS compression ON.** Logical sizes lie:
   `Get-ChildItem` sums exceed the volume. Deleting "5.3GB" of Windows Update
   cache (`rd /s /q C:\Windows\SoftwareDistribution\Download` after stopping
   wuauserv/bits) freed under 1GB physical. Plan disk moves in physical terms
   (`(Get-PSDrive C).Free`) and expect Windows itself to eat ~33GB logical.
3. **Embedded double quotes NEVER survive the UTM `execute` → cmd argv
   rebuild** (they arrive backslash-escaped, which cmd cannot parse). Anything
   needing quotes — schtasks /tr, powershell -Command with strings — must be
   authored as a file on the Mac, curl'd into the guest, and run by bare path.
   When output capture flakes (the wedge precursor), read files back as
   base64: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\x'))`,
   then decode GBK on the Mac (`iconv -f GBK -t UTF-8` — zh-CN console).

v0.1.1 prepared: version bumped in tauri.conf.json / Cargo.toml /
package.json. Release scope: media_control + arrange_window + settings tool
grouping, markdown/KaTeX renderer with favicon citation chips, keys.json
storage (Keychain removed), router/greeting token fixes.


## 12. Phase 0 — the truth repairs (2026-08-19)

A three-agent research pass (code inventory, market landscape, gap audit —
reconciled in `session/ROADMAP.md`) found the project lying to itself in
several places. All fixed in this phase:

- **CI had been red for 21 consecutive runs across all three releases.** Two
  causes: `pnpm/action-setup@v4` refuses `version:` when package.json already
  pins `packageManager` (every frontend-touching job died at step 3 — the
  Playwright layout check had *never* run in CI), and a clippy 1.97 lint under
  a toolchain drift. `rust-toolchain.toml` now pins 1.97.1 **with components**
  — the pin redirects rustup, which installs the version bare, so the file
  must name clippy/rustfmt itself. 1.97.1 was chosen because the offline
  Windows VM already has it and cannot download another.
- **Two of the eight tools were reporting stubs.** `set_stay_on_top` and
  `open_app` formatted success strings and did nothing. Both are real now,
  via `llm::apply_app_effects`: dispatch stays a pure executor, the effects
  run where the AppHandle lives, and failures downgrade the outcome so the
  transcript cannot claim what did not happen. `set_stay_on_top` lost its
  never-implemented `ask`/`scope`; `open_app` gained its missing allowlist UI
  (OS file picker → label/path pairs; the model only ever sees labels).
- **The empty-reply hole is guarded on the main chat path** — a round ending
  with a finish_reason, no content and no calls now errors with the reason
  named instead of rendering a blank bubble. Same reasoning-burn signature
  that hit the router (60→400) and the greeting (120→600).
- **The search router has its own 15s budget** instead of inheriting the
  90s streaming read-timeout (worst case was ~110s of silence before the
  user's request even went out).
- **Nothing can park a thread forever**: cancelled streams drop their parked
  confirmations (the registry doc promised this; now it is true),
  every subprocess runs under `tools::run_with_timeout`, and `security_scan`
  starts Defender and says "started" rather than blocking a worker for the
  hours its own description advertises.
- **README reconciled with reality** — it still said Windows was never built,
  search was unbuilt, and the UI was bilingual.

Voice research (user asked): HoYoverse's ZZZ derivative-works guide V1.0
tolerates a free non-commercial fan app, but **cloning any official VA is
off-limits three ways** — the guide itself requires the VA's own
authorization for voice as a personal right (三 Q1(3)), ripped audio only
covers personal use, and PRC Civil Code 1023 / the 2024 Beijing Internet
Court AI-voice judgment back the VA. A generic, deliberately-unlike TTS
voice is the only lawful path if voice ever happens. Required notice when
official material is used: © All rights reserved by miHoYo + the
respective-owners line; the fan-work disclaimer is now in the README.
