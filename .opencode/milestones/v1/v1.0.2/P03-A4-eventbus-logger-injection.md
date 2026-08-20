# A4 — Logger Injection into EventBus

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

> **Rev 2 (2026-08-20):** Applied SPSA review 2 — (1) `createEventBus`/`InternalEventBus` switched from positional parameters to an options object `{ onListenerError?, logger? }`; the 9 single-argument call sites in `events.test.ts` are updated mechanically, the 2 zero-argument sites are unchanged. (2) Orchestrator constructor assigns `logger` BEFORE `eventBus` so the wiring reads `this.logger` correctly. (3) `logger.warn` moved INSIDE the same try/catch as `onListenerError`; meta is now `{ runId, eventType, error, code? }`, with `code` conditional on `error instanceof OrchestratorError`. (4) Task Summary item 2 drops the "listener name (if available)" promise. (5) ADR-004 citations corrected — "errors are swallowed" sourced to hooks-events SKILL.md:41–42; ADR-004 (fire-and-forget) kept where factually correct. (6) Risk-table row 1 mitigation corrected to match the new emit code placement.

---

## 1. Task Summary

1. Accept an optional `Logger` in the `InternalEventBus` constructor via an options object `{ onListenerError?, logger? }` (the existing `onListenerError` callback is kept as an option)
2. When a listener throws during `emit()`, log at `warn` level with: the event type, the runId, and the error message (plus `code` when the error is an `OrchestratorError`)
3. Wire the `Logger` from `Orchestrator` through to `InternalEventBus` via `createEventBus()`
4. Do NOT change the `EventBus` interface — the change is purely internal to `InternalEventBus` implementation

---

## 2. Context (Why This Exists)

Currently, `EventBus` silently swallows listener errors. The `InternalEventBus` constructor accepts an optional `onListenerError` callback (line 11–15 in `events.ts`), but this callback is never wired from `Orchestrator`. The `createEventBus` factory is called with no arguments at `orchestrator.ts` line 144:

```typescript
this.eventBus = createEventBus();
```

This violates **Principle 6 (Production-Ready Defaults)** — in production, silently swallowed listener errors make debugging event-driven integrations nearly impossible. A developer registers an `on('run.completed', ...)` listener that throws, and the error disappears without any trace.

The observability standards (`.opencode/skill/observability/SKILL.md`) state that "a developer can reconstruct what happened during a `run()` call from logs and events alone." Silent listener errors break this guarantee.

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

**Constructor injection** — `InternalEventBus` gains an optional `logger` via an options object. Shared options type:

```typescript
type InternalEventBusOptions = {
  onListenerError?: (error: unknown, eventType: string) => void;
  logger?: Logger;
};
```

Constructor:

```typescript
constructor(options: InternalEventBusOptions = {}) {
  this.onListenerError = options.onListenerError;
  this.logger = options.logger;
}
```

**Factory change** — `createEventBus()` accepts the same options object:

```typescript
export function createEventBus(options: InternalEventBusOptions = {}): EventBus {
  return new InternalEventBus(options);
}
```

`createEventBus` is NOT part of the package public API — it is not re-exported from `index.ts` — so the signature change is internal-only. Call-site impact: `events.test.ts` has 11 call sites — 2 with zero arguments (lines 8, 52, unchanged) and 9 with a single positional `onError` (lines 207, 220, 237, 251, 266, 280, 296, 316, 335), each becoming `createEventBus({ onListenerError: onError })`. The single production call site (orchestrator.ts:144) is updated per the wiring block below.

**Emit method** — In the async listener error catch block (`events.ts` lines 38–47), place the `logger.warn` call INSIDE the same try/catch as `onListenerError`, with meta carrying `runId` (available on every `OrchestratorEvent`, `interfaces.ts` lines 432–458) and `code` when the error is an `OrchestratorError` (import `OrchestratorError` from `./errors.js` — errors.ts is L0, consistent with this file's layer header):

```typescript
} catch (error) {
  // Fire-and-forget per ADR-004 + hooks-events SKILL: notify and log, never throw
  try {
    this.onListenerError?.(error, event.type);
    this.logger?.warn('Event listener threw an error', {
      runId: event.runId,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof OrchestratorError ? { code: error.code } : {}),
    });
  } catch {
    // Neither onListenerError nor logger.warn may produce unhandled rejections
  }
}
```

**Wiring in Orchestrator** — In the constructor (`orchestrator.ts` lines 141–146), assign `logger` BEFORE `eventBus` — the current ordering assigns `this.logger` at line 145, AFTER the `createEventBus()` call at line 144, which would pass `undefined`:

```typescript
this.config = config;
this.tools = new Map(config.tools?.map((t) => [t.name, t]) ?? []);
// Logger must be assigned before eventBus — createEventBus() reads this.logger
this.logger = config.logger ?? noOpLogger();
this.eventBus = createEventBus({ logger: this.logger });
```

**No interface change** — The `EventBus` interface remains unchanged. `Logger` is not exposed in the `EventBus` interface — it is a constructor-only dependency.

**Log level rationale:** `warn` is appropriate because:

- The pipeline is unaffected (listener errors are fire-and-forget)
- The developer needs to know about it but it is not a pipeline failure
- Matches the observability standards: `warn` = "recoverable issues"

### 4.2 What NOT to Do

- Do NOT add `Logger` to the `EventBus` interface — this is a frozen contract
- Do NOT change log level to `error` — listener errors are non-blocking, `warn` is correct
- Do NOT throw from `emit()` on listener errors — ADR-004 (DECISION-LOG.md:33–36) makes events fire-and-forget ("events must never affect pipeline outcome"), and hooks-events SKILL.md:41–42 states `emit()` swallows listener errors — "the one sanctioned catch-and-swallow in the whole codebase"
- Do NOT remove the `onListenerError` callback — it remains for programmatic consumers that want it
- Do NOT log the full stack trace in meta — per observability standards, the meta logged by the §4.1 emit block is exactly `{ runId, eventType, error, code? }`: `runId` and `eventType` from the event, `error` as message-or-stringified, and `code` only when the error is an `OrchestratorError`. Never include `error.stack`.
- Do NOT add a `Logger` import in `interfaces.ts` — `EventBus` interface references only types from `interfaces.ts`

---

## 5. Files to Modify

| File                                | Action | Notes                                                 |
| ----------------------------------- | ------ | ----------------------------------------------------- |
| `packages/core/src/events.ts`       | MODIFY | Constructor, emit catch block, createEventBus factory |
| `packages/core/src/orchestrator.ts`          | MODIFY | Wire logger to createEventBus (line 144); assign logger before eventBus |
| `packages/core/tests/unit/events.test.ts`    | MODIFY | Update 9 single-argument `createEventBus(onError)` call sites to `createEventBus({ onListenerError: onError })` (lines 207, 220, 237, 251, 266, 280, 296, 316, 335); 2 zero-arg sites unchanged |

---

## 6. Implementation Strategy

### Step 1: Update `InternalEventBus` Constructor

- Open `packages/core/src/events.ts`
- Import type `Logger` from `./interfaces.js`
- Add a private field `logger?: Logger` to the class
- Replace the positional constructor with an options-object signature (shared type reused by the factory):

```typescript
type InternalEventBusOptions = {
  onListenerError?: (error: unknown, eventType: string) => void;
  logger?: Logger;
};

private readonly logger: Logger | undefined;

constructor(options: InternalEventBusOptions = {}) {
  this.onListenerError = options.onListenerError;
  this.logger = options.logger;
}
```

### Step 2: Update `emit()` Catch Block

- In the `emit()` method, in the catch block around line 38–47:
- Place the `logger.warn` call INSIDE the same try/catch as `onListenerError`; meta carries `runId` (every `OrchestratorEvent` has it) and `code` when the error is an `OrchestratorError`:
- Add `OrchestratorError` to the imports in `events.ts` (from `./errors.js` — errors.ts is L0, consistent with the file's layer header):

```typescript
} catch (error) {
  // Fire-and-forget per ADR-004 + hooks-events SKILL: notify and log, never throw
  try {
    this.onListenerError?.(error, event.type);
    this.logger?.warn('Event listener threw an error', {
      runId: event.runId,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof OrchestratorError ? { code: error.code } : {}),
    });
  } catch {
    // Neither onListenerError nor logger.warn may produce unhandled rejections
  }
}
```

### Step 3: Update `createEventBus()` Factory

- Update the factory function to accept the options object:

```typescript
export function createEventBus(options: InternalEventBusOptions = {}): EventBus {
  return new InternalEventBus(options);
}
```

### Step 4: Wire Logger from Orchestrator

- Open `packages/core/src/orchestrator.ts`
- Reorder the constructor (lines 141–146): assign `this.logger = config.logger ?? noOpLogger();` BEFORE `this.eventBus = ...`
- Change line 144: `this.eventBus = createEventBus();` → `this.eventBus = createEventBus({ logger: this.logger });`

### Step 5: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
- Update the 9 single-argument call sites in `events.test.ts` (lines 207, 220, 237, 251, 266, 280, 296, 316, 335) from `createEventBus(onError)` to `createEventBus({ onListenerError: onError })`; the 2 zero-arg call sites (lines 8, 52) remain unchanged
- All other tests must pass without modification

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
- `createEventBus({ logger })` works and passes logger through
- When a listener throws during `emit()`, `logger.warn` is called with meta containing `runId` (equal to the emitted event's `runId`), `eventType`, and `error` (message or stringified); when the error is an `OrchestratorError`, meta also contains `code`
- When no logger is provided, listener errors are still silently swallowed (no crash)
- `EventBus` interface is unchanged (verify by checking `interfaces.ts` — no changes)
- The 9 updated `createEventBus({ onListenerError: onError })` call sites in `events.test.ts` pass; all other tests pass without modification

---

## 8. Risk Assessment

| Risk                                  | Likelihood | Impact | Mitigation                                                                                                                                                                          |
| ------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logger.warn itself throws             | Very Low   | Low    | The `this.logger?.warn(...)` safe-call pattern (`?.`) prevents crashes if logger is undefined. If the logger instance itself throws, the call sits INSIDE the same try/catch as `onListenerError` (see §4.1 emit block), so it cannot produce an unhandled rejection. |
| Existing createEventBus callers break | Low        | Low    | `createEventBus` is not re-exported from `index.ts`, so only in-package callers are affected: 9 test call sites updated mechanically, 1 Orchestrator call site updated. The 2 zero-arg call sites are unaffected. |
| Logger dependency cycles              | Low        | Low    | `Logger` is a type-only import from `interfaces.ts` — no runtime circular dependency                                                                                                |
| Wrong log level chosen                | Low        | Low    | `warn` is confirmed appropriate per `.opencode/skill/observability/SKILL.md`: "recoverable issues"                                                                                                |

---

## 9. References

- `.opencode/skill/observability/SKILL.md` — Log levels, required log points, error logging rules
- `.opencode/skill/hooks-events/SKILL.md` — Event listener rules, fire-and-forget execution model (implements ADR-004's decision); lines 41–42 are the authority for "emit() swallows listener errors"
- `.opencode/skill/principles/SKILL.md` — Principle 6: Production-Ready Defaults, Principle 1: Explicit Over Magical
- `packages/core/src/events.ts` — Target: InternalEventBus constructor + emit method + createEventBus factory
- `packages/core/src/orchestrator.ts` — Line 144: createEventBus() call site
