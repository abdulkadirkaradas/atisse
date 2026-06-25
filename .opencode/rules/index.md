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
| `.opencode/rules/project-description.md` | Starting a task — understand what the project does and doesn't do |
| `.opencode/rules/philosophy.md`          | A design decision is ambiguous — check against the 7 principles   |
| `.opencode/rules/architecture.md`        | Implementing any feature — understand the full system structure   |

### contracts/ — Frozen Contracts

| File                          | Read when...                                                               |
| ----------------------------- | -------------------------------------------------------------------------- |
| `.opencode/rules/interfaces-core.md`    | Writing any adapter — provider, memory, context, tool contracts            |
| `.opencode/rules/interfaces-runtime.md` | Writing pipeline, hooks, events, config, profile, or Orchestrator features |
| `.opencode/rules/error-taxonomy.md`     | Throwing or catching errors — understand which type to use                 |
| `.opencode/rules/state-machine.md`      | Touching lifecycle, pipeline, or retry logic                               |

**Note:** Read both files when working on features
that cross the boundary (e.g. a provider adapter that also registers event listeners).

### standards/ — Engineering Standards

| File                                   | Read when...                                                           |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `.opencode/rules/design-principles.md`           | Designing a new feature or making a structural decision                |
| `.opencode/rules/implementation-standards.md`    | Writing any implementation code                                        |
| `.opencode/rules/typescript-style.md`            | Writing TypeScript — naming, typing, async patterns                    |
| `.opencode/workflows/testing-standards.md`       | Writing tests — framework, structure, coverage rules                   |
| `.opencode/workflows/sdlc.md`                    | Branching, committing, PRs, versioning                                 |
| `.opencode/workflows/observability-standards.md` | Adding logs or events — levels, runId correlation, required log points |
| `.opencode/rules/api-design.md`                  | Modifying or extending the public API                                  |
| `.opencode/rules/security.md`                    | Trust boundaries, threat model — read before any PR                    |

### patterns/ — Implementation Patterns

| File                           | Read when...                                        |
| ------------------------------ | --------------------------------------------------- |
| `.opencode/workflows/adapter-pattern.md` | Building a new provider, memory, or context adapter |
| `.opencode/workflows/hooks-events.md`    | Adding hooks or events                              |
| `.opencode/workflows/error-handling.md`  | Throwing, catching, or mapping errors               |

### agents/ — Role-Specific Agent Profiles

| File                        | Role                                |
| --------------------------- | ----------------------------------- |
| `.opencode/agents/spsa.md`  | Senior Principal Software Architect |
| `.opencode/agents/spbed.md` | Senior Principal Back-End Developer |
| `.opencode/agents/spqae.md` | Senior Principal QA Engineer        |

### agent/ — Agent-Specific Guidance

| File                    | Read when...                                               |
| ----------------------- | ---------------------------------------------------------- |
| `.opencode/rules/agent-safety.md` | Before executing ANY command or modifying ANY file         |
| `.opencode/rules/task-context.md` | Before starting any task — decision order, file locations  |
| `.opencode/rules/constraints.md`  | Before implementing anything — what is forbidden           |
| `.opencode/rules/decision-log.md` | Questioning an architectural choice — read rationale first |

---

## Lazy Load Directives

Load ONLY when directly relevant. Use the Read tool on a need-to-know basis.
Treat loaded content as mandatory instructions that override defaults.

| Load when... | File |
|---|---|
| Errors, retry logic, retryable classification | `.opencode/rules/error-taxonomy.md` |
| Lifecycle states, pipeline, LifecycleStateMachine | `.opencode/rules/state-machine.md` |
| Exported symbols, breaking change classification | `.opencode/rules/api-design.md` |
| Feature design, SOLID, layering decisions | `.opencode/rules/design-principles.md` |
| Writing any implementation code | `.opencode/rules/implementation-standards.md` |
| TypeScript — naming, async, imports | `.opencode/rules/typescript-style.md` |
| Scoping features against project identity | `.opencode/rules/project-description.md` |
| Questioning or conflicting with a recorded decision | `.opencode/rules/decision-log.md` |

| Branching, commits, PRs, versioning, CI/CD | `.opencode/workflows/sdlc.md` |
| Writing or reviewing tests | `.opencode/workflows/testing-standards.md` |
| Building provider, memory, or context adapter | `.opencode/workflows/adapter-pattern.md` |
| Adding hooks or event listeners | `.opencode/workflows/hooks-events.md` |
| Throwing, catching, mapping errors | `.opencode/workflows/error-handling.md` |
| Logs, events, runId correlation | `.opencode/workflows/observability-standards.md` |

---

## Quick Reference: Common Tasks

### "Starting a task as a role-specific agent"

1. `.opencode/agents/{role}.md` → Defines startup sequence and authority boundaries
2. Follow the Mandatory Reading sequence in your profile
3. Return here for navigation

### "Implement a new provider adapter"

1. `.opencode/rules/interfaces-core.md` → `AIProvider` interface
2. `.opencode/workflows/adapter-pattern.md` → full template
3. `.opencode/rules/error-taxonomy.md` → error mapping
4. `.opencode/workflows/testing-standards.md` → test structure

### "Design a new core feature"

1. `.opencode/rules/philosophy.md` → check against the 7 principles
2. `.opencode/rules/design-principles.md` → SOLID, layering rules, patterns
3. `.opencode/rules/architecture.md` → where it fits in the system
4. `.opencode/rules/constraints.md` → verify v1 scope

### "Write implementation code"

1. `.opencode/rules/implementation-standards.md` → defensive programming, complexity, quality
2. `.opencode/rules/typescript-style.md` → language conventions
3. `.opencode/workflows/error-handling.md` → error throwing and catching

### "Add a new lifecycle hook point"

1. `.opencode/rules/architecture.md` → execution flow
2. `.opencode/rules/interfaces-runtime.md` → HookRegistry interface
3. `.opencode/workflows/hooks-events.md` → hook vs event decision
4. `.opencode/workflows/observability-standards.md` → required log/event points
5. `.opencode/rules/constraints.md` → verify not breaking interfaces

### "Fix a retry bug"

1. `.opencode/rules/state-machine.md` → valid transitions
2. `.opencode/rules/error-taxonomy.md` → retryable classification
3. `.opencode/rules/architecture.md` → execution flow steps 5–8

### "Implement or debug a streaming feature"

1. `.opencode/rules/architecture.md` → Streaming Execution Flow section
2. `.opencode/rules/interfaces-core.md` → `StreamChunk` contract, `generateStream?` on `AIProvider`
3. `.opencode/rules/interfaces-runtime.md` → `StreamChunk` discriminated union
4. `.opencode/rules/constraints.md` → streaming + fallback forbidden combination
5. `.opencode/workflows/adapter-pattern.md` → Provider Adapter Checklist
6. `.opencode/workflows/testing-standards.md` → `MockProvider` streaming behavior

### "Add a new error type"

1. `.opencode/rules/error-taxonomy.md` → hierarchy and rules
2. `.opencode/rules/interfaces-core.md` → `OrchestratorErrorCode` union — add new code
3. `.opencode/rules/constraints.md` → no plain Error throws

### "Modify or extend the public API"

1. `.opencode/rules/api-design.md` → breaking change classification
2. `.opencode/rules/interfaces-core.md` + `.opencode/rules/interfaces-runtime.md` → frozen contract rules
3. `.opencode/rules/constraints.md` → what is forbidden
4. `.opencode/rules/decision-log.md` → why existing API decisions were made

### "Review a PR"

1. `.opencode/rules/constraints.md` → forbidden patterns
2. `.opencode/rules/design-principles.md` → structural correctness
3. `.opencode/rules/implementation-standards.md` → quality criteria
4. `.opencode/workflows/sdlc.md` → review criteria section

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
