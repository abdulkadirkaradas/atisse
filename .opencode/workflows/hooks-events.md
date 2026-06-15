# HOOKS AND EVENTS

## Lifecycle Hooks vs Event Bus — Two Different Contracts

---

## The Core Difference

|                        | Lifecycle Hook                           | Event Bus                        |
| ---------------------- | ---------------------------------------- | -------------------------------- |
| **Execution model**    | Serial, awaited                          | Fire-and-forget                  |
| **Blocks pipeline**    | YES                                      | NO                               |
| **Can stop execution** | YES — throw to abort                     | NO — errors swallowed            |
| **Can modify context** | YES — return new context                 | NO                               |
| **Purpose**            | Interception, validation, transformation | Observation, telemetry, logging  |
| **Order guaranteed**   | YES — registration order                 | YES — but outcome doesn't matter |
| **Where registered**   | `OrchestratorConfig.hooks`               | `orchestrator.on(type, fn)`      |

---

## Lifecycle Hooks

### Contract

```typescript
// Hook receives context, returns it (optionally modified).
// Throwing aborts pipeline execution — error propagates as run() rejection.
// Returning undefined or null throws an internal error — always return context.
type LifecycleHook<TContext> = (context: TContext) => Promise<TContext> | TContext;
```

### Hook Points and Their Contexts

```typescript
hooks: {
  beforeRun: ReadonlyArray<LifecycleHook<RunContext>>;
  // RunContext = { input: RunInput, runId: string }

  beforeGenerate: ReadonlyArray<LifecycleHook<BeforeGenerateContext>>;
  // BeforeGenerateContext = { messages: Message[], input: RunInput, runId: string }
  // NOTE: response is NOT available here — the provider has not been called yet

  afterGenerate: ReadonlyArray<LifecycleHook<AfterGenerateContext>>;
  // AfterGenerateContext = { messages: Message[], response: PromptResponse, input: RunInput, runId: string }
  // Streaming: called AFTER the 'done' chunk — response holds accumulated text and usage

  beforeTool: ReadonlyArray<LifecycleHook<ToolContext>>;
  // ToolContext = { toolCall: ToolCall, input: RunInput, runId: string }

  afterTool: ReadonlyArray<LifecycleHook<AfterToolContext>>;
  // AfterToolContext = ToolContext & { toolResult: ToolResult }

  afterRun: ReadonlyArray<LifecycleHook<AfterRunContext>>;
  // AfterRunContext = RunContext & { output: RunOutput }
}
```

All context types are defined in `interfaces-runtime.md` (HookRegistry section).
`HookRegistry` uses `ReadonlyArray` — hook arrays are immutable after construction.

### Hook Execution Model

```typescript
// hooks.ts — serial execution; each hook receives output of the previous
async function runHooks<T>(hooks: ReadonlyArray<LifecycleHook<T>>, context: T): Promise<T> {
  let ctx = context;
  for (const hook of hooks) {
    const result = await hook(ctx);
    if (result === undefined || result === null) {
      throw new Error(`Hook returned ${result} — hooks must always return context`);
    }
    ctx = result;
  }
  return ctx;
}

// normalizeHookRegistry() — internal utility in hooks.ts
// Converts Partial<HookRegistry> to a full HookRegistry with undefined arrays replaced by []
// Called by pipeline.ts before any hook execution
function normalizeHookRegistry(partial?: Partial<HookRegistry>): HookRegistry { ... }
```

### Hook Use Cases

```typescript
// USE CASE 1: Input validation — stop if invalid
hooks: {
  beforeRun: [
    async (ctx) => {
      if (ctx.input.prompt.length > 10_000) {
        throw new TokenLimitExceededError('Prompt exceeds maximum length');
      }
      return ctx;
    },
  ];
}

// USE CASE 2: Prompt augmentation
// ONLY hardcoded or developer-authored strings belong in role: 'system'.
// NEVER pass ctx.input.prompt or any user-controlled value as role: 'system'.
hooks: {
  beforeGenerate: [
    async (ctx) => ({
      ...ctx,
      messages: [
        ...ctx.messages,
        { role: 'system' as const, content: 'Always respond in valid JSON.' }, // hardcoded — safe
      ],
    }),
  ];
}

// USE CASE 3: Response validation
hooks: {
  afterGenerate: [
    async (ctx) => {
      try {
        JSON.parse(ctx.response.text);
      } catch {
        throw new Error('LLM returned invalid JSON');
      }
      return ctx;
    },
  ];
}

// USE CASE 4: Authorization — input.metadata available in ToolContext
hooks: {
  beforeTool: [
    async (ctx) => {
      if (ctx.toolCall.name === 'admin_action' && !isAdmin(ctx.input.metadata?.userId)) {
        throw new Error('Unauthorized tool access');
      }
      return ctx;
    },
  ];
}
```

### Hook Rules

1. Always return the context object — never `undefined` or `null`
2. To pass through unchanged: `return ctx`
3. To modify: `return { ...ctx, messages: [...ctx.messages, newMsg] }`
4. To abort: throw any error — it propagates as `run()` rejection
5. Do NOT mutate the input context — always spread and return a new object

---

## Event Bus

### Contract

`EventBus` interface and `OrchestratorEvent` union are defined in `interfaces-runtime.md`.
This file documents emission points, listener rules, and use cases only.

### Event Emission Model

Events are emitted by `pipeline.ts` internally. Users register listeners via `orchestrator.on()`.

```typescript
// Inside pipeline.ts (internal)
eventBus.emit({ type: 'run.started', runId, timestamp: Date.now() });

// In user code
orchestrator.on('run.started', ({ runId, timestamp }) => {
  console.log(`Run ${runId} started at ${timestamp}`);
});
```

### Event Listener Rules

1. Listeners MUST NOT throw — errors are silently swallowed (pipeline is unaffected)
2. Listeners MUST NOT rely on execution order between listeners
3. Listeners MUST NOT modify pipeline state
4. Async listeners run independently — they do not delay the pipeline
5. The unsubscribe function MUST be called when the listener is no longer needed

**Async listener handling:** `emit()` detects Promise return values and wraps them
in an async IIFE with try/catch — errors are swallowed without blocking the pipeline.
This does NOT use `.then()/.catch()` chains — async/await convention is preserved.

```typescript
// Inside EventBus.emit() — internal implementation pattern
const result = listener(event);
if (result instanceof Promise) {
  void (async () => {
    try {
      await result;
    } catch {
      /* silently swallow */
    }
  })();
}
```

**Memory leak warning:** `EventBus` holds a strong reference to every registered listener.
In long-running servers, registering listeners inside per-request handlers without
unsubscribing accumulates listeners indefinitely.

```typescript
// CORRECT — unsubscribe when done
const unsub = orchestrator.on('run.completed', handler);
unsub(); // call when listener is no longer needed

// WRONG — listener registered per-request, never removed
app.post('/chat', async (req, res) => {
  orchestrator.on('run.completed', (e) => {
    /* ... */
  }); // MEMORY LEAK
});

// CORRECT — register once at startup
orchestrator.on('run.completed', (e) => {
  metrics.record(e.usage);
});
```

### Event Use Cases

```typescript
// Cost tracking
orchestrator.on('run.completed', ({ usage }) => {
  const cost = (usage.prompt * 0.01 + usage.completion * 0.03) / 1000;
  billingService.record(cost);
});

// Context failure monitoring (distinct from provider/tool failures)
orchestrator.on('context.failed', ({ runId, providerId, error }) => {
  alerting.increment('context_provider_failures', { provider: providerId });
});

// Profile resolution audit
orchestrator.on('profile.resolved', ({ runId, profileName, overrides }) => {
  logger.debug('Profile resolved', { runId, profileName, overrides });
});

// Retry alerting
orchestrator.on('retry.attempted', ({ attempt, reason, delayMs }) => {
  if (attempt >= 2) alerting.warn('LLM retrying', { attempt, reason });
});

// Fallback circuit breaker
orchestrator.on('fallback.triggered', ({ runId }) => {
  circuitBreaker.recordFailure('primary-provider');
});
```

---

## Decision Guide: Hook or Event?

1. **Need to stop execution?** → Hook
2. **Need to modify messages sent to LLM?** → Hook (`beforeGenerate`)
3. **Need to validate a response?** → Hook (`afterGenerate`)
4. **Logging, metrics, or monitoring?** → Event
5. **Failure acceptable without affecting the run?** → Event
6. **Order relative to other listeners matters?** → Hook (serial) vs Event (unordered)
