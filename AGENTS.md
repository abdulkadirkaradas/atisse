# @atisse/core

TypeScript execution kernel for the LLM interaction lifecycle. Node.js 24+, pnpm workspace monorepo. Not an agent framework — see `principles` skill before proposing anything that "decides" on the user's behalf.

## Stack & commands

- Package manager: **pnpm** (never npm/yarn). Workspace root commands run `--recursive`.
- `pnpm typecheck && pnpm lint && pnpm test` — run before every commit, from repo root.
- `pnpm test:coverage` — required before any PR touching `packages/core`.
- Runtime dep policy: **Zod is the only permitted runtime dependency in `packages/core`.** Anything else is a Hard Stop (see below).

## Non-negotiable rules

1. `packages/core/src/interfaces.ts` is FROZEN in v1 — no breaking changes. See `interfaces` skill.
2. `core` has zero imports from adapter packages (`provider-*`, `memory-*`, `context-*`).
3. `run()` stores no state on `this` — every execution is isolated and reproducible.
4. Every thrown error is an `OrchestratorError` subtype — never a plain `Error`. See `errors` skill.
5. No `any` types. No secrets in logs, errors, or event payloads.
6. `MockProvider` for all tests — no real API calls in CI.

Full rationale for these lives in the `principles` skill — load it before pushing back on one of them.

## Where things go

New code: `packages/{core|provider-<name>|memory-<name>|context-<name>}/src/`. Tests mirror source under `tests/unit/` (adapter-local) or `packages/core/tests/integration/` (cross-cutting). Docs: `docs/`. Examples: `examples/{n}-{name}/`.

## Skills

This project ships domain skills under `.opencode/skill/`. Each one's frontmatter description tells you when it's relevant — you don't need to pre-read them, load one when a task matches its description. Current catalog: `principles`, `architecture`, `interfaces`, `errors`, `code-standards`, `api-design`, `security`, `constraints`, `testing`, `adapter-pattern`, `hooks-events`, `observability`, `git-workflow`, `handoff-protocol`.

Two are near-mandatory for any non-trivial change: **`constraints`** (v1 scope — what's forbidden) and, if your change touches `interfaces.ts` or crosses a package boundary, **`architecture`**.

## Decisions

Prior architectural decisions are recorded in `DECISION-LOG.md` (append-only, grows over time — **grep for the relevant keyword or ADR area rather than reading the whole file**). If your task conflicts with a recorded decision, that's a Hard Stop: surface it, don't silently override it.

## Role agents

`.opencode/agent/{spsa,spbed,spqae}.md` define the Senior Principal Architect / Backend Developer / QA Engineer subagent roles used for review-gated work. Invoke with `@spsa`, `@spbed`, `@spqae`. Their handoff protocol (routing between roles, escalation to you) is defined once in the `handoff-protocol` skill — the profiles reference it rather than restating it.

## Hard stops (stop and ask, don't guess)

- Any edit to a protected file: `packages/core/src/interfaces.ts`, the `constraints`/`security`/`principles` skills, `DECISION-LOG.md`, or an agent profile. `opencode.json` is configured to **block** (deny, or ask-for-user-approval for SPSA's `DECISION-LOG.md`) these paths via edit — but treat it as a guard, not a guarantee: it only covers the edit/write/patch tool family (a `bash` command like `sed -i` routes around it entirely), and `edit: deny` itself has had real reliability bug reports upstream. The actual backstop is still: stop and get an explicit user decision.
- Any new **runtime** dependency in `packages/core`.
- Any destructive command: publish, `git push --force`/`-f`, `git reset --hard`, `rm -rf`, process `kill`/`systemctl`, CI triggers. `opencode.json` denies these for the subagents — this is a **best-effort prefix-match guard, not a sandbox**, evadable by reordering args, `bash -c`, or aliases. Treat the deny as a tripwire, not a guarantee: if one of these becomes genuinely necessary, stop and ask, don't look for the gap in the pattern.
- Ambiguous architectural impact that can't be resolved from the skills above — say so explicitly rather than guessing.
