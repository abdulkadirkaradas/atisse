# AGENT DOCS — INDEX

## AI Orchestration Kernel

Navigation reference for all agent instruction documents.
If operating as a role-specific agent, read your profile in `.opencode/agents/` first —
your profile defines the startup sequence and directs back here as needed.

---

## Document Map

### core/ — Project Identity

| File                           | Read when...                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| `rules/project-description.md` | Starting a task — understand what the project does and doesn't do |
| `rules/philosophy.md`          | A design decision is ambiguous — check against the 7 principles   |
| `rules/architecture.md`        | Implementing any feature — understand the full system structure   |
| `rules/roadmap.md`             | Scoping work or checking phase priorities                         |

### contracts/ — Frozen Contracts

| File                          | Read when...                                                               |
| ----------------------------- | -------------------------------------------------------------------------- |
| `rules/interfaces-core.md`    | Writing any adapter — provider, memory, context, tool contracts            |
| `rules/interfaces-runtime.md` | Writing pipeline, hooks, events, config, profile, or Orchestrator features |
| `rules/error-taxonomy.md`     | Throwing or catching errors — understand which type to use                 |
| `rules/state-machine.md`      | Touching lifecycle, pipeline, or retry logic                               |

**Note:** Read both files when working on features
that cross the boundary (e.g. a provider adapter that also registers event listeners).

### standards/ — Engineering Standards

| File                                   | Read when...                                                           |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `rules/design-principles.md`           | Designing a new feature or making a structural decision                |
| `rules/implementation-standards.md`    | Writing any implementation code                                        |
| `rules/typescript-style.md`            | Writing TypeScript — naming, typing, async patterns                    |
| `workflows/testing-standards.md`       | Writing tests — framework, structure, coverage rules                   |
| `workflows/sdlc.md`                    | Branching, committing, PRs, versioning                                 |
| `workflows/observability-standards.md` | Adding logs or events — levels, runId correlation, required log points |
| `rules/api-design.md`                  | Modifying or extending the public API                                  |
| `rules/security.md`                    | Trust boundaries, threat model — read before any PR                    |

### patterns/ — Implementation Patterns

| File                           | Read when...                                        |
| ------------------------------ | --------------------------------------------------- |
| `workflows/adapter-pattern.md` | Building a new provider, memory, or context adapter |
| `workflows/hooks-events.md`    | Adding hooks or events                              |
| `workflows/error-handling.md`  | Throwing, catching, or mapping errors               |

### agents/ — Role-Specific Agent Profiles

| File                        | Role                                |
| --------------------------- | ----------------------------------- |
| `.opencode/agents/spsa.md`  | Senior Principal Software Architect |
| `.opencode/agents/spbed.md` | Senior Principal Back-End Developer |
| `.opencode/agents/spqae.md` | Senior Principal QA Engineer        |

### agent/ — Agent-Specific Guidance

| File                    | Read when...                                               |
| ----------------------- | ---------------------------------------------------------- |
| `rules/agent-safety.md` | Before executing ANY command or modifying ANY file         |
| `rules/task-context.md` | Before starting any task — decision order, file locations  |
| `rules/constraints.md`  | Before implementing anything — what is forbidden           |
| `rules/decision-log.md` | Questioning an architectural choice — read rationale first |

---

## Quick Reference: Common Tasks

### "Starting a task as a role-specific agent"

1. `.opencode/agents/{role}.md` → Defines startup sequence and authority boundaries
2. Follow the Mandatory Reading sequence in your profile
3. Return here for navigation

### "Implement a new provider adapter"

1. `rules/interfaces-core.md` → `AIProvider` interface
2. `workflows/adapter-pattern.md` → full template
3. `rules/error-taxonomy.md` → error mapping
4. `workflows/testing-standards.md` → test structure

### "Design a new core feature"

1. `rules/philosophy.md` → check against the 7 principles
2. `rules/design-principles.md` → SOLID, layering rules, patterns
3. `rules/architecture.md` → where it fits in the system
4. `rules/constraints.md` → verify v1 scope

### "Write implementation code"

1. `rules/implementation-standards.md` → defensive programming, complexity, quality
2. `rules/typescript-style.md` → language conventions
3. `workflows/error-handling.md` → error throwing and catching

### "Add a new lifecycle hook point"

1. `rules/architecture.md` → execution flow
2. `rules/interfaces-runtime.md` → HookRegistry interface
3. `workflows/hooks-events.md` → hook vs event decision
4. `workflows/observability-standards.md` → required log/event points
5. `rules/constraints.md` → verify not breaking interfaces

### "Fix a retry bug"

1. `rules/state-machine.md` → valid transitions
2. `rules/error-taxonomy.md` → retryable classification
3. `rules/architecture.md` → execution flow steps 5–8

### "Implement or debug a streaming feature"

1. `rules/architecture.md` → Streaming Execution Flow section
2. `rules/interfaces-core.md` → `StreamChunk` contract, `generateStream?` on `AIProvider`
3. `rules/interfaces-runtime.md` → `StreamChunk` discriminated union
4. `rules/constraints.md` → streaming + fallback forbidden combination
5. `workflows/adapter-pattern.md` → Provider Adapter Checklist
6. `workflows/testing-standards.md` → `MockProvider` streaming behavior

### "Add a new error type"

1. `rules/error-taxonomy.md` → hierarchy and rules
2. `rules/interfaces-core.md` → `OrchestratorErrorCode` union — add new code
3. `rules/constraints.md` → no plain Error throws

### "Modify or extend the public API"

1. `rules/api-design.md` → breaking change classification
2. `rules/interfaces-core.md` + `rules/interfaces-runtime.md` → frozen contract rules
3. `rules/constraints.md` → what is forbidden
4. `rules/decision-log.md` → why existing API decisions were made

### "Review a PR"

1. `rules/constraints.md` → forbidden patterns
2. `rules/design-principles.md` → structural correctness
3. `rules/implementation-standards.md` → quality criteria
4. `workflows/sdlc.md` → review criteria section

---

## Non-Negotiable Rules (Memorize These)

1. `interfaces.ts` is FROZEN — no breaking changes
2. Core has ZERO imports from adapter packages
3. `run()` stores NO state on `this`
4. All errors thrown are `OrchestratorError` subtypes
5. No `any` types
6. `MockProvider` for all tests — no real API calls in CI
7. v1 scope: no agents, no workflows, no parallel tools, no streaming+fallback
8. `run.input.prompt` is ALWAYS `role: 'user'` — never `role: 'system'`
9. No secrets in logs, errors, or events — see `security.md` S-1
10. `stream: true` + `fallbackProvider` → `ConfigValidationError` — forbidden in v1
11. `profiles[key].name !== key` → `ConfigValidationError` at construction
12. Duplicate tool names → `ConfigValidationError` at construction
13. `allowParallelTools: true` → `ConfigValidationError`
14. `maxToolRounds < 1` → `ConfigValidationError`
15. Role-specific agents operate within authority boundaries defined in their profile
