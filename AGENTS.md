# @atisse/core — Agent Instructions

A lightweight, production-grade execution kernel for managing the LLM interaction
lifecycle. TypeScript-first, Node.js 24+, monorepo under the `@atisse` namespace.

---

## Mandatory Pre-Task Reading

> **Note:** Agent profiles (`@spsa`, `@spbed`, `@spqae`) contain role-specific
> reading sequences that extend but do not replace this list.

Read these before starting ANY task, in order:

1. `rules/agent-safety.md` — hard stops, protected files, forbidden commands
2. `rules/task-context.md` — task framing, file locations, decision order
3. `rules/constraints.md` — forbidden patterns, v1 scope hard limits
4. `rules/philosophy.md` — 7 principles; reject anything that violates them
5. `rules/security.md` — trust boundaries, S-1 through S-8

## Conditional Pre-Task Reading

| When...                             | File                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| Any feature touching execution flow | `rules/architecture.md`                                    |
| Any interface or type change        | `rules/interfaces-core.md` + `rules/interfaces-runtime.md` |

---

## Lazy Load Directives

All other files are loaded on demand. Consult `rules/index.md` for the full
routing table — which task triggers which file.

---

## Stale Documentations

`.opencode/stale-docs` includes legacy documentation that is no longer maintained. It is included here for reference only.
Stay away from these files unless especially instructed to read them.
They may contain outdated information and should not be relied upon for current practices or procedures.

The latest documents/instructions can be found at the following locations:
| Path                          | Description          |
| ----------------------------- | -------------------- |
| `./opencode/agents`           | Agent Profiles       |
| `./opencode/rules`            | Rules                |
| `./opencode/workflows`        | Workflows            |
| `./opencode/milestones`       | Implementation Plans |
| `./opencode/analysis-reports` | Analysis Reports     |

---

## Agent Profiles

Invoke role profiles explicitly using `@` mention:

- `@spsa` — Senior Principal Software Architect
- `@spbed` — Senior Principal Back-End Developer
- `@spqae` — Senior Principal QA Engineer
