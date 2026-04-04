# TASK CONTEXT
## How the AI Agent Should Approach Tasks in This Project

This document defines how to interpret task instructions, prioritize decisions,
and maintain consistency when implementing features in this codebase.

---

## Before Starting Any Task

1. **Read the task description completely** before writing any code
2. **Identify which layer the task belongs to:**
   - `core/` — kernel behavior (retry, lifecycle, hooks, events, prompt composition)
   - `adapter package` — wrapping an external system (provider, memory, context)
   - `tests/` — adding or improving test coverage
   - `docs/` — documentation
3. **Check `rules/interfaces-core.md` and `rules/interfaces-runtime.md`** — if your task touches `interfaces.ts`, flag it first
4. **Check `rules/constraints.md`** — confirm the task doesn't violate v1 scope

---

## File Location Rules

When creating a new file, use this decision table:

| What you're creating | Where it goes |
|---|---|
| Public contract (interface, type) | `packages/core/src/interfaces.ts` |
| Error class | `packages/core/src/errors.ts` |
| Core behavior (retry, hooks, events) | `packages/core/src/` |
| Provider adapter | `packages/provider-{name}/src/index.ts` |
| Memory adapter | `packages/memory-{name}/src/index.ts` |
| Context provider | `packages/context-{name}/src/index.ts` |
| Unit test | `packages/{name}/tests/unit/` |
| Integration test | `packages/core/tests/integration/` |
| Working example | `examples/{number}-{name}/` |
| Documentation | `docs/` |

---

## Implementation Decision Order

When multiple approaches seem valid, apply these criteria in order:

1. **Does it violate `PHILOSOPHY.md`?** → Reject it
2. **Does it violate `CONSTRAINTS.md`?** → Reject it
3. **Does it break `INTERFACES.md`?** → Reject it, propose backward-compatible alternative
4. **Is it DRY?** → Reuse existing utilities (`executeWithRetry`, `runHooks`, etc.)
5. **Is it testable?** → Prefer the option that's easier to test in isolation
6. **Is it minimal?** → Choose the simpler implementation

---

## When Implementing Core Features

Follow this sequence:

```
1. Write the interface / type change in interfaces.ts (if needed)
2. Write the error type (if a new failure mode is introduced)
3. Write the implementation
4. Write the unit test (using MockProvider)
5. Update the integration test if the run() flow changed
6. Run: pnpm typecheck && pnpm lint && pnpm test
```

---

## When Implementing an Adapter

Follow this sequence:

```
1. Read workflows/adapter-pattern.md
2. Create the package directory structure
3. Implement the adapter class against the correct interface
4. Map all external errors to OrchestratorError subclasses
5. Write tests (unit tests with MockProvider, NOT real API calls)
6. Add to pnpm-workspace.yaml
7. Run: pnpm typecheck && pnpm lint && pnpm test (from repo root)
```

---

## Code Generation Guidelines

### Always include these in generated code:

- `import type { ... }` for interface/type imports
- Explicit return types on all public methods
- JSDoc on all exported classes and methods
- Error mapping to `OrchestratorError` subtypes in adapters
- `readonly` on interface fields that should not be mutated
- `try/catch` with typed `error: unknown` in all async methods

### Never include these in generated code:

- `any` type (use `unknown` + narrowing)
- Non-null assertions (`!`) unless provably safe
- `var` declarations
- Mutable function parameters
- `console.log` in production code (use `logger` interface)
- Hard-coded API keys, secrets, or URLs
- Imports from concrete adapter packages inside `core/`

---

## Asking for Clarification

If a task is ambiguous on these points, resolve ambiguity before coding:

1. **Is this a new interface?** If yes — confirm it won't break existing adapters
2. **Is this a new dependency?** If yes — confirm it belongs in the layer
3. **Does this add state to Orchestrator instance?** If yes — that's likely wrong
4. **Does this belong in core or in a new adapter?** See Philosophy Principle 7

---

## Output Format for Code Tasks

When completing a code task, structure output as:

```
1. Summary of changes (2-3 sentences)
2. Files created/modified (list)
3. Code blocks for each file
4. Tests added (list what each test covers)
5. Any follow-up tasks or open questions
```

---

## Handoff Package

Every task that requires routing to another profile MUST be closed with a
Handoff Package. This package serves two purposes: human-readable routing
instructions during manual operation, and machine-parsable routing data for
future orchestration.

The package consists of a prose summary followed by a fenced `handoff` block
containing a single JSON object. The JSON block is the authoritative payload —
the prose summary is for human readability only.

---

### Schema

```handoff
{
  "schema_version": "1.0",
  "task_id":        "<uuid-v4>",
  "task_label":     "<PROFILE>*<semantic-slug>*<random-4-digit-int>",
  "source":         "<SPSA | SPBED | SPQAE | SPDOE>",
  "destination":    "<SPSA | SPBED | SPQAE | SPDOE | USER>",
  "routing_reason": "<ACTION>.<DOMAIN>",
  "iteration":      "<integer — starts at 1, increments on each handoff>",
  "status":         "<completed | flagged | approved | rejected | needs_review>",
  "artifacts":      ["<file paths created or modified>"],
  "flags":          ["<open issues requiring attention — empty array if none>"],
  "required_action": "<single, specific action expected from the destination>",
  "context_summary": "<brief paragraph — what destination needs to know to proceed>"
}
```

### Field Rules

**`task_id`** — Generated once by the originating agent using UUID-v4 format.
Never regenerated on subsequent handoffs. This is the stable identifier for
orchestration tracing.

**`task_label`** — Human-readable slug. Format: `PROFILE*semantic-slug*NNNN`.
Example: `SPBED*implement-retry-backoff*3847`. Semantic slug uses lowercase
kebab-case, max 5 words. Random suffix is a 4-digit integer.

**`routing_reason`** — Composed of exactly one ACTION value and one DOMAIN
value separated by a dot. No free text. No deviations.

ACTION values:

| Value | Meaning |
|---|---|
| `REVIEW_REQUIRED` | Destination must inspect and decide |
| `REVISION_REQUIRED` | Source must rework; destination identified the gap |
| `ESCALATION` | Human intervention required |
| `APPROVED` | Work accepted; destination may proceed |
| `REJECTED` | Work not accepted; source must address findings |

DOMAIN values:

| Value | Scope |
|---|---|
| `CONTRACT` | `interfaces.ts` or frozen contracts |
| `SECURITY` | Trust boundary violation — `SECURITY.md` |
| `ARCHITECTURE` | ADR conflict or structural design decision |
| `TEST_QUALITY` | Test sufficiency or coverage threshold |
| `SCOPE` | v1 scope violation — `CONSTRAINTS.md` |
| `RELEASE` | Versioning or publish decision |
| `ITERATION_LIMIT` | Reserved — iteration cap reached; see below |

**`iteration`** — Starts at 1 on the first handoff. Each subsequent handoff
increments by 1. When `iteration` reaches 4 (i.e. the third handoff has
already occurred), the agent MUST override `destination` to `USER` and set
`routing_reason` to `ESCALATION.ITERATION_LIMIT` regardless of the original
routing intent. This rule is not subject to agent discretion.

**`artifacts`** — Full relative paths from repo root. Empty array `[]` is valid
when no files were produced (e.g. a rejection with findings only).

**`flags`** — Each entry is a single sentence describing one open issue. If the
routing_reason ACTION is `REVIEW_REQUIRED` or `REVISION_REQUIRED`, this array
MUST NOT be empty.

**`required_action`** — One sentence. Starts with a verb. Tells the destination
exactly what to do next. Example: `"Review the interface change proposal in
flags[0] and approve or reject with rationale."`

---

### Routing Authority Matrix

| Source | Permitted Destinations | Condition |
|---|---|---|
| SPBED | SPSA | Hard Stop triggered or task complete |
| SPBED | USER | `ESCALATION.ITERATION_LIMIT` only |
| SPSA | SPBED | Revision required |
| SPSA | SPQAE | Test review required |
| SPSA | USER | Approval needed or iteration limit |
| SPQAE | SPBED | Test revision required |
| SPQAE | SPSA | Architectural signal or standard gap |
| SPQAE | USER | `ESCALATION.ITERATION_LIMIT` only |

Any destination not listed for a given source is FORBIDDEN. An agent MUST NOT
route outside its permitted destinations under any circumstances.

---

### Minimal Example

Task completed by SPBED, no flags, routed to SPSA for architectural review:

```handoff
{
  "schema_version": "1.0",
  "task_id":        "a3f8c1d2-7b4e-4f2a-9c6d-0e5b3f1a8d7c",
  "task_label":     "SPBED*implement-retry-backoff*3847",
  "source":         "SPBED",
  "destination":    "SPSA",
  "routing_reason": "REVIEW_REQUIRED.ARCHITECTURE",
  "iteration":      1,
  "status":         "completed",
  "artifacts":      ["packages/core/src/retry.ts", "packages/core/tests/unit/retry.test.ts"],
  "flags":          [],
  "required_action": "Review retry backoff implementation for ADR-007 compliance and approve or reject.",
  "context_summary": "Implemented exponential backoff with jitter in retry.ts. No interface changes were required. All existing tests pass. No Hard Stops were triggered during implementation."
}
```