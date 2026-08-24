# B6–B7 — Context Policy Extensions: Best-Effort Loading + Context Timeout

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

> **Precondition:** P04-A5 (`ContextPolicy` base: `maxMessagesPerProvider`, `maxContentLengthChars`, `DEFAULT_CONTEXT_POLICY`) must be merged before M05 branch. M05 extends that surface; it does not create it.

### Phase 1 (B6): Best-Effort Context Loading via `onProviderFailure?: 'skip'`

1. Add optional `onProviderFailure?: 'fail' | 'skip'` field to the `ContextPolicy` interface (added by P04-A5 in `packages/core/src/interfaces.ts:248-256`). Making it required would be MAJOR per `api-design:39`; additive optional field is MINOR. Default `'fail'` is provided via `DEFAULT_CONTEXT_POLICY` (`packages/core/src/policies.ts:5-24`) and `OrchestratorConfig.contextPolicy?: Partial<ContextPolicy>` handles absence; profile override via `profile.ts:80-185` `resolveConfig()` propagates it.
2. When `onProviderFailure: 'skip'`, a failed `ContextProvider` is skipped instead of aborting context loading. The `context.failed` event still fires for visibility.
3. Emit new `context.skipped` event type when a provider is skipped (additive union member on `OrchestratorEvent` at `packages/core/src/interfaces.ts:432-458`). Payload is `{ type: 'context.skipped'; runId: string; providerId: string; error: EventErrorPayload }` via `toEventErrorPayload()` (`pipeline.ts:55-61`) — not `reason: string` (S-1 hygiene, ADR-042 §c).
4. If ALL context providers are skipped and no context messages were collected (`skippedCount === contextProviders.length && providerResults.length === 0`), transition to `FAILED` with `ContextLoadError`. Note: empty-array success (`providerResults.length === 0` with `skippedCount === 0`) is not "all skipped" — guard must check both conditions.
5. Default behavior remains `'fail'` (backward compatible, ADR-015 default preserved, ADR-042 amends).

### Phase 2 (B7): Per-Provider Context Timeout via `contextTimeoutMs`

1. Add optional `contextTimeoutMs?: number` field to `TimeoutPolicy` interface (`packages/core/src/interfaces.ts:235-242`). `DEFAULT_TIMEOUT` (`packages/core/src/policies.ts:14-18`) must explicitly contain `contextTimeoutMs: undefined`; `mergeTimeoutPolicy` spread handles it. `OrchestratorConfig.timeout?: Partial<TimeoutPolicy>` keeps the field optional; `ResolvedConfig.timeout` required mapping unchanged (`packages/core/src/types.ts:35`).
2. `ContextProviderInput` already includes `signal?: AbortSignal` via `ContextProviderInput = Omit<RunInput,'stream'|'profile'>` (`packages/core/src/interfaces.ts:173` via `RunInput:267`); do NOT add a new `& { signal?: AbortSignal }` intersection — it is redundant and removed per C3. Only forward `input.signal` to `provider.provide({ ...contextProviderInput, signal: input.signal })`.
3. When `contextTimeoutMs` is set, wrap each `ContextProvider.provide()` call in `withTimeout()` (`policies.ts:94-121`). The `withTimeout` rejection (`TimeoutExceededError` at `errors.ts:230-237`, `retryable=false`) must be caught and re-wrapped as `ContextLoadError(providerId, timeoutCause)` (`errors.ts:138-150`, `retryable=true`) before skip/fail branching (C1 fix). `TimeoutExceededError` itself is NOT retryable — the earlier "isRetryable===true" claim was false.
4. `contextTimeoutMs` must NOT affect `totalTimeoutMs` — the hard ceiling at the pipeline top level (`pipeline.ts:1536-1539` `Promise.race`) is still enforced independently. `withTimeout(providePromise)` does not cancel the provider after timeout; optionally compose `AbortSignal.any([input.signal, AbortSignal.timeout(ms)])` for cooperative cancellation. Streaming is also affected because `executeStreamingPipeline` also calls `initializePipeline`.

---

## 2. Context (Why This Exists)

### Phase 1 (B6) — Fail-Fast Discards Partial Results

Currently (per ADR-015), pipeline Step 2 (CONTEXT_INJECTING) is fail-fast: the first `ContextProvider` failure aborts all context loading. Partial results from earlier providers are discarded. The pipeline transitions to `RETRYING` (if retryable) or `FAILED`.

This reduces reliability in multi-provider setups. For example, a RAG vector store might be temporarily unavailable, but a web-search context provider could still contribute useful context. With fail-fast, the user gets no context at all when one provider fails.

The `ContextPolicy` interface was introduced by P04-A5 (v1.0.2) with `maxMessagesPerProvider` and `maxContentLengthChars`. Adding `onProviderFailure` extends this policy surface, implementing ADR-015's deferred scope for best-effort context loading. ADR-042 (amendment to ADR-015, Status: Approved) now authorizes this as opt-in `'skip'` mode.

### Phase 2 (B7) — No Fine-Grained Provider Timeout

Currently `totalTimeoutMs` is the only ceiling for context loading. If one provider hangs (e.g., slow RAG query), it consumes the entire `totalTimeoutMs` budget, potentially starving the generation phase. A per-provider timeout (`contextTimeoutMs`) ensures that a single slow provider doesn't bring down the entire run.

The `signal?: AbortSignal` forwarding to `ContextProvider.provide()` follows the existing pattern in `PromptRequest.signal` (used for `generateTimeoutMs`). This is backward-compatible — existing `ContextProvider` implementations that do not read the `signal` field continue to work unchanged. No new `signal` field is added to the type definition itself (already present via `Omit<RunInput,'stream'|'profile'>`).

---

## 3. Issues/Changes

### Phase 1 — Issue B6: No Best-Effort Context Loading Mode

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Lines       | N/A — `ContextPolicy` interface definition zone (added by P04-A5, near other policy interfaces, `interfaces.ts:248-256`)                                                                                                                                                                                                                                                                                                                           |
| Severity    | MEDIUM                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Description | `ContextPolicy` has no `onProviderFailure` field. Context loading is always fail-fast. Users cannot opt into best-effort mode where failed providers are skipped and remaining providers continue.                                                                                                                                                                                                                                                 |
| Fix         | Add optional `onProviderFailure?: 'fail' \| 'skip'` field to `ContextPolicy` (NOT required — required would be MAJOR per `api-design:39`). Default in `DEFAULT_CONTEXT_POLICY` (`policies.ts:5-24`) must be `'fail'`. `OrchestratorConfig.contextPolicy?: Partial<ContextPolicy>` and `OrchestratorProfile.contextPolicy?: Partial<ContextPolicy>` via `profile.ts:80-185` `resolveConfig()` handle override. Update is additive optional — MINOR. |

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts:300-409 initializePipeline()` (post-B1 split → `pipeline/shared.ts:initializePipeline`)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Lines       | Context loading loop in `initializePipeline()` (Steps 1–4; `pipeline.ts:371-408` CONTEXT_INJECTING)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Severity    | MEDIUM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Description | Context loop catches error and transitions to RETRYING or FAILED immediately. No skip logic exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Fix         | In the catch block, check `config.contextPolicy.onProviderFailure === 'skip'`. If skip: emit `context.failed` + `context.skipped` (both with `EventErrorPayload` via `toEventErrorPayload()` at `pipeline.ts:55-61`, S-1), do NOT transition — continue to next provider. Track `skippedCount`. At end, if `skippedCount === contextProviders.length && providerResults.length === 0` → FAILED (outer catch handles `run.failed` — do not double-emit). Emphasis: `providerResults.length === 0` alone is not "all skipped" — empty-array success must not trigger FAILED. |

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts:432-458` (`OrchestratorEvent` union) — `packages/core/src/events.ts` has no type definition, only emit path (ADR-004 fire-and-forget)                                                                                                                                                                                                                                  |
| Lines       | N/A — `OrchestratorEvent` union definition in `packages/core/src/interfaces.ts:432-458`                                                                                                                                                                                                                                                                                                                 |
| Severity    | LOW                                                                                                                                                                                                                                                                                                                                                                                                     |
| Description | No `context.skipped` event type exists. Consumers need visibility into skipped providers.                                                                                                                                                                                                                                                                                                               |
| Fix         | Add `{ type: 'context.skipped'; runId: string; providerId: string; error: EventErrorPayload }` to the `OrchestratorEvent` union (NOT `reason: string` — see ADR-042 §c, S-1 hygiene, consistency with `tool.failed`/`context.failed`). Emit in `pipeline.ts:300-409` (post-B1 `pipeline/shared.ts:initializePipeline`) when a provider is skipped, using `toEventErrorPayload()` (`pipeline.ts:55-61`). |

### Phase 2 — Issue B7: No Per-Provider Context Timeout

| Field       | Value                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                                                                                                                                                                                                                                                         |
| Lines       | `TimeoutPolicy` interface (`packages/core/src/interfaces.ts:235-242`)                                                                                                                                                                                                                                                                                     |
| Severity    | MEDIUM                                                                                                                                                                                                                                                                                                                                                    |
| Description | `TimeoutPolicy` has `generateTimeoutMs`, `toolTimeoutMs`, `totalTimeoutMs` but no `contextTimeoutMs`. Each `ContextProvider.provide()` shares the `totalTimeoutMs` budget with generation, which can starve generation.                                                                                                                                   |
| Fix         | Add optional `contextTimeoutMs?: number` field to `TimeoutPolicy`. `DEFAULT_TIMEOUT` (`policies.ts:14-18`) must explicitly have `contextTimeoutMs: undefined` (M5); `mergeTimeoutPolicy` spread propagates it. `OrchestratorConfig.timeout?: Partial<TimeoutPolicy>` keeps optional; `ResolvedConfig.timeout` required mapping unchanged (`types.ts:35`). |

| Field       | Value                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                                                                                                                                                                                                                                                                 |
| Lines       | `ContextProviderInput` type (`packages/core/src/interfaces.ts:173`: `Omit<RunInput, 'stream' \| 'profile'>`)                                                                                                                                                                                                                                                      |
| Severity    | LOW                                                                                                                                                                                                                                                                                                                                                               |
| Description | `ContextProviderInput` already includes `signal?: AbortSignal` via `Omit<RunInput,'stream'\|'profile'>` (`interfaces.ts:173` via `RunInput:267`). No new field needed.                                                                                                                                                                                            |
| Fix         | No type change — the `& { signal?: AbortSignal }` intersection drafted in M05 §6 Step 5 is redundant and removed (C3). Only forwarding is needed: `provider.provide({ ...contextProviderInput, signal: input.signal })`. If cooperative timeout cancellation is desired, compose `AbortSignal.any([input.signal, AbortSignal.timeout(ms)].filter(Boolean))` (M4). |

| Field       | Value                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts:300-409` (post-B1 split → `pipeline/shared.ts:initializePipeline`)                                                                                                                                                                          |
| Lines       | Context provider call site in `initializePipeline()` (`const messages = await provider.provide(contextProviderInput)`)                                                                                                                                                     |
| Severity    | MEDIUM                                                                                                                                                                                                                                                                     |
| Description | `provide()` call has no timeout wrapping. A hanging provider consumes the entire `totalTimeoutMs` budget.                                                                                                                                                                  |
| Fix         | When `config.timeout.contextTimeoutMs` is set, wrap with `withTimeout` + re-wrap `TimeoutExceededError` as `ContextLoadError` (C1). Use `const ms = config.timeout.contextTimeoutMs; if (ms !== undefined)` guard — no `!` assertion (C6). See §4.1 and §6 Step 6 snippet. |

---

## 4. Architectural Directives

### ADR-042: ContextProvider Best-Effort Skip Mode (Amendment to ADR-015) — Status: Approved

This plan implements ADR-042 (amendment to ADR-015, appended to `DECISION-LOG.md` as 80 insertions, Status: Approved) and supersedes the earlier M05 draft that used `reason: string` for `context.skipped` and claimed `TimeoutExceededError` was retryable. All references to `reason: string` and `isRetryable===true` for `TimeoutExceededError` are corrected below per ADR-042 §c and `errors.ts:230-237`.

### 4.1 Chosen Approach

**B6 — Skip behavior:**

- In the context loading loop (`pipeline.ts:300-409` `initializePipeline()`, post-B1 split → `pipeline/shared.ts:initializePipeline`), when a `ContextProvider.provide()` throws:
  - Check `config.contextPolicy.onProviderFailure` (optional; defaults to `'fail'` via `DEFAULT_CONTEXT_POLICY` at `policies.ts:5-24`; `OrchestratorConfig.contextPolicy?: Partial<ContextPolicy>` and profile override via `profile.ts:80-185` handle it; making it required would be MAJOR per `api-design:39`).
  - If `'fail'`: existing behavior — emit `context.failed` (with `EventErrorPayload` via `toEventErrorPayload()` at `pipeline.ts:55-61`, S-1), transition to `RETRYING` (retryable) or `FAILED` (fatal).
  - If `'skip'`: emit `context.failed` + `context.skipped` (both with `EventErrorPayload` via `toEventErrorPayload()`), increment a local `skippedCount`. Do NOT transition state. Continue to the next provider.
- At the end of the loop (after all providers attempted), if `skippedCount === contextProviders.length && providerResults.length === 0`: transition to `FAILED` with `ContextLoadError('All context providers failed')` and let the outer catch emit `run.failed` (do not manually double-emit `run.failed` in the all-skipped guard — leave to outer handler at `pipeline.ts:1057-1080` pattern). Note: `providerResults.length === 0` alone with `skippedCount === 0` (all providers returned empty array successfully) is NOT "all skipped" — guard must check both `skippedCount` and `providerResults`.
- The `context.skipped` event is emitted once per skipped provider with `providerId` and `error: EventErrorPayload` (via `toEventErrorPayload()` — `code`/`message`/`retryable` only, never `cause`, S-1 hygiene). Not `reason: string`.
- No partial state is stored across `run()` calls — all state is local to the invocation.
- Type for `context.skipped` lives in `packages/core/src/interfaces.ts:432-458` (`OrchestratorEvent`), not in `events.ts`; `events.ts` is emit-path only (ADR-004).

**B7 — Per-provider timeout:**

- The `contextTimeoutMs` wraps each individual `provider.provide()` call using the existing `withTimeout()` function from `policies.ts:94-121`.
- `withTimeout()` rejects with `TimeoutExceededError` (`errors.ts:230-237`, `retryable=false`, `code='TIMEOUT_EXCEEDED'`) — it is NOT retryable. The earlier M05 claim that `TimeoutExceededError` is `isRetryable() === true` was false and is corrected here. The rejection must be caught and re-wrapped as `ContextLoadError(providerId, timeoutCause)` (`errors.ts:138-150`, `retryable=true`, `code='CONTEXT_LOAD_FAILED'`) before the skip/fail branching, matching the existing normalization `error instanceof OrchestratorError ? error : new ContextLoadError(providerId, error)` at `pipeline.ts:396-397`. This makes the decision policy-driven (`onProviderFailure`), not retryable-driven, and keeps `context.failed`/`context.skipped` `EventErrorPayload.retryable=true` for observability.
- Wrap snippet (C1 + C6, with `input.signal` forwarding and no `!` assertion):
  ```typescript
  const ms = config.timeout.contextTimeoutMs;
  const messages =
    ms !== undefined
      ? await withTimeout(
          provider.provide({ ...contextProviderInput, signal: input.signal }),
          ms,
        ).catch((e: unknown) => {
          throw e instanceof TimeoutExceededError ? new ContextLoadError(provider.id, e) : e;
        })
      : await provider.provide({ ...contextProviderInput, signal: input.signal });
  ```
  If cooperative cancellation after `withTimeout` is desired (since `withTimeout` alone does not cancel the provider), optionally compose `AbortSignal.any([input.signal, AbortSignal.timeout(ms)].filter(Boolean) as AbortSignal[])` and pass that composed signal to `provide()`. `withTimeout` remains the hard `Promise.race` ceiling (ADR-014).
- The `totalTimeoutMs` hard ceiling at the pipeline top level (Step 0, `pipeline.ts:1536-1539` `Promise.race`) is unchanged and independently enforced. `contextTimeoutMs` does not adjust `totalTimeoutMs`. Streaming is also affected because `executeStreamingPipeline` also calls `initializePipeline`, so the same wrapping applies in streaming mode.
- The `signal` forwarded to `ContextProviderInput` is the user-provided `RunInput.signal` for run-level cancellation. It is NOT the timeout signal — timeout is enforced by `withTimeout()` (and optionally `AbortSignal.timeout` composition).

### 4.2 What NOT to Do

- Do NOT change the default `onProviderFailure` value (`'fail'`) — skip mode is opt-in. The field itself is optional (`onProviderFailure?: 'fail'|'skip'`) with default in `DEFAULT_CONTEXT_POLICY`.
- Do NOT store partial context loading state across `run()` calls (Principle 4: Stateless Core).
- Do NOT add new exports to `@atisse/core` for internal context loading utilities.
- Do NOT modify the `ContextProvider.provide()` method signature — only forwarding `signal` from `input.signal`; no type intersection added (C3).
- Do NOT add `contextTimeoutMs` to `totalTimeoutMs` calculation — they are independent (`pipeline.ts:1536-1539`).
- Do NOT change the `OrchestratorError` hierarchy or add new error codes — existing `CONTEXT_LOAD_FAILED` and `CONTEXT_PROVIDER_FAILED` codes are sufficient; `TimeoutExceededError` is re-wrapped as `ContextLoadError`.
- Do NOT add new dependencies to core — `withTimeout` already exists in `policies.ts`.
- Do NOT use `config.timeout.contextTimeoutMs!` non-null assertion — use `const ms = ...; if (ms !== undefined)` guard (C6).
- Do NOT use `reason: string` for `context.skipped` — use `error: EventErrorPayload` via `toEventErrorPayload()` (S-1, ADR-042 §c).

---

## 5. Files to Modify

| File                                                                                              | Action           | Notes                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`                                                                 | MODIFY           | Add `onProviderFailure?: 'fail' \| 'skip'` (optional with TSDoc default `'fail'`) to `ContextPolicy`; add `contextTimeoutMs?: number` to `TimeoutPolicy`; add `context.skipped` with `error: EventErrorPayload` to `OrchestratorEvent` (`interfaces.ts:432-458`). No `signal` intersection — `ContextProviderInput` already has it via `Omit<RunInput,'stream' | 'profile'>` (`interfaces.ts:173`).                                                          |
| `packages/core/src/policies.ts`                                                                   | MODIFY           | Add `onProviderFailure: 'fail'` to `DEFAULT_CONTEXT_POLICY` (`policies.ts:5-24`); add `contextTimeoutMs: undefined` explicitly to `DEFAULT_TIMEOUT` (`policies.ts:14-18`) (M5). Merge (`mergeContextPolicy`/`mergeTimeoutPolicy` at `policies.ts:46-68`) already handles spread.                                                                               |
| `packages/core/src/types.ts`                                                                      | MODIFY           | `ResolvedConfig.timeout` already typed as `TimeoutPolicy` — no change needed since field is optional (`types.ts:35`). `ResolvedConfig.contextPolicy: ContextPolicy` (P04-A5) resolves optional → required mapping.                                                                                                                                             |
| `packages/core/src/pipeline.ts:300-409` (post-B1 split → `pipeline/shared.ts:initializePipeline`) | MODIFY           | B6: context loading loop with skip logic + `context.failed`/`context.skipped` emits via `toEventErrorPayload()` (`pipeline.ts:55-61`); B7: timeout wrapping with `TimeoutExceededError` → `ContextLoadError` re-wrap + `input.signal` forwarding + `AbortSignal.any` optional composition.                                                                     |
| `packages/core/src/profile.ts`                                                                    | MODIFY           | Wire `contextPolicy` resolution in `resolveConfig()` branching (like `retry`/`timeout`/`toolPolicy` pattern at `profile.ts:80-185`): `let contextPolicy = DEFAULT_CONTEXT_POLICY; if (profileName) merge profile.contextPolicy else merge base` (M1).                                                                                                          |
| `packages/core/src/orchestrator.ts`                                                               | MODIFY           | Eager `ConfigValidationError` for `onProviderFailure` enum (`'fail'                                                                                                                                                                                                                                                                                            | 'skip'`) and `contextTimeoutMs` (`isInteger >0`finite) at`orchestrator.ts:73` pattern (M2). |
| `packages/core/src/events.ts`                                                                     | No change needed | Type lives in `packages/core/src/interfaces.ts:432-458` (`OrchestratorEvent`); emit path is inline objects — `events.ts` defines fire-and-forget bus only (ADR-004).                                                                                                                                                                                           |
| `.changeset/<id>.md`                                                                              | NEW              | MINOR changeset — additive optional fields (`onProviderFailure?`, `contextTimeoutMs?`, `context.skipped`), default `'fail'` preserves ADR-015 behavior.                                                                                                                                                                                                        |

> **Ordering:** P04-A5 must be merged before M05 branch (ContextPolicy base). A5 in the table above refers to that dependency.

---

## 6. Implementation Strategy

### Phase 1 — Step 1: Add `onProviderFailure?: 'fail' | 'skip'` to `ContextPolicy` (optional)

- Open `packages/core/src/interfaces.ts`
- Locate the `ContextPolicy` interface (added by P04-A5, near `ToolPolicy`, `interfaces.ts:248-256`)
- Add:
  ```typescript
  /** Behavior when a ContextProvider fails. 'fail' aborts context loading; 'skip' continues with remaining providers. Default: 'fail' */
  onProviderFailure?: 'fail' | 'skip';
  ```
- In `packages/core/src/policies.ts:5-24` add `onProviderFailure: 'fail'` to `DEFAULT_CONTEXT_POLICY` explicitly (so `DEFAULT_CONTEXT_POLICY` satisfies required `ResolvedConfig.contextPolicy` after merge).
- Note: `OrchestratorConfig.contextPolicy?: Partial<ContextPolicy>` (`interfaces.ts:369-382`) and `OrchestratorProfile.contextPolicy?: Partial<ContextPolicy>` (`interfaces.ts:384-399`) already allow partial override. Making the interface field required would be MAJOR per `api-design:39` — optional + default preserves MINOR classification (ADR-042 §a).
- The spread-based `mergeContextPolicy()` (`policies.ts:60-68` pattern) already handles arbitrary fields — no merge logic change needed.

### Phase 1 — Step 2: Add `context.skipped` Event Type with `EventErrorPayload`

- Open `packages/core/src/interfaces.ts:432-458`
- Add to the `OrchestratorEvent` union (after `context.failed`):
  ```typescript
  | { type: 'context.skipped'; runId: string; providerId: string; error: EventErrorPayload }
  ```
- NOT `reason: string` — ADR-042 §c and S-1 hygiene require `EventErrorPayload` via `toEventErrorPayload()` (`pipeline.ts:55-61`) (`code`/`message`/`retryable` only, never `cause`). Consistent with `tool.failed`/`context.failed` (`interfaces.ts:440-444`, `events.ts:9-30`).

### Phase 1 — Step 3: Implement Skip Logic in `pipeline.ts:300-409` (post-B1 split → `pipeline/shared.ts:initializePipeline`)

- Open `packages/core/src/pipeline.ts:300-409` (where `initializePipeline()` — Steps 1–4 — lives; post-B1 split → `pipeline/shared.ts:initializePipeline`)
- In the context loading loop of `initializePipeline()` (`pipeline.ts:371-408`), modify the catch block:

  ```typescript
  try {
    const ms = config.timeout.contextTimeoutMs;
    const messages =
      ms !== undefined
        ? await withTimeout(
            provider.provide({ ...contextProviderInput, signal: input.signal }),
            ms,
          ).catch((e: unknown) => {
            throw e instanceof TimeoutExceededError ? new ContextLoadError(provider.id, e) : e;
          })
        : await provider.provide({ ...contextProviderInput, signal: input.signal });
    // ... existing success handling (enforceCharLimit, push to providerResults) ...
  } catch (error: unknown) {
    const normalizedError =
      error instanceof OrchestratorError ? error : new ContextLoadError(provider.id, error);
    // Emit context.failed for every failure (visibility) — use toEventErrorPayload
    eventBus.emit({
      type: 'context.failed',
      runId,
      providerId: provider.id,
      error: toEventErrorPayload(normalizedError),
    });

    // Check skip mode (optional field — defaults to 'fail' via DEFAULT_CONTEXT_POLICY)
    if (config.contextPolicy.onProviderFailure === 'skip') {
      eventBus.emit({
        type: 'context.skipped',
        runId,
        providerId: provider.id,
        error: toEventErrorPayload(normalizedError),
      });
      skippedCount++;
      continue; // Skip this provider, continue with next — no state transition
    }

    // Existing fail-fast logic
    if (isRetryable(normalizedError)) {
      stateMachine.transition('RETRYING');
      // ... existing retry logic ...
    } else {
      stateMachine.transition('FAILED');
      // ... existing failure logic — outer catch handles run.failed ...
    }
  }
  ```

- After the loop, add a check (leave `run.failed` to outer catch):
  ```typescript
  if (skippedCount === contextProviders.length && providerResults.length === 0) {
    const err = new ContextLoadError('All context providers failed');
    stateMachine.transition('FAILED');
    // Do not emit run.failed here — outer catch at pipeline.ts:1057-1080 pattern handles it
    logger.error('Run failed — all context providers skipped', { runId });
    throw err;
  }
  ```
- Ensure `skippedCount` is initialized as a local variable (`let skippedCount = 0`) before the loop. Guard is `skippedCount === contextProviders.length && providerResults.length === 0` — emphasize that `providerResults.length === 0` with `skippedCount === 0` (all providers returned empty successfully) is NOT "all skipped" and must not trigger FAILED; continue to `CONTEXT_INJECTED` (`pipeline.ts:412-413`) when at least one provider succeeded even if some skipped.

### Phase 2 — Step 4: Add `contextTimeoutMs?: number` to `TimeoutPolicy` with explicit `undefined` default

- Open `packages/core/src/interfaces.ts:235-242`
- Add to `TimeoutPolicy`:
  ```typescript
  /** Per ContextProvider.provide() timeout in ms. Default: undefined (no per-provider timeout) */
  contextTimeoutMs?: number;
  ```
- In `packages/core/src/policies.ts:14-18` `DEFAULT_TIMEOUT` must explicitly have `contextTimeoutMs: undefined` (M5):
  ```typescript
  export const DEFAULT_TIMEOUT = {
    generateTimeoutMs: undefined,
    toolTimeoutMs: undefined,
    totalTimeoutMs: undefined,
    contextTimeoutMs: undefined,
  } as const;
  ```
- No changes to `mergeTimeoutPolicy()` (`policies.ts:46-54`) needed — it already does a shallow spread.
- `OrchestratorConfig.timeout?: Partial<TimeoutPolicy>` keeps field optional; `ResolvedConfig.timeout: TimeoutPolicy` (`types.ts:35`) required mapping unchanged.

### Phase 2 — Step 5: Forward `signal` to `ContextProviderInput` (no type change)

- No change to `ContextProviderInput` type — it already includes `signal?: AbortSignal` via `Omit<RunInput,'stream'|'profile'>` (`packages/core/src/interfaces.ts:173` via `RunInput:267`).
- The `& { signal?: AbortSignal }` intersection drafted in M05 §6 Step 5 is redundant and removed (C3).
- In the call site, forward `input.signal`:
  ```typescript
  provider.provide({ ...contextProviderInput, signal: input.signal });
  ```
- If timeout-aware cooperative cancellation is desired, optionally compose: `AbortSignal.any([input.signal, AbortSignal.timeout(ms)].filter(Boolean) as AbortSignal[])` — `withTimeout` alone does not cancel the provider (M4).

### Phase 2 — Step 6: Wrap `provider.provide()` with Timeout + Re-wrap (C1 + C6)

- Open `packages/core/src/pipeline.ts:300-409` (post-B1 split → `pipeline/shared.ts:initializePipeline`)
- Import `withTimeout` from `../policies.js` (already exported at `policies.ts:94-121`) and `TimeoutExceededError` / `ContextLoadError` from `../errors.js`.
- In the context loading loop of `initializePipeline()`, wrap the `provide()` call with no `!` assertion:

  ```typescript
  const ms = config.timeout.contextTimeoutMs;
  const messages =
    ms !== undefined
      ? await withTimeout(
          provider.provide({ ...contextProviderInput, signal: input.signal }),
          ms,
        ).catch((e: unknown) => {
          throw e instanceof TimeoutExceededError ? new ContextLoadError(provider.id, e) : e;
        })
      : await provider.provide({ ...contextProviderInput, signal: input.signal });
  ```

- Add note: compose `input.signal` with timeout signal via `AbortSignal.any` if cooperative cancellation is needed after `withTimeout` fires (M4). Streaming path (`executeStreamingPipeline` also calls `initializePipeline`) is similarly wrapped.
- When `contextTimeoutMs` fires, `withTimeout` throws `TimeoutExceededError` (`errors.ts:230-237`, `retryable=false`). The `.catch` re-wraps it as `ContextLoadError(providerId, cause)` (`errors.ts:138-150`, `retryable=true`). The B6-modified catch block then handles it according to `onProviderFailure` (policy-driven, not retryable-driven). Direct `TimeoutExceededError` is never emitted or branched on.
- `totalTimeoutMs` top-level `Promise.race` (`pipeline.ts:1536-1539`, ADR-014/ADR-026) remains independent and is not adjusted by `contextTimeoutMs`.

### Step 7: Wire `profile.ts` and `orchestrator.ts` (M1 + M2)

- **Profile wiring (`packages/core/src/profile.ts:80-185` `resolveConfig()`):**

  ```typescript
  let contextPolicy = DEFAULT_CONTEXT_POLICY;
  if (profileName !== undefined) {
    const profile = config.profiles?.[profileName];
    if (profile?.contextPolicy) contextPolicy = { ...contextPolicy, ...profile.contextPolicy };
    // ... same branching for retry/timeout/toolPolicy pattern ...
  } else {
    if (config.contextPolicy) contextPolicy = { ...contextPolicy, ...config.contextPolicy };
  }
  // Add contextPolicy to ResolvedConfig builder
  ```

  This mirrors the `retry`/`timeout`/`toolPolicy` branching at `profile.ts:80-185`. `profile.resolved` event `overrides` gains `contextPolicy: boolean` when profile provides it (ADR-042 profile interaction).

- **Eager validation (`packages/core/src/orchestrator.ts:55-139` construction, `orchestrator.ts:73` pattern):**
  ```typescript
  if (
    config.contextPolicy?.onProviderFailure !== undefined &&
    !['fail', 'skip'].includes(config.contextPolicy.onProviderFailure)
  ) {
    throw new ConfigValidationError('contextPolicy.onProviderFailure must be "fail" or "skip"');
  }
  if (config.timeout?.contextTimeoutMs !== undefined) {
    const v = config.timeout.contextTimeoutMs;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
      throw new ConfigValidationError('timeout.contextTimeoutMs must be a finite integer > 0');
    }
  }
  // Also validate contextPolicy.maxMessagesPerProvider / maxContentLengthChars per P04-A5 (integer ≥1 finite, S-5)
  ```

### Step 8: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
- All existing tests must pass without modification (both phases are additive/opt-in; optional fields default via `DEFAULT_*`).

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify (at least 9 cases, M6):

- **B6 — Skip mode (policy-driven, not retryable-driven):**
  - With `contextPolicy: { onProviderFailure: 'skip' }` and one failing provider, context loading proceeds with remaining providers; `providerResults` contains success messages; transition `CONTEXT_INJECTED` (`pipeline.ts:412-413`) and continue to memory load / `PROMPT_COMPOSED` even though some providers skipped.
  - `context.failed` event is emitted for the failing provider with `EventErrorPayload { code='CONTEXT_LOAD_FAILED', retryable=true }` via `toEventErrorPayload()` (`pipeline.ts:55-61`).
  - `context.skipped` event is emitted for the skipped provider with `EventErrorPayload { code='CONTEXT_LOAD_FAILED', retryable=true }` (not `reason:string`); verify `error.code`/`retryable` branching and S-1 hygiene (no `cause`/secret).
  - Skipped event count: with 2 of 3 providers failing and `skip`, exactly 2 `context.skipped` emits and 2 `context.failed` emits.
  - With ALL providers failing and `onProviderFailure: 'skip'`, pipeline transitions to `FAILED` via `skippedCount === contextProviders.length && providerResults.length === 0` guard; throws `ContextLoadError('All context providers failed')` + `run.failed` (outer catch). Empty-array success (`providerResults.length === 0` with `skippedCount === 0`) does NOT trigger FAILED — it proceeds to `CONTEXT_INJECTED`.
  - With `onProviderFailure: 'fail'` (default, `DEFAULT_CONTEXT_POLICY` `'fail'`), behavior is unchanged — first failure aborts all loading (ADR-015 parity); no `context.skipped` emitted.
  - At least-one-success → `CONTEXT_INJECTED` even if some skipped (vs. all-skipped → `FAILED`).

- **B7 — Context timeout (C1 re-wrap, C6 guard, M4 independence):**
  - With `timeout: { contextTimeoutMs: 50 }` and a provider that takes 100ms, `withTimeout` rejects with `TimeoutExceededError` (`retryable=false`) which is caught and re-wrapped as `ContextLoadError(providerId, TimeoutExceededError)` (`ContextLoadError.*TimeoutExceededError` mapping) with `retryable=true` before skip/fail branching; then follows retry/skip logic per `onProviderFailure`. Direct `TimeoutExceededError` is never emitted.
  - Without `contextTimeoutMs` (`undefined` in `DEFAULT_TIMEOUT` at `policies.ts:14-18`), no timeout wrapping occurs — verify `ms !== undefined` guard, no `!` assertion.
  - With `timeout: { contextTimeoutMs: 0 }` / `<=0` / `Infinity` / `NaN` at construction, eager `ConfigValidationError` is thrown (`orchestrator.ts:73` pattern, M2); no wrapping attempted.
  - `totalTimeoutMs` is still enforced independently at the top level via `Promise.race` (`pipeline.ts:1536-1539`); `contextTimeoutMs` does not adjust it. Streaming path (`executeStreamingPipeline` → `initializePipeline`) similarly wraps — verify streaming+timeout+skip integration (provider timeout in streaming mode still skips to next provider).
  - `withTimeout(providePromise)` does not cancel provider after timeout — optionally verify `AbortSignal.any([input.signal, AbortSignal.timeout(ms)])` composition forwards composed signal.

- **Profile & config (M1/M2/M5):**
  - Profile override via `profile.ts:80-185` `resolveConfig()` branching: base `contextPolicy` not merged when `profileName` active (isolation, P04-A5 parity); `profile.contextPolicy: { onProviderFailure: 'skip' }` overrides base `'fail'`; `timeout.contextTimeoutMs` similarly via profile.
  - `DEFAULT_TIMEOUT` (`policies.ts:14-18`) explicitly has `contextTimeoutMs: undefined`; `mergeTimeoutPolicy` spread handles it; `OrchestratorConfig.timeout?: Partial<TimeoutPolicy>` keeps optional, `ResolvedConfig.timeout` required mapping unchanged (`types.ts:35`).

- **Backward compatibility:**
  - An orchestrator config without `contextPolicy` gets defaults (`onProviderFailure: 'fail'`, no `contextTimeoutMs` via `contextTimeoutMs: undefined`).
  - All existing tests pass without modification (`pnpm test`).

---

## 8. Risk Assessment

| Risk                                                             | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B6 changes core execution path (context loading)                 | Medium     | High   | Skip mode is opt-in (`onProviderFailure?: 'fail'                                                                                                                                                                                                                                                     | 'skip'`default`'fail'`); default behavior unchanged. All existing tests pass without change. |
| B7 adds `contextTimeoutMs` per-provider timeout wrapping         | Medium     | Medium | Field is optional (`contextTimeoutMs?: number`, `DEFAULT_TIMEOUT` `undefined`); `ms !== undefined` guard ensures no wrapping when absent. `withTimeout` already exists in `policies.ts:94-121`.                                                                                                      |
| `contextTimeoutMs` interacts with totalTimeoutMs                 | Medium     | Medium | They are independent — `totalTimeoutMs` is a separate `Promise.race` at pipeline top level (`pipeline.ts:1536-1539`, ADR-014/ADR-026). Per-provider timeout does not adjust total. Streaming path also handled.                                                                                      |
| Merge of `contextPolicy`/`contextTimeoutMs` missed in profile.ts | Medium     | Low    | Profile merge for `contextPolicy`/`timeout` uses branching spread (`profile.ts:80-185` pattern) — new fields propagate via same path as `retry`/`timeout`/`toolPolicy`; explicit wiring added in §6 Step 7. (Likelihood raised from Low to Medium per M1 — wiring is manual, not automatic spread.)  |
| `context.skipped` event not emitted correctly                    | Low        | Low    | Verify in unit test by subscribing to Orchestrator events; payload is `EventErrorPayload` via `toEventErrorPayload()` (`pipeline.ts:55-61`), not `reason:string` (S-1).                                                                                                                              |
| `TimeoutExceededError` retryable false -> misclassification      | Medium     | Medium | `TimeoutExceededError` (`errors.ts:230-237`, `retryable=false`) must be wrapped as `ContextLoadError(providerId, cause)` (`errors.ts:138-150`, `retryable=true`) before skip/fail branching; direct `TimeoutExceededError` never emitted (C1). Guard `ms !== undefined` prevents `!` assertion (C6). |

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — Frozen contracts (additive optional fields only)
- `packages/core/src/interfaces.ts` — Target for `ContextPolicy` (`248-256`), `TimeoutPolicy` (`235-242`), `ContextProviderInput` (`173` via `RunInput:267`), `OrchestratorEvent` (`432-458`)
- `.opencode/skill/architecture/SKILL.md` — Steps 2–3 (context loading), ContextProvider Partial Failure section, Timeout Enforcement section
- `DECISION-LOG.md` — ADR-042 (ContextProvider Best-Effort Skip Mode, Amendment to ADR-015, Status: Approved) — primary; ADR-015 (fail-fast context loading, now amended)
- `DECISION-LOG.md` — ADR-035 (`toolTimeoutMs` mirror, `profile.ts` sync pattern), ADR-014/ADR-026 (`totalTimeoutMs` `Promise.race` at `pipeline.ts:1536-1539`)
- `.opencode/skill/security/SKILL.md` — §S-1 (EventErrorPayload hygiene via `toEventErrorPayload()` at `pipeline.ts:55-61`), §S-5 (context provider output limits `enforceCharLimit` at `pipeline.ts:262-288`)
- `packages/core/src/policies.ts` — Target for `DEFAULT_CONTEXT_POLICY` (`5-24`), `DEFAULT_TIMEOUT` (`14-18`, explicit `contextTimeoutMs: undefined`), `withTimeout` (`94-121`), `mergeContextPolicy`/`mergeTimeoutPolicy` (`46-68`)
- `packages/core/src/pipeline.ts:300-409` — Context loading loop in `initializePipeline()` (post-B1 split → `pipeline/shared.ts:initializePipeline`; loops at `371-408`, transition at `412-413`, `run.failed` at `1057-1080`, top-level `Promise.race` at `1536-1539`)
- `packages/core/src/profile.ts:80-185` — `resolveConfig()` branching for `contextPolicy`/`timeout` wiring (M1)
- `packages/core/src/orchestrator.ts:55-139` (validation at `73` pattern) — eager `ConfigValidationError` for `onProviderFailure` enum and `contextTimeoutMs` (`>0` finite) (M2)
- `packages/core/src/types.ts:35` — `ResolvedConfig.timeout` required mapping (M5 unchanged)
- `packages/core/src/errors.ts:138-150` `ContextLoadError` (`retryable=true`), `:230-237` `TimeoutExceededError` (`retryable=false`, C1), `:331-333` `isRetryable`
- `.opencode/milestones/v1/v1.0.2/P04-A5-context-policy-config.md` — A5 base establishing `ContextPolicy` (must be merged before M05)
- `.changeset/<id>.md` — MINOR changeset for additive optional fields (M5 workflow)
