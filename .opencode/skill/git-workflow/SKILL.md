---
name: git-workflow
description: Branching, commit conventions, PR requirements, CI/CD, versioning, code-review criteria, and Delivery lifecycle (0-7 plan->release) for @atisse/core. Load when committing, opening a PR, cutting a release, planning/executing any Delivery step, or reviewing one for process compliance.
license: MIT
compatibility: opencode
---

# Git workflow

## Branching

Branch: `{feat|fix|chore|docs|test|refactor}/<short-description>`. `main` is squash-merged,
so per-commit hygiene shapes the final squashed PR message more than long-term branch
history — do it properly anyway, since it's what reviewers read during the PR.

## Committing

**Mode gate — check first, every time, before touching git or a file:**
`[CURRENT MODE: PLAN MODE]` → analyze the diff and output the commit plan below, then
**stop** — no git commands, no file edits. `[CURRENT MODE: BUILD MODE]` → execute the
plan's commits sequentially, no confirmation needed between them, but never touch a file
the plan didn't already list. No mode stated → treat as PLAN MODE (the safe default).

**Atomicity (SRP):** split unrelated changes — even within the same file — into separate
commits. **Ordering:** a prerequisite commit (a `refactor`/`chore` the feature depends on)
is committed _before_ the commit that depends on it, never after.

**Type** — Conventional Commits, `<type>(<scope>): <description>`; scopes are `core`,
`retry`, `streaming`, `hooks`, `events`, `tools`, `memory`, `adapter`, `deps`.

| Type       | Use for                            |
| ---------- | ---------------------------------- |
| `feat`     | new capability                     |
| `fix`      | resolves a bug or broken behavior  |
| `refactor` | restructuring, no behavior change  |
| `style`    | formatting only, no meaning change |
| `test`     | adding or correcting tests         |
| `chore`    | build/config/dependency upkeep     |
| `docs`     | documentation only                 |

Breaking change: append `!` right after type/scope — `feat!:` — never `feat: breaking
change!` or `feat (breaking): ...`.

**File paths are relative to the project root, never absolute** — `packages/core/src/
profile.ts`, never `/home/<user>/.../packages/core/src/profile.ts`. Every commit lists
every relative path it touches — "modified source files" is not traceability.

**Plan output format** — exactly this structure, no conversational filler:

```markdown
### [Type]: [Subject]

**Description:** what and why (+ breaking-change details if applicable)
**Files:**

- path/one
- path/two
```

## Pull requests

Every PR: Conventional-Commits title, a What/Why description, all CI checks green, coverage
maintained or improved, no new `any`, and `interfaces.ts` not broken for existing adapters
(the test: does code that compiled against the previous version still compile and run?).
Template: What / Why / Breaking Changes (none, or describe + migration path) / Checklist
(tests added, no new `any`, interfaces intact, docs updated if needed).

## CI/CD

Every PR: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
(coverage gate fails the build below threshold — see `testing` skill). On merge to `main`:
`pnpm build`, `changeset version`, `npm publish` for changed packages.

## Versioning

SemVer via Changesets (`pnpm changeset` → describe → `version` → `publish`). Breaking change
to `interfaces.ts` = MAJOR; backward-compatible feature = MINOR; fix = PATCH. **v1
commitment: no MAJOR bumps** — every `interfaces.ts` change during v1 must be additive-only
(optional fields), per the `constraints` and `interfaces` skills.

## Delivery lifecycle (normative, plan -> release)

Single source of truth for the end-to-end sequence 0-7. Normative — ad-hoc discretion is eliminated. All handoffs use the `handoff-protocol` schema; every step requires its pre-step checklist to be satisfied before proceeding. Other skills cross-reference this section; do not duplicate its rules.

0. **Govern milestone** — SPSA proposes, USER decides. Optional for small patches; required for multi-issue work. Milestone groups related issues.

1. **Create issue** — Required fields: Source, Branch, Acceptance criteria, Labels, Milestone (when applicable). DoR checklist must pass before implementation: scope is bounded, acceptance is testable, no `constraints` violation, no hidden `interfaces.ts` break, dependencies identified.

2. **JIT branch** — Create from `develop` only, immediately before implementation. Naming: `{feat|fix|chore|docs}/<slug>` (also `test`/`refactor` per Branching). No long-lived branches. Keep current via `rebase` on `develop`; never merge `develop` into the feature branch. Lifecycle closed by squash-merge with `--delete-branch`.

3. **Implement (SPBED)** — Follows `architecture`, `security`, `errors`, and `code-standards`. CI gate must pass before handoff to SPSA: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`. No handoff with red CI.

4. **SPSA review loop** — SPSA reviews against Correctness / Integrity / Security with file:line findings. If `REVISION_REQUIRED`, `flags` must be non-empty (one sentence per open issue). Max 3 fix cycles; iteration 4 triggers `ESCALATION.ITERATION_LIMIT` to `USER` per `handoff-protocol` iteration limit. Verdicts: `APPROVE` / `REQUEST CHANGES` / `REJECT`.

5. **SPQAE gate** — Mandatory when code or tests changed; optional for docs-only. SPQAE never `APPROVE` (per `github-ops` escalation rule); routes `SPQAE->SPBED` (test revision required) or `SPQAE->SPSA` (architectural signal / standard gap). Coverage threshold enforced per `testing` skill.

6. **PR & merge** — SPBED creates PR, SPSA approves, USER merges. PR requirements: Conventional Commits title, body What / Why / Breaking Changes (+ migration path) / Checklist (tests added, no new `any`, `interfaces.ts` intact, docs updated if needed), `pnpm audit --audit-level=high` clean, changeset file present. Checks must be green (`gh pr checks`). Merge: squash to `develop` with `--delete-branch`, commit message `Closes #n`. `gh pr merge` requires explicit USER go-ahead per `github-ops` escalate rule.

7. **Release (develop -> main)** — `develop` is dev trunk, `main` is release-only. Promotion `develop->main` via PR, then `changeset version`, `pnpm build`, `gh release create` (requires USER go-ahead). If ADR test is positive ("does this decision constrain all future implementations?"), SPSA drafts ADR and USER approves before writing to `DECISION-LOG.md`.

**Tiering:** Small, single-issue patches may skip 0 (milestone) and 5 (SPQAE) when docs-only and SPSA explicitly notes the skip. Never skip 3-CI gate, 4 (SPSA review), or 6 (PR checks / SPSA approval / USER merge).

**Skill loading (normative for this lifecycle):** `git-workflow` MUST be fully loaded via the skill tool for any work touching steps 0-7. `handoff-protocol` MUST be fully loaded when creating, validating, or consuming a handoff, checking iteration (cap 4), or deciding routing/escalation; otherwise a targeted grep for `iteration|flags|routing` is sufficient. `github-ops` MUST be fully loaded when running any `gh` command or deciding Autonomous vs Escalate; otherwise grep for `gh pr merge|gh release|Escalate` is sufficient for awareness. Grep MUST NOT be used to reconstruct normative values (schema, matrix, caps, DoD).

**Enforcement:** This section is normative. Pre-step checklist and handoff schema are mandatory gates. Audit trace: milestone -> issue(s) -> branch -> commit(s) -> PR -> squash-merge -> release. `develop`/`main` trunk discipline and branch lifecycle (rebase, squash, delete) are enforced via this lifecycle.

**Precedent:** v1.0.2 — milestone `1 v1.0.2` + issues #3-#7, branch `fix/memory-redis-atomic-writes` JIT from `develop`, `SPBED->SPSA NEEDS_REVISION` (pool leak) -> fix -> `SPSA APPROVE -> SPQAE 50/50 -> SPSA final green -> commit 31f932d -> PR #8 -> squash-merge b740282 to develop, issue #3 closed.

## Code review criteria, in order

1. **Correctness** — does it do what it claims; are edge cases (empty arrays, null,
   network failure) handled; does it follow the state machine rules (`architecture` skill)?
2. **Contract compliance** — honors `interfaces.ts`; throws correct `OrchestratorError`
   subtypes; `isRetryable()` respected (`errors` skill).
3. **Security** — no secrets/credentials in code or logs; tool inputs validated before
   execution; no `eval()`; error messages don't leak internals (`security` skill).
4. **Performance** — no unnecessary `await` in hot paths, no sync-blocking in async
   functions, no state accumulated across calls.
5. **Readability** — would another developer understand this in 30 seconds; intention-
   revealing names; DRY.

## Dependency policy

`@atisse/core` runtime deps: Zod only — anything else needs architecture discussion (Hard
Stop, see `AGENTS.md`). Adapter packages declare the provider SDK as a `peerDependency`,
never a direct dependency. `pnpm audit --audit-level=high` must be clean on every PR;
`pnpm audit` fully clean before release.

## Definition of done

Implementation complete → unit tests (happy path + error cases) → integration test updated
if needed → coverage meets threshold → TypeDoc on public exports → lint/typecheck clean →
changeset file created → PR approved and merged.
