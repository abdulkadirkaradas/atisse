---
description: Branching, commit conventions, pull request requirements, versioning with Changesets, CI/CD pipeline steps, and the definition of done for any feature or fix.
---

# SDLC
## Software Development Lifecycle — Workflow and Process Standards

---

## Branch Strategy

```
main          ← production-ready, always green, protected
  │
  ├── feat/add-anthropic-provider
  ├── feat/streaming-support
  ├── fix/retry-delay-calculation
  └── chore/update-vitest
```

### Branch Naming
```
feat/<short-description>    New feature
fix/<short-description>     Bug fix
chore/<short-description>   Maintenance, deps, config
docs/<short-description>    Documentation only
test/<short-description>    Test additions/fixes only
refactor/<short-description> Code restructuring, no behavior change
```

---

## Commit Conventions (Conventional Commits)

Format: `<type>(<scope>): <description>`

```
feat(core): add streaming support to run() method
fix(retry): use retryAfterMs from ProviderRateLimitError
chore(deps): update openai sdk to 4.x
docs(adapter): add writing-adapters guide
test(orchestrator): add fallback exhaustion test
refactor(pipeline): extract context injection to separate function
```

**Types:** `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`  
**Scopes:** `core`, `retry`, `streaming`, `hooks`, `events`, `tools`, `memory`, `adapter`, `deps`

Commits on `main` are squash-merged. Feature branch commits can be messy.

---

## Pull Request Requirements

Every PR must:
1. Have a clear title using Conventional Commits format
2. Include a description of WHAT changed and WHY
3. Pass all CI checks (lint, typecheck, test)
4. Maintain or improve test coverage
5. Not introduce new `any` types
6. Not modify `interfaces.ts` in a breaking way (check: does existing code still compile?)

### PR Template
```markdown
## What
Brief description of the change.

## Why
The motivation — what problem does this solve?

## Breaking Changes
- [ ] None
- [ ] Yes: [describe what breaks and migration path]

## Checklist
- [ ] Tests added for new behavior
- [ ] No new `any` types introduced
- [ ] `interfaces.ts` not broken for existing adapters
- [ ] Documentation updated if needed
```

---

## CI/CD Pipeline

### On every PR (GitHub Actions)

```yaml
jobs:
  quality:
    steps:
      - pnpm install
      - pnpm lint              # ESLint
      - pnpm typecheck         # tsc --noEmit
      - pnpm test              # vitest run
      - pnpm test:coverage     # fail if below thresholds
```

### On merge to main

```yaml
jobs:
  release:
    steps:
      - pnpm install
      - pnpm build             # tsup
      - changeset version      # bump versions from changesets
      - npm publish            # publish changed packages
```

---

## Versioning (Semantic Versioning)

Format: `MAJOR.MINOR.PATCH`

| Change type | Version bump | Example |
|---|---|---|
| Breaking change to `interfaces.ts` | MAJOR | 1.0.0 → 2.0.0 |
| New feature (backward-compatible) | MINOR | 1.0.0 → 1.1.0 |
| Bug fix | PATCH | 1.0.0 → 1.0.1 |

**v1 commitment:** No MAJOR bumps during v1. All changes to `interfaces.ts` must be backward-compatible (optional fields only).

Versions are managed via Changesets:
```bash
pnpm changeset          # describe what changed
pnpm changeset version  # bump versions
pnpm changeset publish  # publish to npm
```

---

## Code Review Criteria

When reviewing or writing code, evaluate against these criteria in order:

### 1. Correctness
- Does it do what it claims?
- Are edge cases handled (empty arrays, null/undefined, network failures)?
- Does it follow the state machine rules?

### 2. Contract Compliance
- Does it honor `interfaces.ts`?
- Does it throw the correct `OrchestratorError` subtypes?
- Is `isRetryable()` respected?

### 3. Security
- No secrets or credentials in code or logs
- Tool inputs are validated before execution
- No `eval()` or dynamic code execution
- Error messages don't expose internal system details to end users

### 4. Performance
- No unnecessary `await` in hot paths
- No blocking synchronous operations inside async functions
- Memory not accumulated across calls (stateless core)

### 5. Readability
- Would another developer understand this in 30 seconds?
- Are variable names intention-revealing?
- Is the code DRY?

---

## Local Development Workflow

```bash
# Setup
pnpm install

# Development (watch mode)
pnpm dev               # build in watch mode
pnpm test:watch        # test in watch mode

# Before committing
pnpm lint              # must pass
pnpm typecheck         # must pass
pnpm test              # must pass

# Running specific package
cd packages/core
pnpm test
pnpm build
```

---

## Dependency Policy

| Category | Policy |
|---|---|
| Core runtime dependencies | Keep minimal. Each new dep requires justification. |
| `@atisse/core` deps | Only Zod (schema validation). Everything else is devDep. |
| Adapter deps | Provider SDK as peer dep, not direct dep. |
| Dev dependencies | Vitest, ESLint, Prettier, tsup, TypeDoc |
| Security | `pnpm audit` must pass before any release |

**Peer dependencies:** Adapter packages declare the provider SDK as a `peerDependency`.
This keeps the core lean and lets users bring their own SDK version.

```json
// packages/provider-openai/package.json
{
  "peerDependencies": {
    "openai": ">=4.0.0"
  }
}
```

---

## Definition of Done

A feature is "done" when:

- [ ] Implementation complete
- [ ] Unit tests written (covers happy path + error cases)
- [ ] Integration test updated if needed
- [ ] Coverage meets or exceeds thresholds
- [ ] TypeDoc comments on all public exports
- [ ] No lint or typecheck errors
- [ ] PR approved and merged
- [ ] Changeset file created for version bump
