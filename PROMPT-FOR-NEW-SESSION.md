# Prompt for the new Claude Code session

Paste everything below the line into a fresh Claude Code session on the Mac,
with this folder open.

---

I am continuing an existing project. Read `HANDOFF.md` in full before doing
anything else — it has the architecture, the decisions that are load-bearing,
twelve bugs that were already found and fixed, the design rules, and the
prioritised list of what is not built yet. Then read `NOTICE.md` for the
licensing situation.

This is 蕾米埃尔 AI Desktop Agent: a Tauri v2 + React desktop companion. The
character floats on the desktop, clicking her opens an LLM chat panel, and she
can run a small catalog of typed tools against the machine. Windows-first,
macOS config is complete but has never been run on a Mac.

## First job: reorganise the working tree

Right now everything is in one flat repository. Restructure it:

1. Create a **new folder** to hold the actual shippable program and its build
   outputs. Inside it, create a **`windows/`** folder and a **`macos/`** folder.
   Each of those holds *all* program data, executables, bundles and
   platform-specific artefacts for that platform.
2. Everything else — notes, scratch files, one-off scripts, exported demos,
   anything that is not the program — either move into the session folder or
   **delete it after reading it**.
3. **Leave no rubbish.** No stray files, no half-migrated directories, no
   orphaned build output. When you are done the tree should look deliberate.

Do not break the build while doing this. `pnpm tauri dev`, `pnpm test`,
`pnpm typecheck`, `pnpm layout:check` and `cargo test` must all still pass
afterwards, and say so with the actual output. If you move anything the
workflows in `.github/workflows/` reference, fix the paths in the same commit.

## Second job: build both platforms

The previous session ran on Linux and could build **neither** binary — Tauri
bundles against the host's own webview, so there is no cross-compile. So:

- **macOS** — you are on the Mac, so build it for real. First run
  `pnpm tauri icon src-tauri/icons/icon.png` to generate `icon.icns` (it is
  deliberately not checked in). Then `pnpm tauri build`. Put the `.app` and
  `.dmg` in the `macos/` folder.
- **Windows** — you cannot build this on a Mac either, but
  `.github/workflows/build.yml` already exists and does it on a `windows-latest`
  runner. It has **never been executed**, so treat it as unproven: push the
  branch, run it from the Actions tab, and drive it to green — read the job log
  and fix it rather than guessing. Then download the artifact into `windows/`.
  `check.yml` runs the test suites and is the cheaper one to get green first.

**Do not claim a platform works until you have actually run it.** The macOS
build in particular has three things worth checking the moment it launches,
none of which have ever been verified: (a) the overlay window is genuinely
transparent, (b) you can click desktop icons *through* the empty space around
her, and (c) she does not appear in ⌘-Tab or the Dock.

## How to work

- Verify by running things, not by reasoning about them. Every claim in
  `HANDOFF.md` was checked by executing something.
- The design rules in §7 of `HANDOFF.md` are not suggestions — the UI was built
  against them and breaking one makes it look wrong in ways that are hard to
  name afterwards.
- Comments explain *why*, especially where the obvious approach is wrong. There
  are several places where the obvious approach is wrong.
- Ask before doing anything irreversible.
