# TESTING STANDARDS

## Test Strategy, Structure, and Coverage Requirements

---

## Testing Philosophy

1. **Tests are documentation.** A test should read like a specification.
2. **No API keys in tests.** All LLM calls use `MockProvider`.
3. **One assertion per test** (or closely related assertions).
4. **Test behavior, not implementation.** Test what `run()` returns, not how `pipeline.ts` works internally.
5. **Fast tests win.** Unit tests < 50ms. Integration tests < 500ms.

---

## Test Framework

```
Framework:  Vitest
Runner:     vitest run (CI), vitest watch (development)
Coverage:   @vitest/coverage-v8
Assertion:  expect (Vitest built-in)
Fake timers: vi.useFakeTimers() — activated per-test only, never globally
```

---

## Coverage Requirements

| Package                   | Minimum Coverage        |
| ------------------------- | ----------------------- |
| `@atisse/core`            | 70% lines, 70% branches |
| `@atisse/provider-openai` | 60% lines               |
| `@atisse/memory-redis`    | 60% lines               |
| `@atisse/context-rag`     | 50% lines               |

Coverage is measured per PR. PRs that drop coverage below thresholds are blocked.

---

## Test Types and Directory Layout

```
packages/core/
├── src/
└── tests/
    ├── unit/
    │   ├── lifecycle.test.ts
    │   ├── policies.test.ts
    │   ├── prompt-composer.test.ts
    │   ├── tool-controller.test.ts
    │   └── errors.test.ts
    ├── integration/
    │   ├── orchestrator.test.ts
    │   ├── streaming.test.ts
    │   ├── profiles.test.ts
    │   └── hooks-events.test.ts
    └── fixtures/
        ├── builders.ts       buildConfig(), buildTool(), buildProfile()
        ├── mock-tools.ts     echoTool, failingTool, validationFailTool, slowTool
        └── mock-memory.ts    MockMemoryAdapter (error-injection capable)
```

---

## MockProvider API Contract

`MockProvider` is the exclusive provider for unit tests. No live API calls are permitted in any test.

### Queue Entries

```typescript
type MockProviderEntry =
  | { text: string; toolCalls?: ToolCall[]; finishReason?: PromptResponse['finishReason'] }
  | { error: OrchestratorError };

provider.enqueue(entry: MockProviderEntry): this  // returns this for chaining
```

Each `generate()` or `generateStream()` call dequeues one entry in FIFO order.
If the entry is `{ error }`, the error is thrown. If `{ text }`, a `PromptResponse` is returned
with `usage: { prompt: 0, completion: 0, total: 0 }` and `finishReason: 'stop'` unless overridden.

**Queue exhausted:** if `generate()` is called with an empty queue, `MockProvider` throws
`ProviderUnavailableError`. Tests MUST enqueue enough entries to cover all expected calls.

### Introspection

```typescript
provider.callCount(): number
provider.wasCalledTimes(n: number): boolean
provider.lastRequest(): PromptRequest | undefined
provider.calls(): PromptRequest[]
provider.reset(): void   // clears queue, call history, and counter
```

### Streaming

`generateStream()` returns `Promise<AsyncIterable<StreamChunk>>`. Each `{ text }` entry is split
into character-level chunks yielded sequentially, followed by `{ type: 'done' }`.
`{ error }` entries yield `{ type: 'error' }`.

```typescript
provider.reset();
provider.enqueue({ text: 'Hello' });
const stream = await orchestrator.run({ prompt: 'test', stream: true });
const chunks: string[] = [];
for await (const chunk of stream) {
  if (chunk.type === 'text') chunks.push(chunk.delta);
}
expect(chunks.join('')).toBe('Hello');
```

---

## Mock Infrastructure

### MockMemoryAdapter (`tests/fixtures/mock-memory.ts`)

Error-injection capable. Use in unit tests where memory failure scenarios must be tested.
Use `InMemoryAdapter` (from `@atisse/memory-inmemory`) in integration tests.

```typescript
class MockMemoryAdapter implements MemoryAdapter {
  private store = new Map<string, Message[]>();
  public loadError?: OrchestratorError;
  public saveError?: OrchestratorError;

  async load(sessionId: string): Promise<Message[]> {
    if (this.loadError) throw this.loadError;
    return this.store.get(sessionId) ?? [];
  }

  async save(sessionId: string, messages: Message[]): Promise<void> {
    if (this.saveError) throw this.saveError;
    const existing = this.store.get(sessionId) ?? [];
    this.store.set(sessionId, [...existing, ...messages]);
  }

  async clear(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
}
```

### Standard Mock Tools (`tests/fixtures/mock-tools.ts`)

```typescript
echoTool; // returns input unchanged — for basic tool flow tests
failingTool; // throws ToolExecutionError — for retryable failure tests
validationFailTool; // throws ToolValidationError — for fatal schema failure tests
slowTool; // introduces delay — for timeout tests (use with fake timers)
```

### Test Object Builders (`tests/fixtures/builders.ts`)

```typescript
buildConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig
// Provides a MockProvider and retry: { maxAttempts: 1, baseDelayMs: 0, jitter: false }

buildTool(overrides?: Partial<Tool>): Tool
// Provides a named test tool with a valid inputSchema

buildProfile(overrides?: Partial<OrchestratorProfile>): OrchestratorProfile
// Provides a named profile with sensible defaults
```

---

## Retry Test Pattern

```typescript
it('retries on rate limit and succeeds', async () => {
  const provider = new MockProvider();
  provider
    .enqueue({ error: new ProviderRateLimitError('429', 50) })
    .enqueue({ error: new ProviderRateLimitError('429', 50) })
    .enqueue({ text: 'Success on attempt 3' });

  const orchestrator = new Orchestrator({
    provider,
    retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
  });

  vi.useFakeTimers();
  const result = orchestrator.run({ prompt: 'test' });
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ text: 'Success on attempt 3' });
  expect(provider.wasCalledTimes(3)).toBe(true);
  vi.useRealTimers();
});

it('does NOT retry on auth error', async () => {
  const provider = new MockProvider();
  provider.enqueue({ error: new ProviderAuthError('401') });
  const orchestrator = new Orchestrator({ provider });

  await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ProviderAuthError);
  expect(provider.wasCalledTimes(1)).toBe(true);
});
```

## Integration Test Provider Rule

Integration tests that verify adapter-to-Orchestrator wiring MAY use real adapter
instances with mocked SDK dependencies. No live API calls are permitted in any test —
the `MockProvider` rule applies to all unit tests and any test that triggers `generate()`.

When using a real adapter in integration tests:
- Mock the underlying SDK using `vi.mock()`. Never mock provider internals.
- Verify the adapter is correctly wired into the `Orchestrator` lifecycle
  (retry, hooks, state transitions, error propagation).
- Do NOT test SDK behavior — only the adapter's integration with the kernel.
- Use `MockProvider` for unit-level provider behavior tests (error mapping, shape
  transformation, streaming chunk assembly).

This permits the pattern used in M4 integration tests (`provider-anthropic` with
mocked `@anthropic-ai/sdk`, `memory-redis` with mocked `redis`, `context-rag` with
mocked `VectorStore`), while preserving the absolute prohibition on live API calls.

---

## What NOT to Test

- Internal implementation details (private methods, internal state)
- Third-party SDK behavior (OpenAI formatting, Redis protocol)
- Framework code (Vitest, pnpm)

## What MUST be Tested

- Every `OrchestratorError` subtype produces correct retry/fatal behavior
- Every valid state machine transition
- Every invalid state machine transition throws `InvalidStateTransitionError`
- Profile merging produces correct resolved config
- Hooks execute in correct serial order and can stop execution
- `runHooks()` throws when a hook returns `undefined` or `null`
- Events fire at correct lifecycle points (fire-and-forget, do not affect outcome)
- Tool round counter is cumulative across retries — never resets
- Memory is loaded before prompt composition and saved atomically after COMPLETING
- Streaming delivers chunks in correct order with correct types
- `run.input.prompt` is always `role: 'user'` — never `role: 'system'`
- Tool with empty `inputSchema` (`{}`) is rejected as a configuration error
- Cross-session memory isolation: `load('session-A')` never returns session-B data
- `stream: true` + `fallbackProvider` → `ConfigValidationError`
- `allowParallelTools: true` → `ConfigValidationError`
- `maxToolRounds: 0` → `ConfigValidationError`
- Duplicate tool names → `ConfigValidationError`
- Profile key not found → `ConfigValidationError`
