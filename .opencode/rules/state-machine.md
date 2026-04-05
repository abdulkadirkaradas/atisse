# STATE MACHINE

## Lifecycle States and Valid Transitions

---

## Overview

Every `run()` call progresses through a `LifecycleStateMachine`. The machine enforces which
transitions are legal. Attempting an illegal transition throws `InvalidStateTransitionError` immediately.

State exists only for the duration of a single `run()` call. It is never stored on the `Orchestrator` instance.

`LifecycleState` is defined and exported in `interfaces.ts` (interfaces-core.md) so that consumers
can type-check `InvalidStateTransitionError.from` and `.to` fields.

---

## State Definitions

```typescript
// Defined in interfaces.ts — exported for consumer use
export type LifecycleState =
  | 'INITIALIZED'
  | 'CONTEXT_INJECTING'
  | 'CONTEXT_INJECTED'
  | 'PROMPT_COMPOSED'
  | 'GENERATING'
  | 'TOOL_EXECUTING'
  | 'RETRYING'
  | 'FALLBACKING'
  | 'COMPLETING'
  | 'COMPLETED' // terminal
  | 'FAILED'; // terminal
```

| State               | Meaning                                               |
| ------------------- | ----------------------------------------------------- |
| `INITIALIZED`       | `run()` called, config validated, runId generated     |
| `CONTEXT_INJECTING` | ContextProvider(s) are being called                   |
| `CONTEXT_INJECTED`  | All context loaded, memory loaded                     |
| `PROMPT_COMPOSED`   | Message array assembled, ready to send                |
| `GENERATING`        | Provider is being called                              |
| `TOOL_EXECUTING`    | LLM returned tool_calls, executing them               |
| `RETRYING`          | Retryable error occurred, waiting before retry        |
| `FALLBACKING`       | Max retries exhausted, switching to fallback provider |
| `COMPLETING`        | Saving memory, running afterRun hooks                 |
| `COMPLETED`         | Terminal — success                                    |
| `FAILED`            | Terminal — unrecoverable error thrown                 |

---

## Valid Transitions Table

```typescript
// Defined in lifecycle.ts — NOT exported (internal constant)
const VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  INITIALIZED: ['CONTEXT_INJECTING', 'FAILED'],
  CONTEXT_INJECTING: ['CONTEXT_INJECTED', 'RETRYING', 'FAILED'],
  CONTEXT_INJECTED: ['PROMPT_COMPOSED', 'FAILED'],
  PROMPT_COMPOSED: ['GENERATING', 'FAILED'],
  GENERATING: ['TOOL_EXECUTING', 'RETRYING', 'FALLBACKING', 'COMPLETING', 'FAILED'],
  TOOL_EXECUTING: ['GENERATING', 'RETRYING', 'FAILED'],
  RETRYING: ['GENERATING', 'CONTEXT_INJECTING', 'FALLBACKING', 'FAILED'],
  FALLBACKING: ['GENERATING', 'FAILED'],
  COMPLETING: ['COMPLETED'],
  COMPLETED: [], // terminal — no transitions allowed
  FAILED: [], // terminal — no transitions allowed
};
```

---

## State Machine Implementation

```typescript
// packages/core/src/lifecycle.ts

export class LifecycleStateMachine {
  private current: LifecycleState = 'INITIALIZED';

  /**
   * Transitions to the target state. Returns the previous state for logging convenience.
   * Throws InvalidStateTransitionError if the transition is not in VALID_TRANSITIONS.
   */
  transition(to: LifecycleState): LifecycleState {
    const allowed = VALID_TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new InvalidStateTransitionError(this.current, to);
    }
    const previous = this.current;
    this.current = to;
    return previous;
  }

  get state(): LifecycleState {
    return this.current;
  }

  isTerminal(): boolean {
    return this.current === 'COMPLETED' || this.current === 'FAILED';
  }

  assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidStateTransitionError(this.current, 'any');
    }
  }
}
```

`transition()` returning the previous state allows `pipeline.ts` to write a single-line
state transition log without a separate variable:

```typescript
// Inside pipeline.ts
const from = stateMachine.transition('CONTEXT_INJECTING');
logger.debug('State transition', { runId, from, to: 'CONTEXT_INJECTING' });
```

---

## Transition Diagram

```
INITIALIZED
    │
    ├──(config error)──────────────────────────────────────► FAILED
    │
    ▼
CONTEXT_INJECTING ◄───────────────────────────────────────┐
    │                                                       │ (retryable ctx error)
    ├──(retryable ctx error)────────────────────────► RETRYING
    │                                                       │
    ├──(fatal ctx error)────────────────────────────────► FAILED
    │
    ▼
CONTEXT_INJECTED
    │
    ▼
PROMPT_COMPOSED
    │
    ▼
GENERATING ◄──────────────────────────────────────────────────────┐
    │                                                              │ (tool done)
    ├──(retryable provider error)────────────────── RETRYING ──────┤
    │                                                   │
    │                                               (retry ok)
    │                                                   │
    ├──(max retries + fallback)──────────── FALLBACKING ┘
    │                                           │
    │                                       (fallback ok)──────────┘
    │
    ├──(tool_calls in response)───────────── TOOL_EXECUTING
    │                                            │
    │                                     (tool done, more rounds)
    │                                            └──────► GENERATING
    │
    ├──(fatal provider error)──────────────────────────► FAILED
    │
    ▼
COMPLETING
    │
    ▼
COMPLETED (terminal)
```

---

## Rules

1. A `LifecycleStateMachine` instance is created fresh on every `run()` call
2. It is NEVER stored as an instance property on `Orchestrator`
3. `COMPLETED` and `FAILED` are terminal — no further transitions are possible
4. `assertNotTerminal()` throws `InvalidStateTransitionError` with `to: 'any'`
5. `FALLBACKING → GENERATING` uses the fallback provider — not the primary
6. `TOOL_EXECUTING → GENERATING` increments the round counter (held in `pipeline.ts`)
7. `RETRYING → CONTEXT_INJECTING` is used only when a ContextProvider fails
8. The state machine does not know about retry counts — that is the `PolicyEngine`'s concern
9. `LifecycleStateMachine` does NOT hold `runId` or a `Logger` reference. All state transition
   logs are written by `pipeline.ts`, which owns both the state machine instance and the `runId`.
10. The tool round counter is a local variable in `pipeline.ts` — NOT inside `LifecycleStateMachine`
    or `ToolController`. It is cumulative across the entire `run()` call and never resets on retry.
