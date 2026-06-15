# PROJECT DESCRIPTION

## AI Orchestration Kernel

---

## Identity

**Package name:** `@atisse/core`
**Type:** Open-source npm library (MIT)
**Runtime:** Node.js 24+, TypeScript 5+
**One-liner:** A lightweight, production-grade execution kernel for managing the LLM interaction lifecycle.

---

## Problem Statement

Most AI integrations fall into one of two anti-patterns:

1. **Raw SDK calls** — No retry, no fallback, no memory, no observability. Breaks in production.
2. **Heavy frameworks** (LangChain, etc.) — Opaque abstractions, hidden behavior, hard to debug, vendor-coupled.

**The gap:** A production-ready, minimal orchestration layer that manages the lifecycle of an LLM call without becoming a framework.

---

## What This Project Does

This project transforms a raw LLM SDK call into a **managed, deterministic, observable execution**:

| Without this project                  | With this project                                      |
| ------------------------------------- | ------------------------------------------------------ |
| `openai.chat.completions.create(...)` | Managed lifecycle with retry, fallback, context, tools |
| Manual retry logic per project        | Policy-driven retry with exponential backoff + jitter  |
| No fallback                           | Automatic provider fallback on failure                 |
| No memory                             | Pluggable MemoryAdapter (Redis, Postgres, in-memory)   |
| No RAG                                | Pluggable ContextProvider interface                    |
| No observability                      | Event bus + lifecycle hooks                            |
| Vendor-locked                         | Interface-first, swap providers freely                 |
| Untestable                            | MockProvider for full test coverage without API keys   |

---

## Capability Inventory (v1)

### Core Execution

- Deterministic lifecycle state machine (11 states, guarded transitions)
- Config-driven initialization — all behavior defined by config, not code
- Profile system — multiple behavior presets on one instance

### Provider Layer

- `AIProvider` interface — vendor-agnostic
- Official adapters: OpenAI, Anthropic
- Streaming: text delta and tool call streaming

### Reliability

- Retry policy — exponential backoff, jitter, provider-aware delay
- Fallback provider — automatic switch on max-retry exhaustion
- Typed error taxonomy — retryable vs fatal decisions at compile time

### Tools

- Tool registration via `Tool` interface
- Controlled execution loop with round limits
- Schema validation on tool input (Zod)

### Memory & Context

- `MemoryAdapter` interface (conversation history)
- `ContextProvider` interface (runtime context injection — e.g. RAG)
- Official adapters: in-memory, Redis

### Observability

- Lifecycle hooks — synchronous, pipeline-blocking interception
- Event bus — async, fire-and-forget telemetry/logging
- Structured `Logger` interface

---

## Package Structure

```
@atisse/core               <- kernel, frozen interfaces, MockProvider
@atisse/provider-openai    <- OpenAI adapter
@atisse/provider-anthropic <- Anthropic adapter
@atisse/memory-inmemory    <- Reference memory adapter
@atisse/memory-redis       <- Redis memory adapter
@atisse/context-rag        <- RAG context provider
```

---

## Target Audience

- Backend engineers building LLM-powered features
- Teams moving from prototype to production AI
- Contributors building provider/memory/context adapters

---

## Tech Stack

| Concern           | Tool                          | Notes                                                                    |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------ |
| Language          | TypeScript 5.4+               | `strict: true`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` |
| Runtime           | Node.js 24+                   | ESM + CJS dual output via tsup                                           |
| Package manager   | pnpm workspaces               | Monorepo — each adapter is an independent package                        |
| Build             | tsup                          | Produces ESM + CJS + `.d.ts` per package                                 |
| Test runner       | Vitest + @vitest/coverage-v8  | All tests use `MockProvider` — no real API calls                         |
| Schema validation | Zod                           | Only runtime dependency in `@atisse/core`                                |
| Linting           | ESLint + `@typescript-eslint` | `no-explicit-any`, `no-floating-promises` enforced                       |
| Formatting        | Prettier                      | `singleQuote`, `trailingComma: all`, `printWidth: 100`                   |
| API docs          | TypeDoc                       | All public exports must have JSDoc                                       |
| Versioning        | Changesets + SemVer           | No MAJOR bumps during v1                                                 |
| CI                | GitHub Actions                | lint → typecheck → test → coverage on every PR                           |

`tsconfig.base.json` is defined at the monorepo root. All packages extend it. Adapter packages declare their provider SDK as a `peerDependency` — never a direct dependency.

---

## Non-Goals (Never Implement in v1)

- Agent frameworks (autonomous planning, self-directed loops)
- Workflow engines (DAG execution, step chaining)
- Multi-agent systems
- Visual editors or no-code builders
- SaaS platforms or dashboards
- Prompt engineering DSLs

> If a requested feature is on this list, it belongs in user-land or a separate project — not in this kernel.
