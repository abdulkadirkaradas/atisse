---
name: hooks-events
description: Lifecycle hooks vs the event bus — two different extension contracts for @atisse/core. Load when adding a hook or event listener, or deciding which one a feature needs.
license: MIT
compatibility: opencode
---

# Hooks and events

Two extension mechanisms, deliberately not merged — full type contracts are in the
`interfaces` skill (`HookRegistry`, `OrchestratorEvent`); this is when and how to use each.

|                    | Hook                                     | Event                           |
| ------------------ | ---------------------------------------- | ------------------------------- |
| Execution          | serial, awaited                          | fire-and-forget                 |
| Blocks pipeline    | yes                                      | no                              |
| Can stop execution | yes — throw to abort                     | no — errors swallowed           |
| Can modify context | yes — return new context                 | no                              |
| Purpose            | interception, validation, transformation | observation, telemetry, logging |
| Registered via     | `OrchestratorConfig.hooks`               | `orchestrator.on(type, fn)`     |

## Decision guide

Need to stop execution, or modify the messages/response? → **hook**
(`beforeGenerate` to modify what's sent, `afterGenerate` to validate the response,
`beforeTool` for authorization checks). Logging, metrics, alerting, or anything where
failure is acceptable without affecting the run? → **event**.

## Hook rules

1. Always return the context object — `undefined`/`null` throws internally.
2. Pass through unchanged: `return ctx`. Modify: `return { ...ctx, messages: [...] }` —
   never mutate the input.
3. Abort by throwing any error — it propagates as the `run()` rejection.
4. Hooks run serially, in registration order; each receives the previous hook's output.
5. Only hardcoded/developer-authored content belongs in `role: 'system'` inside a hook —
   never `ctx.input.prompt` or anything user-controlled (see `security` skill S-2).

## Event rules

1. Listeners must never throw — `emit()` swallows listener errors so the pipeline is
   unaffected; this is the one sanctioned "catch and swallow" in the whole codebase.
2. Don't rely on ordering between listeners, and don't do long blocking work inside one —
   fire your own async work and don't await it (`db.save(event).catch(...)`, not
   `await db.save(event)`).
3. Every event carries `runId` for correlation.
4. `orchestrator.on()` returns an unsubscribe function — call it when the listener is no
   longer needed. Registering a listener per-request without unsubscribing is a memory
   leak in long-running servers; register once at startup instead.
5. `tool.failed` / `context.failed` carry `EventErrorPayload` (a serialized DTO); `run.failed`
   carries the actual `OrchestratorError` instance — don't interchange them, they look
   similar but serve different consumer needs (DTO vs. `instanceof`-checkable).
