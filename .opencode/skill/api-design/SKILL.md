---
name: api-design
description: Public API ergonomics and breaking-change classification for @atisse/core. Load before modifying or extending any exported symbol, or when classifying whether a change is breaking.
license: MIT
compatibility: opencode
---

# API design

The public API is a product — every export is a promise to adapter authors and downstream
users. A poorly designed API can't be fixed without a breaking change, so get it right
before merging, not after.

## Five principles

1. **Common case simple, advanced case possible.** `new Orchestrator({ provider })` +
   `run({ prompt })` must work with zero other knowledge; every advanced option stays
   optional.
2. **Impossible states unrepresentable.** Prefer type-system enforcement over runtime
   discovery; runtime validation (`ConfigValidationError`, eagerly, at construction) is the
   safety net, not the first line of defense.
3. **Errors say what to do.** `'retry.maxAttempts must be a positive integer — received:
-1'`, not `'invalid value'`.
4. **Optional config uses `Partial<T>`.** A user changing one field of `RetryPolicy` never
   has to restate the other three.
5. **Pit of success.** Defaults (see `interfaces` — `RetryPolicy`/`TimeoutPolicy`/`ToolPolicy`)
   must be production-safe — a user who never reads the docs shouldn't ship something broken.

## Naming

| Element              | Convention               | Example                        |
| -------------------- | ------------------------ | ------------------------------ |
| Classes / Interfaces | PascalCase noun          | `Orchestrator`, `RetryPolicy`  |
| Methods              | camelCase verb           | `run()`, `provide()`           |
| Config fields        | camelCase noun           | `maxAttempts`                  |
| Event types          | `noun.verb` past tense   | `run.completed`, `tool.failed` |
| Error classes        | PascalCase, ends `Error` | `ProviderAuthError`            |

## What's breaking (MAJOR)

Removing an export, removing an interface field, narrowing a field type (`number`→
`string`), changing a method signature, removing a union literal, making an optional field
required. **The test:** would code that compiled against the previous version still compile
and run correctly against the new one? If no, it's breaking.

**Not breaking:** adding an optional field or method, adding an export, widening a union
(new literal), changing a default value (document in changelog), fixing behavior that was
unintentionally violating a contract.

## Adapter author guarantees (hold for all of v1)

`AIProvider`/`MemoryAdapter`/`ContextProvider` never get required fields added ·
`OrchestratorError` subclasses never change constructor signatures · `RunInput`/`RunOutput`
never get required fields added · every exported error class stays importable at the same
path · `isRetryable()` always accepts `unknown`, returns `boolean`.

## `run()` contract (strict)

Non-streaming: always resolves `RunOutput` — `text` always a string (never undefined),
`toolResults` always an array. Streaming: the iterable always ends in exactly one `done` or
`error` chunk, then is exhausted; tool execution pauses (never streams) the text. Any
unrecoverable failure: always an `OrchestratorError` subclass, never a plain `Error`, never
a rejection with `undefined`/`null`.

## Export surface

Export only what users need — internal utilities (`runHooks`, `VALID_TRANSITIONS`) stay
unexported. `core/testing/` (`MockProvider`) is the one deliberate exception: intentionally
public so adapter authors can use it in their own tests
(`import { MockProvider } from '@atisse/core/testing'`).

Every public export needs a JSDoc comment — class/interface purpose plus an `@example`
where the shape isn't self-evident.
