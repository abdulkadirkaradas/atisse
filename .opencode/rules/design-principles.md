# DESIGN PRINCIPLES

## Architectural Thinking and Structural Design Standards

This document defines HOW WE THINK when designing features and making structural decisions.
Read this before designing a new feature, adding a dependency, or proposing an architectural change.

---

## SOLID Principles

### S — Single Responsibility

Each class/module has ONE reason to change.

```typescript
// WRONG — Orchestrator does too much
class Orchestrator {
  run() { ... }
  parseOpenAIResponse() { ... }   // provider concern
  formatRedisKey() { ... }        // adapter concern
  calculateTokenCost() { ... }    // analytics concern
}

// CORRECT — responsibilities separated
class Orchestrator { run() { ... } }
class OpenAIProvider { generate() { ... } }
class RedisMemoryAdapter { load(); save() { ... } }
```

### O — Open/Closed

Open for extension, closed for modification. New features via adapters — not by editing core.

```typescript
// WRONG — adding RAG by modifying core
class Orchestrator {
  async run(input) {
    if (this.config.useRAG) {
      const docs = await ragSearch(input.prompt);
    }
  }
}

// CORRECT — RAG as a ContextProvider adapter
class RAGContextProvider implements ContextProvider {
  async provide(input: RunInput): Promise<Message[]> { ... }
}
// Core unchanged. RAG added via config.contextProviders.
```

### L — Liskov Substitution

Any `AIProvider` implementation must be swappable without changing behavior.

```typescript
// Every AIProvider MUST:
// - Accept the same PromptRequest shape
// - Return the same PromptResponse shape
// - Throw OrchestratorError subclasses (not raw errors)
// - Honor timeout (or let the kernel wrap with AbortSignal)
```

### I — Interface Segregation

Interfaces are small and focused. Implementers only implement what they need.

```typescript
// WRONG — fat interface forces unnecessary implementation
interface UniversalAdapter {
  generate();
  stream();
  loadMemory();
  saveMemory();
  search();
  index();
}

// CORRECT — small, focused interfaces
interface AIProvider {
  generate();
  generateStream?();
}
interface MemoryAdapter {
  load();
  save();
  clear();
}
interface ContextProvider {
  provide();
}
```

### D — Dependency Inversion

High-level modules (core) depend on abstractions (interfaces), not concretions (OpenAI SDK).

```typescript
// WRONG — core depends on concrete implementation
import OpenAI from 'openai'; // in core — FORBIDDEN

// CORRECT — core depends on interface
import type { AIProvider } from './interfaces';
```

---

## DRY — Don't Repeat Yourself

Every piece of knowledge has a single authoritative location.

**Applies to:**

- Policy defaults — defined once in `policies.ts`, referenced everywhere
- Error codes — defined in error classes, never as magic strings
- Interface types — defined in `interfaces.ts`, imported by adapters
- Retry logic — one `executeWithRetry()` function, not per-call inline logic

```typescript
// WRONG — retry logic duplicated in multiple places
async function callProvider() {
  for (let i = 0; i < 3; i++) { ... }
}

// CORRECT — single retry utility
import { executeWithRetry } from './policies';
await executeWithRetry(() => provider.generate(request), config.retry);
```

---

## Design Patterns Used in This Project

### Strategy Pattern

Policy objects (`RetryPolicy`, `ToolPolicy`) are strategy objects. Swap behavior by swapping config.

```typescript
const aggressiveRetry: RetryPolicy = { maxAttempts: 5, baseDelayMs: 200, ... };
const conservativeRetry: RetryPolicy = { maxAttempts: 1, baseDelayMs: 0, ... };
```

### Adapter Pattern

Provider, memory, and context adapters wrap external systems behind the kernel's interfaces.

```typescript
class OpenAIProvider implements AIProvider {
  async generate(request: PromptRequest): Promise<PromptResponse> {
    const sdkResponse = await this.client.chat.completions.create(/* mapped params */);
    return this.mapToPromptResponse(sdkResponse);
  }
}
```

### Chain of Responsibility (Hooks)

Lifecycle hooks form a chain. Each handler processes and passes to the next.

```typescript
async function runHooks<T>(hooks: LifecycleHook<T>[], context: T): Promise<T> {
  let ctx = context;
  for (const hook of hooks) {
    ctx = await hook(ctx);
  }
  return ctx;
}
```

### Observer Pattern (Event Bus)

Event bus decouples event emission from event handling.

```typescript
orchestrator.on('run.completed', handler);
// emission and handling are decoupled — kernel does not know what listens
```

### Factory (Implicit)

`new Orchestrator(config)` acts as a factory that wires all components based on config.

---

## Abstraction Levels and Layering Rules

Every file belongs to exactly one layer. A layer may only depend on layers below it.
Skipping layers is forbidden.

```
Layer 0 — contracts:   interfaces.ts, errors.ts, types.ts
Layer 1 — primitives:  lifecycle.ts, policies.ts, prompt-composer.ts
Layer 2 — controllers: tool-controller.ts, hooks.ts, events.ts
Layer 3 — pipeline:    pipeline.ts
Layer 4 — surface:     orchestrator.ts
```

**Rules:**

- `orchestrator.ts` may import from `pipeline.ts` — allowed (L4 → L3)
- `pipeline.ts` may import from `tool-controller.ts` — allowed (L3 → L2)
- `tool-controller.ts` must NOT import from `pipeline.ts` — forbidden (L2 → L3, upward)
- `lifecycle.ts` must NOT import from `orchestrator.ts` — forbidden (L1 → L4, upward)
- Adapters (`provider-openai`, `memory-redis`) depend only on Layer 0 — never on L1–L4

```typescript
// WRONG — primitive layer reaching up to surface layer
// packages/core/src/lifecycle.ts
import { Orchestrator } from './orchestrator'; // FORBIDDEN — upward dependency

// CORRECT — primitive layer depends only on contracts
// packages/core/src/lifecycle.ts
import type { LifecycleState } from './types';
import { InvalidStateTransitionError } from './errors';
```
