# A4 — Logger Injection into EventBus

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

1. Accept an optional `Logger` in the `InternalEventBus` constructor (renamed from `onListenerError` callback pattern or alongside it)
2. When a listener throws during `emit()`, log at `warn` level with: the event type, the listener name (if available), and the error message
3. Wire the `Logger` from `Orchestrator` through to `InternalEventBus` via `createEventBus()`
4. Do NOT change the `EventBus` interface — the change is purely internal to `InternalEventBus` implementation

---

## 2. Context (Why This Exists)

Currently, `EventBus` silently swallows listener errors. The `InternalEventBus` constructor accepts an optional `onListenerError` callback (line 11–15 in `events.ts`), but this callback is never wired from `Orchestrator`. The `createEventBus` factory is called with no arguments at `orchestrator.ts` line 144:

```typescript
this.eventBus = createEventBus();
```

This violates **Principle 6 (Production-Ready Defaults)** — in production, silently swallowed listener errors make debugging event-driven integrations nearly impossible. A developer registers an `on('run.completed', ...)` listener that throws, and the error disappears without any trace.

The observability standards (`observability-standards.md`) state that "a developer can reconstruct what happened during a `run()` call from logs and events alone." Silent listener errors break this guarantee.

The fix is minimal: inject the `Logger` (already available in `Orchestrator`) into the `EventBus` during construction, and use `logger.warn()` when a listener throws. This makes swallowed errors visible without changing the fire-and-forget execution model.

---

## 3. Issues/Changes

### Issue A4-1: Swallowed listener errors are invisible

| Field       | Value                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/events.ts`                                                                                                                                                                                                                |
| Lines       | 38–47 (catch block), 87–91 (createEventBus)                                                                                                                                                                                                  |
| Severity    | MEDIUM                                                                                                                                                                                                                                       |
| Description | When an async event listener throws, the error is silently swallowed. The `onListenerError` callback exists but is never wired from the `Orchestrator`. Developers cannot debug failing listeners without attaching a debugger.              |
| Fix         | Accept optional `Logger` in `InternalEventBus` constructor and `createEventBus` factory. Log at `warn` level when a listener throws, including the event type and error message. Wire the `Logger` from `Orchestrator` at construction time. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**Constructor injection** — `InternalEventBus` gains an optional `logger?: Logger` parameter alongside the existing `onListenerError` callback:

```typescript
constructor(onListenerError?: (error: unknown, eventType: string) => void, logger?: Logger) {
  this.onListenerError = onListenerError;
  this.logger = logger;
}
```

**Factory change** — `createEventBus()` gains an optional `logger?: Logger` parameter:

```typescript
export function createEventBus(
  onListenerError?: (error: unknown, eventType: string) => void,
  logger?: Logger,
): EventBus {
  return new InternalEventBus(onListenerError, logger);
}
```

**Emit method** — In the async listener error catch block (lines 38–47), add:

```typescript
try {
  this.onListenerError?.(error, event.type);
} catch {
  // Silently swallow per ADR-004
}
// NEW: Log at warn level when logger is available
this.logger?.warn('Event listener threw an error', {
  eventType: event.type,
  error: error instanceof Error ? error.message : String(error),
});
```

**Wiring in Orchestrator** — At `orchestrator.ts` line 144, change:

```typescript
this.eventBus = createEventBus();
// → becomes:
this.eventBus = createEventBus(undefined, this.logger);
```

**No interface change** — The `EventBus` interface remains unchanged. `Logger` is not exposed in the `EventBus` interface — it is a constructor-only dependency.

**Log level rationale:** `warn` is appropriate because:

- The pipeline is unaffected (listener errors are fire-and-forget)
- The developer needs to know about it but it is not a pipeline failure
- Matches the observability standards: `warn` = "recoverable issues"

### 4.2 What NOT to Do

- Do NOT add `Logger` to the `EventBus` interface — this is a frozen contract
- Do NOT change log level to `error` — listener errors are non-blocking, `warn` is correct
- Do NOT throw from `emit()` on listener errors — ADR-004 explicitly states errors are swallowed
- Do NOT remove the `onListenerError` callback — it remains for programmatic consumers that want it
- Do NOT log the full stack trace in meta — per observability standards, only `error.message` and `error.code`
- Do NOT add a `Logger` import in `interfaces.ts` — `EventBus` interface references only types from `interfaces.ts`

---

## 5. Files to Modify

| File                                | Action | Notes                                                 |
| ----------------------------------- | ------ | ----------------------------------------------------- |
| `packages/core/src/events.ts`       | MODIFY | Constructor, emit catch block, createEventBus factory |
| `packages/core/src/orchestrator.ts` | MODIFY | Wire logger to createEventBus (line 144)              |

---

## 6. Implementation Strategy

### Step 1: Update `InternalEventBus` Constructor

- Open `packages/core/src/events.ts`
- Import type `Logger` from `./interfaces.js`
- Add a private field `logger?: Logger` to the class
- Update constructor signature and body:

```typescript
private readonly logger: Logger | undefined;

constructor(
  onListenerError?: (error: unknown, eventType: string) => void,
  logger?: Logger,
) {
  this.onListenerError = onListenerError;
  this.logger = logger;
}
```

### Step 2: Update `emit()` Catch Block

- In the `emit()` method, in the catch block around line 38–47:
- After the existing `onListenerError` call, add the logger.warn call:

```typescript
try {
  this.onListenerError?.(error, event.type);
} catch {
  // Silently swallow per ADR-004
}
this.logger?.warn('Event listener threw an error', {
  eventType: event.type,
  error: error instanceof Error ? error.message : String(error),
});
```

### Step 3: Update `createEventBus()` Factory

- Update the factory function signature and implementation:

```typescript
export function createEventBus(
  onListenerError?: (error: unknown, eventType: string) => void,
  logger?: Logger,
): EventBus {
  return new InternalEventBus(onListenerError, logger);
}
```

### Step 4: Wire Logger from Orchestrator

- Open `packages/core/src/orchestrator.ts`
- Find line 144: `this.eventBus = createEventBus();`
- Change to: `this.eventBus = createEventBus(undefined, this.logger);`

### Step 5: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
- All existing tests must pass without modification
- The `createEventBus` calls in existing tests (if any) that pass only `onListenerError` must still compile

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify:

- `createEventBus()` with no arguments still works (backward-compatible)
- `createEventBus(undefined, logger)` works and passes logger through
- When a listener throws during `emit()`, `logger.warn` is called with correct meta
- When no logger is provided, listener errors are still silently swallowed (no crash)
- `EventBus` interface is unchanged (verify by checking `interfaces.ts` — no changes)
- All existing tests pass without modification

---

## 8. Risk Assessment

| Risk                                  | Likelihood | Impact | Mitigation                                                                                                                                                                          |
| ------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logger.warn itself throws             | Very Low   | Low    | The `this.logger?.warn(...)` safe-call pattern (`?.`) prevents crashes if logger is undefined. If the logger instance itself throws, the surrounding try/catch in emit swallows it. |
| Existing createEventBus callers break | Low        | Low    | Function signature change is backward-compatible (optional second param). Verify all call sites.                                                                                    |
| Logger dependency cycles              | Low        | Low    | `Logger` is a type-only import from `interfaces.ts` — no runtime circular dependency                                                                                                |
| Wrong log level chosen                | Low        | Low    | `warn` is confirmed appropriate per observability-standards.md: "recoverable issues"                                                                                                |

---

## 9. References

- `.opencode/skill/observability/SKILL.md` — Log levels, required log points, error logging rules
- `.opencode/skill/hooks-events/SKILL.md` — Event listener rules, fire-and-forget execution model, ADR-004
- `.opencode/skill/principles/SKILL.md` — Principle 6: Production-Ready Defaults, Principle 1: Explicit Over Magical
- `packages/core/src/events.ts` — Target: InternalEventBus constructor + emit method + createEventBus factory
- `packages/core/src/orchestrator.ts` — Line 144: createEventBus() call site
