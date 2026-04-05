---
trigger: model_decision
description: Load when adding, modifying, or reviewing any exported symbol, public method, or interface field; or when classifying whether a change is a breaking change under SemVer.
---

# API DESIGN

## Public API Ergonomics and Contract Standards

This project is an open-source library. Its public API is a product.
Every exported symbol is a promise to every adapter author and every downstream user.
A poorly designed API cannot be fixed without a breaking change.

---

## API Design Principles

### 1. Make the Common Case Simple

The 80% use case must be achievable with minimal configuration.
Advanced options are available but never required.

```typescript
// Common case — works with zero knowledge of the full API
const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
});
const result = await orchestrator.run({ prompt: 'Hello' });

// Advanced case — all options available when needed
const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey, model: 'gpt-4o' }),
  fallbackProvider: new OpenAIProvider({ apiKey, model: 'gpt-4o-mini' }),
  retry: { maxAttempts: 5, baseDelayMs: 300, jitter: true },
  // ...
});
```

### 2. Impossible States Must Be Unrepresentable

The type system must make invalid configurations compile-time errors.
Runtime validation is a safety net — not the first line of defense.

```typescript
// WRONG — runtime discovery of misconfiguration
const result = await orchestrator.run({ prompt: '' });
// throws at runtime: "prompt cannot be empty"

// CORRECT — type system enforces non-empty strings where possible
// AND constructor validates eagerly with ConfigValidationError
```

### 3. Errors Must Tell the User What to Do

An `OrchestratorError` message should explain the problem and imply the fix.

```typescript
// WRONG — cryptic
throw new ConfigValidationError(['invalid value']);

// CORRECT — actionable
throw new ConfigValidationError(['retry.maxAttempts must be a positive integer — received: -1']);
```

### 4. Optional Configuration Uses Partial Types

Never require a user to specify the full policy when they only want to change one field.

```typescript
// WRONG — user must specify everything
new Orchestrator({
  provider,
  retry: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
  //       ^ user only wanted maxAttempts: 5, forced to repeat all defaults
});

// CORRECT — Partial<RetryPolicy> with defaults merged internally
new Orchestrator({
  provider,
  retry: { maxAttempts: 5 }, // only override what matters
});
```

### 5. Respect the Pit of Success

The default behavior must be the safe, production-appropriate behavior.
A user who does not read the docs should not ship an insecure or unreliable system.

```typescript
// Defaults are production-safe:
retry:   { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true }
timeout: { generateTimeoutMs: 30_000, toolTimeoutMs: 10_000, totalTimeoutMs: 60_000 }
tools:   { maxToolRounds: 5, allowParallelTools: false }
```

---

## Naming Conventions for Public API

| Element       | Convention                  | Example                                        |
| ------------- | --------------------------- | ---------------------------------------------- |
| Classes       | PascalCase, noun            | `Orchestrator`, `OpenAIProvider`               |
| Interfaces    | PascalCase, noun            | `AIProvider`, `RetryPolicy`                    |
| Methods       | camelCase, verb             | `run()`, `generate()`, `provide()`             |
| Config fields | camelCase, noun             | `maxAttempts`, `baseDelayMs`                   |
| Event types   | `noun.verb` (past tense)    | `run.completed`, `tool.failed`                 |
| Error classes | PascalCase, ends in `Error` | `ProviderAuthError`, `MaxRetriesExceededError` |

---

## What Constitutes a Breaking Change

Before modifying any exported symbol, classify the change:

### Breaking (requires MAJOR version)

- Removing an exported symbol (class, interface, function, type)
- Removing a field from an interface
- Changing a field type to an incompatible type (`number` → `string`)
- Changing a method signature (parameter types, return type)
- Narrowing a union type (removing a literal from `'stop' | 'tool_calls' | 'length'`)
- Making an optional field required

### Non-Breaking (MINOR or PATCH)

- Adding a new optional field to an interface
- Adding a new optional method to an interface
- Adding a new exported symbol
- Widening a union type (adding a new literal)
- Changing default values (document this clearly in changelog)
- Fixing incorrect behavior that was unintentionally breaking a contract

### The Test for Breaking

Ask: "Will existing adapter code that compiled against the previous version still compile
and run correctly against the new version?"

If NO → it is a breaking change.

---

## Adapter Author Contract

Adapter authors write code against `interfaces.ts`. The following guarantees
must hold for every version within v1:

1. `AIProvider`, `MemoryAdapter`, `ContextProvider` interfaces will not have required fields added
2. `OrchestratorError` and its subclasses will not change constructor signatures
3. `RunInput` and `RunOutput` will not have required fields added
4. All exported error classes will remain importable at the same path
5. `isRetryable()` will always accept `unknown` and return `boolean`

---

## `run()` Method Contract

`run()` is the primary API surface. Its contract is strict:

```typescript
// Contract guarantees:
// 1. If stream === false (default): returns Promise<RunOutput>
//    - RunOutput.text is always a string (never undefined)
//    - RunOutput.toolResults is always an array (empty if no tools called)
//    - RunOutput.usage reflects actual token consumption
//    - RunOutput.durationMs reflects wall-clock time of the entire run()
//
// 2. If stream === true: returns Promise<AsyncIterable<StreamChunk>>
//    - The iterable always ends with exactly one chunk of type 'done' or 'error'
//    - After 'done' or 'error', the iterable is exhausted
//    - Tool execution pauses the text stream — consumer receives tool_call/tool_result chunks
//
// 3. On any unrecoverable error: throws OrchestratorError subclass
//    - Never throws plain Error
//    - Never rejects with undefined or null
```

---

## Export Surface Rules

### Export Only What Users Need

Internal implementation details must not be exported.

```typescript
// WRONG — exporting internal utilities
export { runHooks } from './hooks'; // internal utility
export { VALID_TRANSITIONS } from './lifecycle'; // internal constant

// CORRECT — only export the public API
export { Orchestrator } from './orchestrator';
export type {
  AIProvider,
  MemoryAdapter,
  ContextProvider,
  OrchestratorConfig,
  RunInput,
  RunOutput,
  // ... other public types
} from './interfaces';
export {
  OrchestratorError,
  ProviderRateLimitError,
  ProviderAuthError,
  // ... all error classes (users must be able to catch them by type)
  isRetryable,
} from './errors';
```

### The `testing/` Subdirectory Is Not Private — It Is Intentionally Public

`MockProvider` is exported for adapter authors to use in their own tests:

```typescript
// Adapter authors can import MockProvider for their own tests
import { MockProvider } from '@atisse/core/testing';
```

---

## Documentation Requirements for All Public Exports

Every exported class, interface, and function MUST have a JSDoc comment.

```typescript
/**
 * The main orchestration class. Manages the full lifecycle of an LLM interaction:
 * context injection, prompt composition, provider call with retry/fallback,
 * tool execution, and memory persistence.
 *
 * @example
 * const orchestrator = new Orchestrator({
 *   provider: new OpenAIProvider({ apiKey: process.env.OPENAI_KEY }),
 * });
 * const result = await orchestrator.run({ prompt: 'Hello' });
 */
export class Orchestrator { ... }

/**
 * Policy configuration for retry behavior on transient provider failures.
 * All fields are optional — unspecified fields use production-safe defaults.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts before giving up or triggering fallback. Default: 3 */
  maxAttempts?: number;
  /** Base delay in milliseconds for the first retry. Subsequent retries use exponential backoff. Default: 500 */
  baseDelayMs?: number;
}
```
