# Roadmap — synthesised from three research passes, 2026-08-19

Three parallel investigations: (1) a code-grounded inventory of what she can do
and the constraints new work must respect, (2) market research across the 2026
desktop-companion landscape, (3) an audit of known gaps and debt. This file is
the reconciliation. Evidence lives in the reports' sources; constraint numbers
(C1-C13) refer to the guard tests and doc comments in src-tauri/src/tools/.

## Phase 0 — make the ground truthful (do before any new feature)

1. **Two of the eight tools lie in the transcript.** `set_stay_on_top` reports
   success and changes nothing (dispatch.rs:143 formats a string; nothing
   consumes it — only the tray/settings paths are wired). `open_app` reports
   「帮你打开了 X」 and launches nothing, and is unreachable anyway: nothing
   writes `appAllowlist`, so its enum is empty. Either wire both for real or
   pull both from the catalog until they are. The entire security story is
   "the transcript tells the truth about what she did."
2. **CI has been red for 21 consecutive runs across all three releases.**
   Two trivial causes: `pnpm/action-setup` gets `version: 10` while
   package.json already pins `packageManager` (delete the with-block), and one
   clippy lint on 1.97 (`llm/mod.rs:1868`, redundant `&`). Fixing it turns on:
   frontend typecheck + 106 tests in CI, the Playwright layout check (never
   run in CI), **Windows x64 built on real x64**, and **macOS Intel** — two
   platform gaps close as a side effect. Add rust-toolchain.toml so local and
   CI clippy agree.
3. **Guard the empty reply.** A round ending with a finish_reason, zero
   content and no calls renders a blank bubble with no error. This is the
   reasoning-burn signature that already bit the router (60→400) and the
   greeting (120→600); the main chat path is the one place without the guard.
   Also: give the search router its own short timeout (today it inherits the
   90s read timeout → worst case ~110s of silence) and emit the search chip
   before the router call, not after.
4. **Before growing the catalog** (standing direction): fix the parked-confirm
   leak (close the panel during a confirmation → stream task parks forever;
   select against cancellation or drop the sender in cancel_chat) and put
   timeouts on tool subprocesses (no Command in the tree has one; a full
   Defender scan blocks a runtime thread for hours with Stop inert).
5. **Reconcile README/HANDOFF with reality** — README still says Windows was
   never built and search is unbuilt; "bilingual UI" overclaims (~15 strings
   are English, settings is entirely zh-CN). A user who catches the docs wrong
   on easy facts won't trust them on key storage.
6. **SignPath is unblocked and nobody noticed** — the Foundation cert needs a
   public repo, which has been true since v0.1.0. Doing it removes the
   SmartScreen walkthrough from the release notes. (macOS signing remains a
   paid-Apple-ID decision, parked.)

## Phase 1 — features, ranked (market demand × architectural fit)

1. **她记得的事 — bounded, visible memory.** The most-praised AI feature in
   every retained competitor (Molili 88%); even the leading OSS project
   removed theirs and hasn't rebuilt it. Ours must be the honest version:
   ≤5 summarised lines per session, shown verbatim in Settings, per-item
   delete, master switch deletes stored data. Matches the existing profile
   preview and historyMode patterns. Size L. Budget max_tokens for reasoning
   burn (≥600).
2. **Multi-monitor: `move_herself` / `move_window_to_display`** with
   next/previous/primary enums. Recurring open bug across every competitor;
   all machinery (monitor enumeration, stranding recovery, per-monitor work
   areas) already exists. Size M. macOS AppleScript path reads primary-display
   bounds only — fix or keep Windows-only until fixed (C7).
3. **`arrange_window` enum growth: snap_top / snap_bottom / centre / restore.**
   Pure enum growth, size S. `restore` closes a real gap (maximize is one-way).
4. **Global summon hotkey.** The plugin is installed, permission granted, and
   zero shortcuts registered — dead weight today. If she's hidden, the tray is
   the only way back. Key-capture UI in Settings, visible failure if the combo
   is taken. Size S-M.
5. **她动过什么 — action ledger.** Local, capped log of every Act/Confirm run
   (user label, time, ok) with a clear button. The data already flows through
   toolRuns and evaporates. Post-2026-breaches, inspectable-by-design is a
   purchasable differentiator, and it would have made the Phase-0 stubs
   visible immediately. Size M. Store labels, never raw results/args.
6. **Ambient that notices moments, not just the clock.** Facts: continuous-work
   duration, weekend, time-since-last-chat; plus an event-driven trigger when
   the foreground app changes after a long stretch (gated on the
   get_active_window switch = existing consent; never persist app names).
   Read-tier `get_power_state` / `get_display_layout` (zero-param, C6-clean)
   feed this: 「还剩 12% 的电」 is companionship, not tooling. Size S+M.
7. **Sprite reactions.** Poke-streak → expect/pleased flourish, drag-release
   settle, sleep→wake transition. Pack already ships the poses; emoteOverride
   and the dwell floor already handle temporaries. Any spoken line passes the
   ambient gates (else clicking bypasses the daily cap). Size S.
8. **Pack switcher.** list_packs is registered and never called; assets.rs was
   built for this. Frame as "animation sets for her", never "change character"
   (C11); surface pack credits (CC BY-NC-SA condition). Size S-M.

## Parked, with reasons

- **Voice.** The market's own numbers argue patience: local pipelines land
  ~1.2s round-trip vs <500ms for cloud realtime; users notice. And she has a
  canonical VA voice users would expect — cloning a real VA is a legal line we
  don't cross (2026 consent/labelling law). If ever: TTS-only first, design
  around latency (thinking poses, streamed barge-in), never a cloned voice.
- **Screen awareness beyond the active-window name.** Genuinely demanded
  (users ask for it unprompted) but it's the highest privacy-risk feature in
  the category the year 150M companion messages leaked. The event-driven
  ambient trigger above is the safe 80%. Anything more needs its own consent
  surface and a data-never-persists design.
- **Live2D.** Licensing trap: the small-business exemption excludes
  "Expandable Applications", which a load-your-own-model app plausibly is.
  If richer animation is ever wanted, VRM (three-vrm, WebGPU-ready, VRoid Hub
  ecosystem, no proprietary blob) is the format — and it's the format the
  modding community already lives in.
- **MSIX / Store** — parked until a parent can hold the Partner Center account.
- **Transcript void** — correctly instrumented; nothing to do until the
  witness fires. (Worth a 20-min check that the witness *can* fire: lower the
  threshold, force a void, confirm the log line lands.)

## Never (the constraint table, so nobody "helpfully" re-adds them)

run_command/shell (C1) · any url/path/text-that-reaches-a-resource parameter
(C2/C10, build-failing tests) · composing commands from model output, incl.
set_volume(integer) — express as enum steps (C3) · close_window (C8) · reading
keys into JS (C9) · editable identity/voice (C11) · tool switches outside
Settings (C12) · "don't ask again" on Confirm (C6) · offering a tool a
platform can't run (C7).

## The positioning this adds up to

Small, truthful, light. The market's biggest failures are RAM bloat, mod
hostility, monetised affection, and privacy breaches. Her story is the
opposite of each: a Tauri app measured in tens of MB; an enum-only catalog
whose every action is visible and refusable; no accounts, no quotas, keys
that never leave Rust; and a character who is herself, not a costume. The
2026 entrants (miHoYo included) cannot match "auditably harmless" — that is
the moat available to this project.
