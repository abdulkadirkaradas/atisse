---
name: git-workflow
description: Branching, commit conventions, PR requirements, CI/CD, versioning, and code-review criteria for @atisse/core. Load when committing, opening a PR, cutting a release, or reviewing one for process (not architectural) compliance.
license: MIT
compatibility: opencode
---

# Git workflow

## Branching and commits

Branch: `{feat|fix|chore|docs|test|refactor}/<short-description>`. Commits: Conventional
Commits, `<type>(<scope>): <description>` — scopes are `core`, `retry`, `streaming`,
`hooks`, `events`, `tools`, `memory`, `adapter`, `deps`. Append `!` after type/scope for a
breaking change (`feat!:`). `main` is squash-merged, so feature-branch commit hygiene
matters less than the final squashed message.

**Committing atomically:** split unrelated changes — even within the same file — into
separate commits by SRP. Every commit lists the absolute file paths it touches, for
traceability. In plan mode, produce the prioritized commit list and stop for verification
before touching git; in build mode, execute the list sequentially without waiting for
confirmation between commits — but never touch files outside build mode.

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
