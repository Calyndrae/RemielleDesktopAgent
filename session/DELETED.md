# Deletion ledger

`PROMPT-FOR-NEW-SESSION.md` asked for everything that is not the program to be
deleted after reading, and for the tree to leave no rubbish behind. This file is
the record of what that removed, so "deleted" never has to mean "forgotten".

**Nothing here is actually lost.** Commit `57d9aeb`, tagged **`zip-baseline`**,
holds all 220 files exactly as they arrived in `RemielleDesktopAgent.zip`. That
commit was made before anything was touched, and `demo-standalone.html` was
force-added to it despite being gitignored, precisely because it was on this
list. To bring any of it back:

```bash
git checkout zip-baseline -- <path>
```

The original `RemielleDesktopAgent.zip` is also still in `~/Downloads` as a
second copy.

---

## Deleted

| File | Size | Why |
|---|---|---|
| `demo-standalone.html` | 5.8 MB | The exported standalone demo, named directly in the reorganisation brief. It is a build output, not a source: `pnpm demo:build` regenerates it from `demo.html` + `src/demo/` + `scripts/build-demo.mjs`, all of which are kept. It was already in `.gitignore`, so it was never tracked in the first place. |
| `scripts/ui-preview.mjs` | 109 lines | Orphaned one-off. No `package.json` script referenced it and nothing else in the tree called it. It also could not have run here: `findChromium()` builds its path as `chromium-*/chrome-linux/chrome`, which is the Linux layout — on macOS the binary is under `chrome-mac/`. It was written for the Linux container this project came from and had no working path on a Mac. |

## Moved rather than deleted

The brief allowed either. These three are the project's memory and reasoning,
and deleting them would have thrown away the only written account of *why* the
code is shaped the way it is.

| File | New home | Why kept |
|---|---|---|
| `HANDOFF.md` | `session/` | The architecture, the load-bearing decisions, twelve fixed bugs not to reintroduce, and the design rules the UI is built against. Losing this would mean re-deriving all of it. |
| `START-HERE.md` | `session/` | Explains why the zip shipped with no binary and what the intended route to one was. Now historical, but it is the context for the build setup. |
| `PROMPT-FOR-NEW-SESSION.md` | `session/` | The brief this reorganisation was carried out against. Kept so the result can be checked against what was actually asked for. |

## Deliberately kept, though arguably in scope

| File | Why |
|---|---|
| `harness.html`, `src/harness/` | Dev-only, but `pnpm layout:check` drives them, and the brief requires that command to keep passing. Removing them breaks a required check. |
| `demo.html`, `src/demo/`, `vite.demo.config.ts`, `scripts/build-demo.mjs` | The brief names "exported demos" as rubbish, which is the generated HTML file — not the pipeline that produces it. `START-HERE.md` treated the demo as a feature worth having, so the ability to regenerate it is kept while the stale export is gone. |
| `scripts/vendor-fonts.mjs` | Referenced by `NOTICE.md` as the way to regenerate the vendored Noto Serif SC subsets. A licensing document points at it; it is maintenance tooling, not scratch. |

## Not committed, by choice

`program/macos/` and `program/windows/` hold build outputs — around 57 MB per
macOS build. They are gitignored rather than tracked: committing a fresh copy of
the `.app` and `.dmg` on every build would grow the repository without bound,
and they are reproducible from source with one command. The folders and their
`README.md` files are tracked, so the structure survives a clean checkout even
when the artefacts do not.
