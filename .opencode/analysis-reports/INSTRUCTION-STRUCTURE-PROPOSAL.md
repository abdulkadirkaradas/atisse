---
title: 'Atisse Agent Instruction System Evaluation'
model: 'claude-sonnet-5-medium'
description: 'Evaluation of the Atisse agent instruction system and a proposal for its redesign to improve efficiency and maintainability.'
date: 2026-08-02
---

# Atisse agent instruction system — evaluation & redesign proposal

## 1. What's actually in the current setup

28 files, ~248 KB, ~29.5K words (~60-65K tokens if every file were loaded at once).
Breakdown: `AGENTS.md` (entrypoint) + `opencode.json` + `rules/` (14 files) + `workflows/`
(6 files) + `skills/git-commit/` (1 file, correctly formatted) + `agents/` (3 role
profiles, 12-13 KB each).

The design already has good instincts — `rules/index.md` implements manual "lazy loading"
so agents don't read everything up front, and `skills/git-commit` uses the real Agent
Skills format. The problem isn't intent, it's execution: the system re-implements
progressive disclosure by hand (a maintained routing table) instead of using the mechanism
built for it, and it pays a large **fixed tax on every single task** regardless of size.

### The fixed tax, measured

`opencode.json` marks three files as _always loaded, every session_:

| File                    | Size                        |
| ----------------------- | --------------------------- |
| `rules/agent-safety.md` | 5,612 chars                 |
| `AGENTS.md`             | 2,416 chars                 |
| `rules/index.md`        | 10,132 chars                |
| **Always-on total**     | **~18.2 KB (~4.5K tokens)** |

`AGENTS.md` then names five more files as "Mandatory Pre-Task Reading... before starting
ANY task": `task-context.md` (10.8K) + `constraints.md` (8.3K) + `philosophy.md` (5.5K) +
`security.md` (10.6K) = another **~35 KB (~8.8K tokens)**, on top of the always-on set,
before a single line of the actual task has been considered.

Invoke a role agent (`@spsa`, the largest) and add its own prompt (12.8K) plus _its own_
mandatory-reading sequence, which re-lists task-context/constraints/philosophy (already
paid for) and adds `architecture.md` (12K) + `decision-log.md` (18.1K, the single largest
file in the corpus). **A cold SPSA review of a one-line change starts around 24K tokens of
pure instruction-loading before the actual diff is read** — and that's before any
conditional file (`interfaces-core.md`, `error-taxonomy.md`, etc.) that the task itself
requires.

### Root causes, not just symptoms

1. **A hand-maintained router duplicates a mechanism the platform already has.**
   `rules/index.md` is 10K of "read X when Y" tables. OpenCode (like Claude Code, Codex,
   Cursor, and 15+ other tools as of 2026) natively supports **Agent Skills** — the
   `skills/git-commit` folder already proves this project's harness supports it — where a
   skill's YAML frontmatter `description` is the router: the harness surfaces matching
   skills automatically at a median cost of ~80 tokens each, and the full body loads only
   when a task actually matches. A 10K manually-maintained index is strictly worse than 14
   frontmatter descriptions doing the same job for a fraction of the tokens, and it will
   drift out of sync with the files it routes to (it already has: `agent-safety.md`
   protects `rules/decision_log.md`, elsewhere spelled `decision-log.md`).

2. **Instruction files mirror source code instead of pointing at it.**
   `interfaces-core.md` opens with _"Source file: `packages/core/src/interfaces.ts`"_ and
   then reproduces it. `error-taxonomy.md` reproduces the full class hierarchy already in
   `errors.ts`, including implementation-level comments (`// V8-specific; guarded for edge
runtime compat`). This is two sources of truth for the same contract — a real drift risk
   — and it's expensive for no benefit: a 2026 controlled study (Gloaguen et al., cited in
   current AGENTS.md guidance) found that directory maps and code mirrors in context files
   don't meaningfully help agents, who navigate/read repos fine on their own, while
   unnecessary content in context files measurably _hurts_ task success and inflates cost.
   The instruction file should hold only what isn't recoverable by reading the source: the
   _why_, the retry semantics, the mapping rules for adapter authors.

3. **The same protocol is restated three times.** The handoff JSON schema, field rules, and
   routing-authority matrix appear in full in `task-context.md` _and_ get partially
   re-described inside each of `spsa.md`, `spbed.md`, `spqae.md`. Same for large chunks of
   "mandatory reading order" — nearly identical five-file lists appear in `AGENTS.md` and
   again, reworded, at the top of each agent profile.

4. **Process ceremony scaled for a large team is applied to every task.** UUID-v4 task
   IDs, an iteration-limit override, a DOMAIN/ACTION taxonomy for routing reasons — this is
   legitimate for genuine multi-subagent handoff (which OpenCode's `mode: "subagent"`
   config confirms this project actually uses), but it's currently _inline, in full, at
   every consumption site_ rather than defined once and referenced.

5. **Prose is doing a permission system's job.** `agent-safety.md` lists forbidden bash
   commands (`git push --force`, `npm publish`, `pm2 restart`...) as a table the agent must
   remember and voluntarily obey. `opencode.json` already has a real, mechanically-enforced
   permission model (`write: "ask"`, per-skill allow/deny) — the config, not a markdown
   table, is the right place for anything that can actually be scoped there. What can't be
   (protected _files_, as opposed to tool categories) should stay in prose, but should say
   so once, not duplicate the list per agent.

## 2. What "modern, production-grade" currently means

Grounding for the redesign, current as of mid-2026:

- **AGENTS.md is the de facto standard** (donated to the Agentic AI Foundation / Linux
  Foundation in December 2025), read natively by Claude Code, Codex, Cursor, Gemini CLI,
  Copilot, and OpenCode. Guidance converges hard on one point: **short, specific,
  imperative, under ~500 lines** (many teams target 30-150). Comprehensive is the anti-
  pattern, not the goal — the controlled research above found LLM-generated,
  "comprehensive" context files _reduce_ task success while raising inference cost ~20%;
  minimal, human-curated files give a small, real improvement.
- **Agent Skills (open standard, Dec 2025) is the mechanism for everything AGENTS.md
  shouldn't carry.** Three-layer progressive disclosure: name+description always resident
  (tens of tokens), full SKILL.md body loaded on match, bundled reference files loaded only
  during execution. This is precisely the "lazy load" behavior `rules/index.md` was
  hand-rolling.
- **Context engineering (Anthropic, 2025-26):** prefer letting agents discover context at
  runtime (read the file, grep the log) over pre-loading it "just in case"; curate the
  smallest set of high-signal tokens; treat context as a scarce, competing resource across
  system prompt, tools, and history — not a place to be exhaustive.
- **Enforce mechanically what you can, document only what you can't.** Permission configs
  (already present here) beat prose for anything expressible as a tool/command scope.

## 3. Proposed structure

```
AGENTS.md                                  # lean entrypoint, ~120 lines, always loaded
opencode.json                              # config; permission scoping does the enforcement work
DECISION-LOG.md                            # unchanged role — append-only, grep don't read-whole

.opencode/agent/
  spsa.md   spbed.md   spqae.md            # identity, authority, role-specific hard stops,
                                            # routing table — no restated protocol or reading list

.opencode/skill/
  principles/SKILL.md          # merges: philosophy.md + project-description.md + design-principles.md
  architecture/SKILL.md        # merges: architecture.md + state-machine.md
  interfaces/SKILL.md          # merges: interfaces-core.md + interfaces-runtime.md (pointer-first)
  errors/SKILL.md              # merges: error-taxonomy.md + workflows/error-handling.md (pointer-first)
  code-standards/SKILL.md      # merges: implementation-standards.md + typescript-style.md
  api-design/SKILL.md          # = api-design.md, trimmed
  security/SKILL.md            # = security.md, unchanged content, now progressively disclosed
  constraints/SKILL.md         # = constraints.md, unchanged content
  testing/SKILL.md             # = workflows/testing-standards.md
  adapter-pattern/SKILL.md     # = workflows/adapter-pattern.md
  hooks-events/SKILL.md        # = workflows/hooks-events.md
  observability/SKILL.md       # = workflows/observability-standards.md
  git-workflow/SKILL.md        # merges: workflows/sdlc.md + skills/git-commit (same audience/action)
  handoff-protocol/SKILL.md    # NEW: single source for the JSON schema + routing matrix,
                                # extracted out of task-context.md and all three agent profiles
```

**20 files total** (down from 28) — but the file-count drop is the least important number
here. The real change is _what gets paid for on a given task_: the fixed always-on tax
drops from ~4.5K tokens (three files, none of which teach the agent anything about the
task) to a lean `AGENTS.md` plus the skill catalog's frontmatter (14 skills × ~100-150
tokens ≈ 1.5-2K tokens for full awareness of everything available). Full skill bodies —
and the role-agent prompt — load only when the task actually calls for them, and each is
individually smaller because it stops mirroring source code and stops restating shared
protocol.

**Sample measured on this exact content** (`AGENTS.md` + `rules/index.md` +
`agent-safety.md` + `task-context.md` + `error-taxonomy.md` + `error-handling.md` +
`spsa.md`, rewritten as `AGENTS.md` + `opencode.json` + `errors/SKILL.md` +
`handoff-protocol/SKILL.md` + `spsa.md`): **57.5 KB → 15.6 KB, a 73% reduction**, with no
loss of the load-bearing rules — see the worked files below.

### Where I deliberately _didn't_ merge further

Testing, adapter-pattern, hooks-events, observability, api-design, and security stayed as
separate skills rather than getting folded into bigger ones. Fewer files isn't free —
Skills' whole value is that a task pulls in only what it needs. Merging "testing" into
"code-standards" would mean every implementation task also pays for test-framework detail
it may not need, and vice versa. Each of these six is a genuinely distinct trigger
condition (writing tests / building an adapter / adding a hook / adding a log line /
touching the public API / touching a trust boundary) with a distinct, disjoint audience
most of the time — that's exactly the shape a skill boundary should follow. The merges I
did make (`principles`, `architecture`+`state-machine`, `interfaces`, `errors`,
`code-standards`, `sdlc`+`git-commit`) are all pairs/triples that the _original_ routing
table already told agents to always read together — so merging them removes a step without
changing what gets loaded.

## 4. Full migration map

| Old file(s)                                                                                  | New location                                          | Change                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `rules/philosophy.md` + `rules/project-description.md` + `rules/design-principles.md`        | `skill/principles/`                                   | merged — one "why we build this way" doc                                                                                                  |
| `rules/architecture.md` + `rules/state-machine.md`                                           | `skill/architecture/`                                 | merged                                                                                                                                    |
| `rules/interfaces-core.md` + `rules/interfaces-runtime.md`                                   | `skill/interfaces/`                                   | merged, rewritten pointer-first at `interfaces.ts`                                                                                        |
| `rules/error-taxonomy.md` + `workflows/error-handling.md`                                    | `skill/errors/`                                       | merged, rewritten pointer-first at `errors.ts` (worked example below)                                                                     |
| `rules/implementation-standards.md` + `rules/typescript-style.md`                            | `skill/code-standards/`                               | merged                                                                                                                                    |
| `rules/api-design.md`                                                                        | `skill/api-design/`                                   | moved, trimmed                                                                                                                            |
| `rules/security.md`                                                                          | `skill/security/`                                     | moved, content unchanged (still protected)                                                                                                |
| `rules/constraints.md`                                                                       | `skill/constraints/`                                  | moved, content unchanged (still protected)                                                                                                |
| `workflows/testing-standards.md`                                                             | `skill/testing/`                                      | moved                                                                                                                                     |
| `workflows/adapter-pattern.md`                                                               | `skill/adapter-pattern/`                              | moved                                                                                                                                     |
| `workflows/hooks-events.md`                                                                  | `skill/hooks-events/`                                 | moved                                                                                                                                     |
| `workflows/observability-standards.md`                                                       | `skill/observability/`                                | moved                                                                                                                                     |
| `workflows/sdlc.md` + `skills/git-commit/`                                                   | `skill/git-workflow/`                                 | merged — same audience, same moment (commit/branch/release)                                                                               |
| `rules/task-context.md` (handoff schema portion) + duplicated schema in all 3 agent profiles | `skill/handoff-protocol/`                             | extracted to single source                                                                                                                |
| `rules/task-context.md` (task-framing/file-location/decision-order portion)                  | folded into `AGENTS.md`                               | condensed to a few lines each                                                                                                             |
| `rules/agent-safety.md`                                                                      | folded into `AGENTS.md` + `opencode.json` permissions | commands/tiers → config where expressible; protected-file list → one short table in `AGENTS.md`                                           |
| `rules/index.md`                                                                             | **removed**                                           | superseded by skill frontmatter (native progressive disclosure)                                                                           |
| `rules/decision-log.md`                                                                      | `DECISION-LOG.md` (root)                              | unchanged role; **recommend**: grep-only access pattern stated explicitly, periodic archiving of superseded ADRs as it grows past ~15-20K |
| `agents/spsa.md`, `spbed.md`, `spqae.md`                                                     | `.opencode/agent/*.md`                                | trimmed — handoff protocol and generic mandatory-reading list removed, role-specific authority/hard-stops/routing kept                    |

## 5. Worked examples

The following are fully written, not sketched, so the pattern is concrete and directly
reusable:

- `AGENTS.md` — the new lean entrypoint
- `opencode.json` — updated wiring
- `.opencode/skill/errors/SKILL.md` — the flagship merge: `error-taxonomy.md` (10.8K) +
  `error-handling.md` (5.0K) → one 3.5K skill, pointer-first at `errors.ts`, keeping every
  rule that isn't recoverable from the source
- `.opencode/skill/handoff-protocol/SKILL.md` — the protocol extracted to a single source
- `.opencode/agent/spsa.md` — the same profile, same authority/hard-stop/routing content,
  with the restated protocol and generic reading list removed

The remaining 10 skills follow the same two moves used in `errors/SKILL.md` and don't need
individual worked copies to prove the pattern: **(a)** if the file mirrors a source file
(`interfaces-core.md`, `interfaces-runtime.md`), replace the mirror with a pointer plus the
non-obvious rules; **(b)** if two files are already always read together per the old
`index.md`, merge them and delete one frontmatter block. I'd suggest doing these
mechanically, file by file, and I'm glad to work through the rest in this session if useful
— they're a few minutes each once the pattern's agreed.

## 6. One open decision for you

`DECISION-LOG.md` is already the largest single file (18K) and will only grow — ADR logs
are meant to be append-only, so it's the one place where "keep everything" is correct, not
a smell. Two reasonable options, both compatible with this structure:

- **Grep-first convention** (what's reflected above): tell agents explicitly to search for
  the relevant ADR by keyword/area rather than reading the whole file, and never load it as
  a skill (skills load fully or not at all; a log wants partial access).
- **Split by area** once it crosses some size threshold (e.g. `decisions/contracts.md`,
  `decisions/lifecycle.md`, ...), trading one growing file for several bounded ones. I'd
  hold off on this until the log is large enough that even a targeted grep returns too much
  — premature splitting just re-creates the index-table problem in miniature.
