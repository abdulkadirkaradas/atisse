---
name: testing
description: Test framework, coverage thresholds, MockProvider API, and required test scenarios for @atisse/core. Load when writing or reviewing any test.
license: MIT
compatibility: opencode
---

# Testing

**Philosophy:** tests are documentation — read like a spec; no API keys, ever
(`MockProvider` only); one assertion (or closely related group) per test; test behavior
(`run()`'s output), not internals (`pipeline.ts` internals); unit tests <50ms, integration
<500ms.

Framework: Vitest + `@vitest/coverage-v8`. Fake timers per-test only
(`vi.useFakeTimers()`), never globally.

## Coverage minimums (blocks PR if under)

`core` 70% lines/branches · `provider-openai`/`provider-anthropic`/`memory-inmemory`/
`memory-redis` 60% lines · `context-rag` 50% lines.

## Layout

```
packages/{name}/tests/
├── unit/            lifecycle.test.ts, policies.test.ts, errors.test.ts, ...
├── integration/      orchestrator.test.ts, streaming.test.ts, profiles.test.ts, ...
└── fixtures/         builders.ts, mock-tools.ts, mock-memory.ts
```

## MockProvider

```typescript
provider.enqueue({ text, toolCalls?, finishReason? } | { error: OrchestratorError }): this
```

FIFO — one entry dequeued per `generate()`/`generateStream()` call. `{error}` throws it;
`{text}` returns a `PromptResponse` (`usage: {0,0,0}`, `finishReason: 'stop'` unless
overridden). **Empty queue → throws `ProviderUnavailableError`** — enqueue enough entries
for every expected call. Streaming: each `{text}` splits into char-level chunks + trailing
`{type:'done'}`; `{error}` yields `{type:'error'}`.

Introspection: `callCount()`, `wasCalledTimes(n)`, `lastRequest()`, `calls()`, `reset()`
(clears queue + history + counter).

## Fixtures

`MockMemoryAdapter` — error-injection capable (`loadError`/`saveError` fields); use in unit
tests exercising memory failure. In integration tests prefer the real `InMemoryAdapter`
unless avoiding a core→adapter dependency matters (e.g. concurrency/stress tests).
`mock-tools.ts`: `echoTool`, `failingTool` (throws `ToolExecutionError`),
`validationFailTool` (throws `ToolValidationError`), `slowTool` (for timeout tests).
`builders.ts`: `buildConfig()` (MockProvider + `retry:{maxAttempts:1,baseDelayMs:0,
jitter:false}`), `buildTool()`, `buildProfile()`.

## Integration test provider rule

Adapter-to-Orchestrator wiring tests may use a real adapter with the underlying SDK mocked
via `vi.mock()` — never mock provider internals, never make a live call. Verify the
adapter's kernel integration (retry, hooks, transitions, error propagation), not SDK
behavior itself. Use `MockProvider` for provider-behavior unit tests (error mapping,
streaming chunk assembly).

## What must be tested

Every `OrchestratorError` subtype's retry/fatal behavior · every valid _and_ invalid state
transition (invalid → `InvalidStateTransitionError`) · profile-merge correctness · hooks
run serially and can halt execution · `runHooks()` throws on `undefined`/`null` return ·
events fire at correct points without affecting outcome · tool round counter is cumulative,
never resets · memory loads before composition, saves atomically after `COMPLETING` ·
streaming chunk order/types · `run.input.prompt` is always `role:'user'` (assert it, don't
assume) · empty `inputSchema: {}` → construction-time `ConfigValidationError` (required) +
runtime `ToolValidationError` via `z.never()` fallback (recommended, defense-in-depth) ·
cross-session isolation (`load('session-A')` never returns session-B data) ·
`stream:true`+`fallbackProvider`, `allowParallelTools:true`, `maxToolRounds:0`, duplicate
tool names, unknown profile key → all `ConfigValidationError`.

**Not tested:** private methods/internal state, third-party SDK behavior, framework code.

## Retry test pattern (fake timers)

```typescript
provider
  .enqueue({ error: new ProviderRateLimitError('429', 50) })
  .enqueue({ error: new ProviderRateLimitError('429', 50) })
  .enqueue({ text: 'Success on attempt 3' });
vi.useFakeTimers();
const result = orchestrator.run({ prompt: 'test' });
await vi.runAllTimersAsync(); // advances backoff delays without wall-clock waiting
expect(await result).toMatchObject({ text: 'Success on attempt 3' });
expect(provider.wasCalledTimes(3)).toBe(true);
vi.useRealTimers(); // always restore, even on assertion failure
```

A non-retryable error (e.g. `ProviderAuthError`) needs no fake timers — assert
`wasCalledTimes(1)` and that the `run()` rejection is the same error type.
