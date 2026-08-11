---
name: principles
description: Why @atisse/core is built the way it is — project identity, the 7 non-negotiable design principles, SOLID application, and layering rules. Load before designing a new feature, adding a dependency, proposing a structural change, or when a design choice feels ambiguous and needs a tiebreaker.
license: MIT
compatibility: opencode
---

# Principles

`@atisse/core` is a production-grade execution kernel for the LLM interaction lifecycle —
not an agent framework, workflow engine, or SaaS platform. It turns a raw provider SDK call
into a managed, deterministic, observable execution: retry/fallback, pluggable memory and
context, an event bus, and interface-first adapters, without the opaque behavior of a heavy
framework. Package map, tech stack, and non-goals live in `PACKAGES.md` at repo root — that
changes with the workspace, not with design intent, so it's kept separate from this skill.

## The 7 principles, in priority order when they conflict

1. **Interface-first** — core depends only on `interfaces.ts`, never on a concrete adapter.
   Dependency direction is always adapter → core, never the reverse.
2. **Stateless core** — `run()` stores nothing on `this`; every call is isolated and
   reproducible. Two concurrent `run()` calls must not interfere.
3. **Explicit over magical** — every behavior has a traceable code path. No hidden state,
   no monkey-patching, no implicit side effects.
4. **Kernel, not framework** — if a feature requires the system to _decide_ something on
   the user's behalf (plan, chain steps, reason autonomously), it doesn't belong here.
5. **Production-ready defaults** — a developer who ships without reading the docs should
   still get safe reliability behavior (see default policy values in the `constraints` skill).
6. **Config over code** — behavior comes from config objects and profiles, not subclassing
   or method overrides.
7. **Small core, large ecosystem** — core stays small and stable; growth happens through
   adapter packages, never by expanding what core is responsible for.

## SOLID, applied here (not the textbook version — the project-specific tell)

- **S**: a class with a provider-parsing method _and_ a Redis-key-formatting method is
  doing two jobs — split it.
- **O**: new capability (e.g. RAG) is a new adapter behind an existing interface
  (`ContextProvider`), never an `if` branch inside `Orchestrator`.
- **L**: every `AIProvider` implementation must accept the same request shape, return the
  same response shape, and throw `OrchestratorError` subtypes — swappable without
  behavior change.
- **I**: interfaces stay small and single-purpose (`AIProvider`, `MemoryAdapter`,
  `ContextProvider` are separate, not one `UniversalAdapter`).
- **D**: core imports `type { AIProvider }` from `interfaces.ts`, never `from 'openai'`.

**DRY tell:** if you're about to write retry logic, an error code as a string literal, or a
policy default anywhere outside `policies.ts` / `errors.ts` / `interfaces.ts`, stop — import
the existing one instead.

## Layering — dependencies flow down only

```
Layer 0  contracts    interfaces.ts, errors.ts, types.ts
Layer 1  primitives   lifecycle.ts, policies.ts, prompt-composer.ts
Layer 2  controllers  tool-controller.ts, hooks.ts, events.ts
Layer 3  pipeline     pipeline.ts
Layer 4  surface      orchestrator.ts
Adapters              depend on Layer 0 only — never L1-L4
```

An upward import (e.g. `lifecycle.ts` importing from `orchestrator.ts`) is always forbidden,
regardless of how convenient it seems for the specific case.

## Patterns already in use — reuse, don't reinvent

Policy objects (`RetryPolicy`, `ToolPolicy`) are the **strategy** pattern — swap behavior by
swapping config, not by subclassing. Providers/memory/context adapters are the **adapter**
pattern. Hooks are **chain of responsibility** — serial, each stage transforms and passes
on. The event bus is **observer** — decoupled emission from handling. `new Orchestrator(config)`
is an implicit **factory**. If a new feature doesn't fit one of these five, that's worth
noticing before writing it — it may be reaching for a pattern the kernel deliberately
doesn't use (see principle 4).
