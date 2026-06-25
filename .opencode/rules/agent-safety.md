# AGENT SAFETY

## Operational Execution Constraints

These rules govern what an agent may execute, modify, or trigger autonomously.
They apply to ALL role profiles (SPSA, SPBED, SPQAE) without exception.
When in doubt: STOP and ask.

---

## Confirmation Required — Always

The following actions MUST NEVER be performed without explicit human confirmation.
"I think it's safe" is not confirmation. A direct "yes, proceed" from the user is.

### File System — Protected Files

These files are **read-only** for all agents. No writes, no edits, no deletions:

| File                             | Owner       | Why Protected                                  |
| -------------------------------- | ----------- | ---------------------------------------------- |
| `rules/philosophy.md`            | User        | Core identity — user-owned                     |
| `rules/decision_log.md`          | SPSA + User | ADR write protocol — user approval required    |
| `rules/constraints.md`           | SPSA + User | v1 scope hard limits                           |
| `rules/security.md`              | SPSA + User | Trust boundary definitions                     |
| `workflows/testing-standards.md` | SPSA        | Coverage thresholds — architectural commitment |
| `workflows/sdlc.md`              | SPSA        | Release and branching rules                    |
| `agents/spsa.md`                 | User        | Authority boundary definitions                 |
| `agents/spbed.md`                | User        | Authority boundary definitions                 |
| `agents/spqae.md`                | User        | Authority boundary definitions                 |
| `rules/interfaces-core.md`       | SPSA        | Frozen contracts — MAJOR change territory      |
| `rules/interfaces-runtime.md`    | SPSA        | Frozen contracts — MAJOR change territory      |

**Any edit to these files requires:**

1. Explicit user instruction naming the file
2. SPSA evaluation (for contract/security files)
3. Human "proceed" confirmation

### Commands — Forbidden Without Confirmation

```
# Publication and release
npm publish
pnpm publish
changeset publish
changeset version

# Build and compile
pnpm build
pnpm --recursive build
tsup

# CI/CD
gh workflow run
act
Any GitHub Actions manual trigger

# Process management
kill
pkill
pm2 restart / stop / delete

# Destructive git operations
git push --force
git reset --hard
git rebase (on shared branches)
git tag + push (release tags)
```

### Commands — Safe (No Confirmation Needed)

```
# Read-only operations
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm --recursive lint / typecheck / test

# Inspection
cat, view, ls, find
git status, git log, git diff
pnpm why, pnpm list

# Dry runs
pnpm build --dry-run (if supported)
changeset status
```

---

## Instruction File Modification Rules

### New `*.md` files in `.agents/rules/` or `.agents/workflows/`

- SPBED: **FORBIDDEN** — cannot create new instruction files
- SPQAE: **FORBIDDEN** — cannot create new instruction files
- SPSA: **Requires user approval** before creation

### Existing instruction file edits

- Only permitted when a file is **not** in the Protected Files table above
- Character limit: **12,000 characters maximum** per file
- Exception: Implementation plan files (`M*-implementation-plan.md`) — no hard limit, but require explicit user approval before any edit
- Overflow protocol: Stop, report character count, request permission before condensing or splitting

### Source code files (`packages/`, `examples/`, `docs/`)

- SPBED: Full write authority within contract boundaries
- SPSA: Review authority — does not write implementation code
- SPQAE: Test files only (`packages/*/tests/`)

---

## Dependency Modification Rules

Changes to `package.json` files follow this protocol:

| Action                                   | Authority           | Condition                             |
| ---------------------------------------- | ------------------- | ------------------------------------- |
| Add devDependency to adapter package     | SPBED               | Justified in PR description           |
| Add devDependency to `@atisse/core`      | SPBED + SPSA review | Must be dev-only                      |
| Add runtime dependency to `@atisse/core` | **FORBIDDEN in v1** | Zod is the only permitted runtime dep |
| Add peerDependency to adapter package    | SPBED               | Provider SDK only                     |
| Bump existing dependency version         | SPBED               | `pnpm audit` must be clean after      |

Any `package.json` modification that introduces a new **runtime** dependency to `packages/core/` is a Hard Stop — escalate to SPSA immediately.

---

## Hard Stop Triggers

Stop all execution immediately and surface to the user when:

1. **A protected file edit is required** — report which file and why, then wait
2. **A forbidden command is needed** — describe the intent, request confirmation
3. **A new runtime dep is needed in core** — see Dependency Rules above
4. **Iteration limit reached (4)** — route to USER per Handoff Package protocol
5. **Task requires action not covered by this file** — do not infer permission; ask

---

## Escalation Format

When a Hard Stop is triggered, output exactly:

```
⛔ HARD STOP — [reason category]

File/Command affected: [name]
Why this requires confirmation: [one sentence]
Proposed action: [what the agent wants to do]
Required: Explicit human confirmation to proceed.
```

Do not proceed until the user responds with a clear "yes" or revised instruction.
