# @atisse/core — Agent Instructions

A lightweight, production-grade execution kernel for managing the LLM interaction
lifecycle. TypeScript-first, Node.js 20+, monorepo under the `@atisse` namespace.

---

## Lazy Loading Instructions

CRITICAL: Load the files below ONLY when they are directly relevant to the current
task. Do NOT preload all references. Use the Read tool to load on a need-to-know
basis. Treat loaded content as mandatory instructions that override defaults.

### Load when throwing, catching, mapping, or classifying errors; implementing retry logic; evaluating whether an error is retryable or fatal
@.opencode/rules/error-taxonomy.md

### Load when working on lifecycle states, pipeline steps, state transitions, retry flow, fallback logic, or any code that touches LifecycleStateMachine
@.opencode/rules/state-machine.md

### Load when adding, modifying, or reviewing exported symbols, public methods, or interface fields; classifying breaking changes under SemVer
@.opencode/rules/api-design.md

### Load when designing a new feature, evaluating structural decisions, applying SOLID principles, or determining which layer a file belongs to
@.opencode/rules/design-principles.md

### Load when writing any implementation code — defensive programming, complexity limits, concurrency safety, code quality standards
@.opencode/rules/implementation-standards.md

### Load when writing TypeScript — naming conventions, type declarations, async patterns, import ordering, ESLint/Prettier standards
@.opencode/rules/typescript-style.md

### Load when scoping a new feature, assessing whether a request fits project identity, or explaining what the project does and does not do
@.opencode/rules/project-description.md

### Load when questioning an existing architectural choice, proposing a change that may conflict with a recorded decision, or evaluating a new ADR
@.opencode/rules/decision-log.md

### Load when scoping work against milestones, checking v1 exit criteria, or evaluating whether a feature belongs in the current phase
@.opencode/rules/roadmap.md

### Load for branching, commit conventions, pull request requirements, versioning with Changesets, CI/CD pipeline steps, definition of done
@.opencode/workflows/sdlc.md

### Load when writing or reviewing tests — structure, MockProvider contract, coverage thresholds, required scenarios, error path coverage
@.opencode/workflows/testing-standards.md

### Load when building a new provider, memory adapter, context provider, or tool adapter — checklists, templates, error mapping rules
@.opencode/workflows/adapter-pattern.md

### Load when adding lifecycle hooks or event bus listeners — contract differences, hook contexts, listener rules, decision guide
@.opencode/workflows/hooks-events.md

### Load when throwing, catching, or mapping errors in adapters, hooks, tools, or user code — cause preservation, message guidelines
@.opencode/workflows/error-handling.md

### Load when adding log statements, event emissions, or runId correlation points — levels, required points, debuggability rules
@.opencode/workflows/observability-standards.md

---

## Agent Profiles

Invoke role profiles explicitly using `@` mention:

- `@spsa` — Senior Principal Software Architect
- `@spbed` — Senior Principal Back-End Developer
- `@spqae` — Senior Principal QA Engineer