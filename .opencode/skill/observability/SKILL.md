---
name: observability
description: Logging and event-bus standards for @atisse/core — log levels, required log/event points, runId correlation. Load when adding a log line, adding an event emission, or reviewing either for completeness.
license: MIT
compatibility: opencode
---

# Observability

Goal: a developer can reconstruct what happened in a `run()` from logs and events alone,
without a debugger. Three pillars: `Logger` (human-readable trace), `EventBus`
(machine-readable telemetry), `runId` (the correlation key linking every log and event from
one call — generated once via `crypto.randomUUID()`, threaded through everything, and
present in `RunOutput.runId`).

## Logging

Never `console.log` in production code — always the injected `Logger`. If `Logger` isn't
provided, a no-op is used silently; always inject one in production, since silent failures
are hard to diagnose.

Levels: `debug` for internal state/flow (state transitions), `info` for run milestones
(started/completed), `warn` for recoverable issues (retry, fallback), `error` for
unrecoverable failures.

Required log points, one per lifecycle milestone: run started/completed/failed, context
loaded, generating, tool executing, retrying, fallback triggered. Each carries `runId` plus
whatever's relevant (`toolName`, `attempt`, `error.code`) — never the full stack trace in
`meta` (that goes to the error-tracking system via the event bus, not the logger).

**Message content rule** (shared with the `security` skill S-1/S-7): describe _what_
happened, never _which value_ or _where in the code_. No secrets, no file paths, no line
numbers. `provider.id` (e.g. `"openai-gpt-4o"`) is the one exception — it's configuration
metadata, safe to log.

## Events

Every event carries `runId`. Error payloads differ by event and the difference matters:
`run.failed` carries the actual `OrchestratorError` instance (consumer does `instanceof`);
`tool.failed` / `context.failed` carry `EventErrorPayload`, a serialized DTO — don't
interchange the two shapes even though they look similar.

Required emissions mirror the required log points: `run.started/completed/failed`,
`generate.started/completed`, `tool.called/completed/failed`, `retry.attempted`,
`fallback.triggered`, `context.loaded/failed`. Full event union is in the `interfaces`
skill — this file is about _when_ to emit, not the exact payload shape.

Logs vs. events: logs are for a human debugging one run (filtered by `runId`); events are
for metrics and alerting across runs. Use both where both apply — they're complementary,
not redundant.

## Debuggability details worth remembering

- Name async operations passed to `executeWithRetry()` etc. — an anonymous arrow gives a
  useless stack trace; a named function (`callProvider`) doesn't.
- Errors carry the original `cause` — see the `errors` skill.
- `LifecycleStateMachine.transition()` returns the previous state specifically so
  `pipeline.ts` can log the transition in one line without a separate variable. The state
  machine itself has no logging capability — it's a pure guard; all transition logs are
  written by `pipeline.ts`.
