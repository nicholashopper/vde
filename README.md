# VDE — Vibe Development Environment

A desktop app that gives you a 30,000ft view of the health of a vibecoded repository, and of how that health is *changing*.

Point it at a git repo. It reads the history and the files, and tells you where the rot is.

---

## Why this exists

Conventional tooling reads one file at a time. That is why it cannot see what goes wrong in an agent-written codebase.

A linter run against a real 740-commit, 19-day, agent-built monorepo found **zero** TODO, FIXME, HACK or XXX markers across 767 source files. By the usual measures, spotless. Meanwhile:

| What was actually happening | Evidence |
|---|---|
| Nothing was ever deleted | 1,207,450 lines added, 42,157 removed — a rework ratio of **0.035** |
| Commits were unreviewable | p50 of 4 files per commit, p99 of **164**, one commit touching **2,098** |
| Docs were being written instead of work | `docs/qa/` held **101** markdown files, including `…-clean-final-reproof.md`, `-2.md`, `-3.md`, `…-final-root-reproof.md`, and `…-final-targeted-reproof.md` |
| The most-edited file in the repo was a document | `docs/qa/campaign.md`, 68 commits — more churn than any source file |
| Debt was being catalogued faster than it was paid | `docs/TECH_DEBT.md` was the 8th most-churned file |
| Deletion had effectively stopped | of 4,254 paths ever created, exactly **32** were ever deleted outright (1,252 were renames) |
| Half the code was written once and never revisited | **351 of 767** source files have exactly one commit |

None of that is visible to a linter. All of it is visible in git.

VDE measures the **history** and the **shape** of a repository, which is where this kind of decay actually lives.

## What it measures

Fourteen signals. **Every one is oriented so that higher is worse** — that is the rule that makes the panel readable at a glance without collapsing everything into a single misleading score.

| Signal | Measures |
|---|---|
| **Accretion** | share of added lines never removed again |
| **Blast Radius** | 95th-percentile files touched per commit |
| **Unreviewed Bulk** | share of *surviving* source lines that arrived in mega-commits |
| **Sibling Sprawl** | share of files sitting in near-duplicate filename clusters |
| **File Thrash** | share of all files ever created that no longer exist |
| **Rework Churn** | share of substantial files rewritten in place without converging |
| **God Files** | share of source lines in files over 800 lines |
| **Write-Once Code** | share of source files committed once and never revisited |
| **Complexity Drift** | share of functions above cyclomatic complexity 10 |
| **Doc Bloat** | share of file changes landing on docs rather than code |
| **Test Deficit** | shortfall against a 0.4 test-to-source line ratio |
| **Commit Hygiene** | share of commits with unusable subjects |
| **Velocity Decay** | drop in recent commit rate against the trailing month |
| **Directory Sprawl** | share of directories holding fewer than three files |

Thresholds are calibrated against a real specimen rather than invented; the observed values are recorded in `src/shared/signals.ts` next to each band so they are auditable.

Test Deficit is deliberately scored as a *shortfall*, so a well-tested repository reads as zero. A tool that only ever scolds stops being believed.

## Change in health

On first scan VDE reconstructs your repository's entire history retroactively — walking commits at an adaptive cadence (daily for recent months, weekly then monthly further back) and computing every signal at each point. You see the decay curve immediately, not after weeks of use.

This is affordable because all content analysis is cached against the **git blob SHA**. Blobs are content-addressed, so a file that did not change between two snapshots is parsed exactly once, ever.

## VDE never writes to your repository

This is enforced structurally, not by good intentions:

- **Allowlist.** Every git invocation goes through one gateway (`src/analyzer/git/exec.ts`) that permits only subcommands incapable of writing. Anything else throws before a process is spawned. Git aliases cannot shadow built-ins, so the allowlist cannot be subverted.
- **Argument denylist.** Caller-supplied `-c`, `--config-env`, `--exec-path`, `-C`, `--git-dir`, `--work-tree`, `--upload-pack` and `-w` are rejected.
- **Hardened config.** VDE injects `core.pager=cat`, `core.fsmonitor=false`, `core.hooksPath=/dev/null` and `diff.external=` — closing every path by which a repository can execute code during a *read*.
- **No locks.** `GIT_OPTIONAL_LOCKS=0`, so git will not even take `index.lock` to refresh the index as a side effect.
- **A tripwire.** VDE fingerprints HEAD, all refs, and `.git/index` before and after every scan, and raises a loud error if anything moved.

## Analysis is deterministic and offline

No LLM, no API key, no network, no telemetry. The same commit always produces the same numbers, which is what makes the trend lines trustworthy. Structural analysis uses tree-sitter (36 grammars, WASM); near-duplicate detection uses SimHash over token shingles.

## The remediation brief

Diagnosis without a next step is just nagging. VDE generates a markdown brief written as instructions to a coding agent — the findings, the evidence, the affected files, and what to do about each — that you paste into Claude Code or whatever you use.

It includes a ground rule that matters: *do not create new files to describe the work.* That is the pathology VDE exists to catch.

VDE never edits anything itself.

---

## Known limitations

- **One grammar can fail to load per session.** On a large scan, `web-tree-sitter`'s WASM dynamic-symbol resolver occasionally fails to link a grammar after many others are already loaded (observed once, on the bash grammar, out of 5,010 blobs analysed). It fails safe: that blob gets no complexity data, the scan continues, and the reason appears in `RepoReport.warnings` and in the UI. It is a loader interaction upstream, not a VDE code path.
- **Rename detection is git's, at 50% similarity.** A file rewritten past that threshold and renamed reads as a delete plus an add rather than a rename, which nudges File Thrash up.
- **Unreviewed Bulk is a documented approximation.** Exact line survivorship needs a full blame of every file; VDE attributes each file's surviving lines in proportion to the share of its added lines that came from mega-commits. The method is stated in `signals/history.ts`.
- **Shallow clones under-report everything history-derived.** VDE warns when it detects one.
- **The project is not yet under version control.** `git init` when you are ready; nothing in the build depends on it.

## Development

```bash
pnpm install
pnpm dev          # electron-vite dev server with HMR
pnpm test         # vitest — engine correctness
pnpm typecheck    # both projects
pnpm lint
```

## Building

```bash
pnpm pack         # unpacked build into release/
pnpm dist:mac     # dmg + zip, arm64 and x64
pnpm dist:win     # nsis
pnpm dist:linux   # AppImage + deb
```

`build/make-icons.mjs` regenerates the app icons from code with no image dependencies.

### Signing and notarization

`electron-builder.yml` has hardened runtime and entitlements configured. A signed, notarized macOS build additionally needs an Apple Developer certificate in your keychain plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in the environment, and `notarize: true`. Without those, the build succeeds and produces an unsigned artefact.

Auto-update is wired (`electron-updater`) but inert until a publish target is configured and builds are signed — an unsigned macOS app cannot self-update, and an updater pointing nowhere produces an error on every launch. Set `VDE_ENABLE_UPDATER=1` once both are true.

## Architecture

```
src/
  shared/      the contracts — types, the signal registry, the IPC protocol
  analyzer/    the engine, in a dedicated Electron utility process
    git/       the read-only gateway, history parsing, tree reading
    content/   language detection, LOC, tree-sitter, SimHash, clustering
    signals/   the fourteen signal computers, pure functions of a context
    snapshots/ retroactive backfill and per-revision computation
    db/        SQLite — blob cache, snapshots, repo registry
  main/        window, menu, IPC surface, analyzer supervision, updater
  preload/     the only path from renderer to privilege
  renderer/    React 19 + Tailwind 4
```

The analyzer runs in a utility process because it is CPU-bound: in the main process it would freeze the window, and in the renderer it would need Node access the renderer must not have.

The renderer runs with context isolation on, sandbox on, node integration off, and a CSP set at the session level as well as in the document — a repository's own content is untrusted data and must never become a page.
