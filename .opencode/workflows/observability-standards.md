# OBSERVABILITY STANDARDS

## Logging, Structured Events, and Debuggability

Every critical execution path in this project MUST be observable.
"Observable" means: a developer can reconstruct what happened during a `run()` call
from logs and events alone, without attaching a debugger.

---

## The Three Pillars

| Pillar          | Mechanism          | Purpose                                             |
| --------------- | ------------------ | --------------------------------------------------- |
| **Logging**     | `Logger` interface | Human-readable execution trace                      |
| **Events**      | `EventBus`         | Machine-readable telemetry and metrics              |
| **Correlation** | `runId`            | Link all logs and events from a single `run()` call |

---

## Logging Standards

### Always Use the `Logger` Interface

Never use `console.log` in production code. Always use the injected `Logger`.

```typescript
// WRONG
console.log('Provider called');

// CORRECT
logger.info('Provider called', { runId, model: provider.id });
logger.error('Provider failed', { runId, error: error.message, code: error.code });
```

### Log Levels — When to Use Each

| Level   | When to use                               | Example                                         |
| ------- | ----------------------------------------- | ----------------------------------------------- |
| `debug` | Internal state transitions, detailed flow | `State: GENERATING → TOOL_EXECUTING`            |
| `info`  | Significant milestones in `run()`         | `Run started`, `Tool executed`, `Run completed` |
| `warn`  | Recoverable issues, retry attempts        | `Retry attempt 2/3`, `Fallback triggered`       |
| `error` | Unrecoverable failures                    | `Max retries exceeded`, `Provider auth failed`  |

### Required Log Points

These points MUST produce a log entry. No exceptions.

```typescript
logger.info('Run started', { runId, profile, sessionId });
logger.debug('Context loaded', { runId, providerId, messageCount });
logger.debug('Generating', { runId, messageCount: messages.length, model: provider.id });
logger.debug('Executing tool', { runId, toolName, round });
logger.warn('Retrying', { runId, attempt, reason: error.code, delayMs });
logger.warn('Fallback triggered', { runId, reason: error.code });
logger.info('Run completed', { runId, durationMs, totalTokens: usage.total });
logger.error('Run failed', { runId, error: error.message, code: error.code });
```

### Log Message Format Rules

- Messages describe WHAT happened, not HOW: `'Tool executed'` not `'Called toolController.execute()'`
- `meta` always includes `runId` — every log must be correlatable
- Never log secrets, API keys, raw request bodies, or user PII
- `provider.id` (e.g. `"openai-gpt-4o"`) is configuration metadata — safe to log
- Error logs include `error.message` and `error.code` — never the full stack trace in `meta`
- Stack traces go to the error tracking system (via Event Bus), not to the logger

```typescript
// WRONG — logs internal path, no runId, exposes key
logger.info('openai-provider.ts line 42 called', { apiKey: this.config.apiKey });

// CORRECT
logger.info('Provider request sent', { runId, model: this.model, messageCount });
```

---

## Event Bus Standards

Events are machine-readable signals for metrics, alerting, and telemetry.
They must not duplicate the logger — they carry structured data, not messages.

### Every Event Must Include `runId`

`runId` is the correlation key. Every event consumer can group events by run.

```typescript
// WRONG — no correlation
eventBus.emit({ type: 'run.completed', durationMs: 230 });

// CORRECT
eventBus.emit({ type: 'run.completed', runId, durationMs: 230, usage });
```

### Error Payloads in Events

Different events carry different error representations — use the correct type:

| Event            | Error field type    | Reason                                                 |
| ---------------- | ------------------- | ------------------------------------------------------ |
| `run.failed`     | `OrchestratorError` | Consumer needs `instanceof` check; actual thrown error |
| `tool.failed`    | `EventErrorPayload` | Serialized DTO — code, message, retryable              |
| `context.failed` | `EventErrorPayload` | Serialized DTO — code, message, retryable              |

`EventErrorPayload` is defined in `interfaces-core.md`. It is structurally similar to
`ToolResultError` but semantically distinct — do not interchange them.

```typescript
// tool.failed — EventErrorPayload
eventBus.emit({
  type: 'tool.failed',
  runId,
  toolName,
  error: { code: error.code, message: error.message, retryable: error.retryable },
});

// context.failed — EventErrorPayload
eventBus.emit({
  type: 'context.failed',
  runId,
  providerId,
  error: { code: error.code, message: error.message, retryable: error.retryable },
});

// run.failed — actual OrchestratorError instance
eventBus.emit({ type: 'run.failed', runId, error });
```

### Events vs Logs — Which to Use

| Scenario                            | Use                           |
| ----------------------------------- | ----------------------------- |
| Human-readable trace                | Logger                        |
| Metric (latency, token count, cost) | Event                         |
| Alerting (retry spike, fallback)    | Event                         |
| Debug a specific run                | Logger (filtered by runId)    |
| Both                                | Both — they are complementary |

### Required Events

```typescript
eventBus.emit({ type: 'run.started', runId, timestamp: Date.now(), profile });
eventBus.emit({ type: 'run.completed', runId, durationMs, usage });
eventBus.emit({ type: 'run.failed', runId, error });
eventBus.emit({ type: 'generate.started', runId, messageCount });
eventBus.emit({ type: 'generate.completed', runId, durationMs, finishReason });
eventBus.emit({ type: 'tool.called', runId, toolName, round });
eventBus.emit({ type: 'tool.completed', runId, toolName, durationMs });
eventBus.emit({
  type: 'tool.failed',
  runId,
  toolName,
  error: { code: error.code, message: error.message, retryable: error.retryable },
});
eventBus.emit({ type: 'retry.attempt', runId, attempt, reason: error.code, delayMs });
eventBus.emit({ type: 'fallback.triggered', runId, reason: error.code });
eventBus.emit({ type: 'context.loaded', runId, providerId, messageCount });
eventBus.emit({
  type: 'context.failed',
  runId,
  providerId,
  error: { code: error.code, message: error.message, retryable: error.retryable },
});
```

---

## The `runId` Correlation Contract

Every `run()` call generates a unique `runId` (`crypto.randomUUID()`) at initialization.
This ID appears in every log entry, every emitted event, and `RunOutput.runId`.

```typescript
// Inside pipeline.ts — runId created once, passed everywhere
const runId = crypto.randomUUID();
logger.info('Run started', { runId });
eventBus.emit({ type: 'run.started', runId, timestamp: Date.now() });
await runHooks(hooks.beforeGenerate, { messages, input, runId });
```

---

## Debuggability Rules

### Name Async Operations

```typescript
// WRONG — anonymous, useless stack trace
await executeWithRetry(async () => { ... }, policy);

// CORRECT — named, meaningful stack trace
async function callProvider(): Promise<PromptResponse> {
  return provider.generate(request);
}
await executeWithRetry(callProvider, policy);
```

### Errors Must Carry Context

```typescript
// WRONG — context lost
throw new ToolExecutionError('unknown');

// CORRECT — tool name + original cause preserved
throw new ToolExecutionError(tool.name, error);
```

### State Transitions Are Logged

`LifecycleStateMachine.transition()` returns the previous state, enabling a single-line log:

```typescript
// Inside pipeline.ts
const from = stateMachine.transition('CONTEXT_INJECTING');
logger.debug('State transition', { runId, from, to: 'CONTEXT_INJECTING' });
```

`LifecycleStateMachine` has no logging capability — it is a pure state guard.
All transition logs are written by `pipeline.ts`.
