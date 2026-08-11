# B6–B7 — Context Policy Extensions: Best-Effort Loading + Context Timeout

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

### Phase 1 (B6): Best-Effort Context Loading via `onProviderFailure: 'skip'`

1. Add `onProviderFailure: 'fail' | 'skip'` field to the `ContextPolicy` interface (added by A5 in `interfaces.ts`).
2. When `onProviderFailure: 'skip'`, a failed `ContextProvider` is skipped instead of aborting context loading. The `context.failed` event still fires for visibility.
3. Emit new `context.skipped` event type when a provider is skipped (additive union member on `OrchestratorEvent`).
4. If ALL context providers are skipped and no context messages were collected, transition to `FAILED` with `ContextLoadError`.
5. Default behavior remains `'fail'` (backward compatible).

### Phase 2 (B7): Per-Provider Context Timeout via `contextTimeoutMs`

1. Add optional `contextTimeoutMs?: number` field to `TimeoutPolicy` interface.
2. Inject `AbortSignal` into `ContextProvider.provide()` by adding an optional `signal?: AbortSignal` field to `ContextProviderInput`.
3. When `contextTimeoutMs` is set, wrap each `ContextProvider.provide()` call in `withTimeout()` (from `policies.ts`). If timeout fires, treat as `ContextLoadError` (retryable) and follow same retry/skip logic based on `onProviderFailure`.
4. `contextTimeoutMs` must NOT affect `totalTimeoutMs` — the hard ceiling at the pipeline top level is still enforced independently.

---

## 2. Context (Why This Exists)

### Phase 1 (B6) — Fail-Fast Discards Partial Results

Currently (per ADR-015), pipeline Step 2 (CONTEXT_INJECTING) is fail-fast: the first `ContextProvider` failure aborts all context loading. Partial results from earlier providers are discarded. The pipeline transitions to `RETRYING` (if retryable) or `FAILED`.

This reduces reliability in multi-provider setups. For example, a RAG vector store might be temporarily unavailable, but a web-search context provider could still contribute useful context. With fail-fast, the user gets no context at all when one provider fails.

The `ContextPolicy` interface was introduced by A5 (v1.0.2) with `maxMessagesPerProvider` and `maxContentLengthChars`. Adding `onProviderFailure` extends this policy surface, implementing ADR-015's deferred scope for best-effort context loading.

### Phase 2 (B7) — No Fine-Grained Provider Timeout

Currently `totalTimeoutMs` is the only ceiling for context loading. If one provider hangs (e.g., slow RAG query), it consumes the entire `totalTimeoutMs` budget, potentially starving the generation phase. A per-provider timeout (`contextTimeoutMs`) ensures that a single slow provider doesn't bring down the entire run.

The `signal?: AbortSignal` addition to `ContextProviderInput` follows the existing pattern in `PromptRequest.signal` (used for `generateTimeoutMs`). This is a backward-compatible additive change — existing `ContextProvider` implementations that do not read the `signal` field continue to work unchanged.

---

## 3. Issues/Changes

### Phase 1 — Issue B6: No Best-Effort Context Loading Mode

| Field       | Value                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                                                                                                  |
| Lines       | N/A — `ContextPolicy` interface definition zone (added by A5, near other policy interfaces)                                                                                                        |
| Severity    | MEDIUM                                                                                                                                                                                             |
| Description | `ContextPolicy` has no `onProviderFailure` field. Context loading is always fail-fast. Users cannot opt into best-effort mode where failed providers are skipped and remaining providers continue. |
| Fix         | Add `onProviderFailure: 'fail'                                                                                                                                                                     | 'skip'`field to`ContextPolicy`. Default in `DEFAULT_CONTEXT_POLICY`must be`'fail'`. Update `mergeContextPolicy()` to propagate the new field (already generic spread). |

| Field       | Value                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/shared.ts`                                                                                                                                                                           |
| Lines       | Context loading loop in `initializePipeline()` (Steps 1–4; formerly `pipeline.ts` lines ~369–410)                                                                                                                |
| Severity    | MEDIUM                                                                                                                                                                                                           |
| Description | Context loop catches error and transitions to RETRYING or FAILED immediately. No skip logic exists.                                                                                                              |
| Fix         | In the catch block, check `config.contextPolicy.onProviderFailure === 'skip'`. If skip: emit `context.failed`, do NOT transition — continue to next provider. Track skip count. At end, if all skipped → FAILED. |

| Field       | Value                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/events.ts` (and `interfaces.ts` for type)                                                                                                                  |
| Lines       | N/A — `OrchestratorEvent` union definition in `interfaces.ts`                                                                                                                 |
| Severity    | LOW                                                                                                                                                                           |
| Description | No `context.skipped` event type exists. Consumers need visibility into skipped providers.                                                                                     |
| Fix         | Add `{ type: 'context.skipped'; runId: string; providerId: string; reason: string }` to the `OrchestratorEvent` union. Emit in pipeline/shared.ts when a provider is skipped. |

### Phase 2 — Issue B7: No Per-Provider Context Timeout

| Field       | Value                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                                                                                                                       |
| Lines       | `TimeoutPolicy` interface (lines 235–242)                                                                                                                                                                               |
| Severity    | MEDIUM                                                                                                                                                                                                                  |
| Description | `TimeoutPolicy` has `generateTimeoutMs`, `toolTimeoutMs`, `totalTimeoutMs` but no `contextTimeoutMs`. Each `ContextProvider.provide()` shares the `totalTimeoutMs` budget with generation, which can starve generation. |
| Fix         | Add optional `contextTimeoutMs?: number` field to `TimeoutPolicy`. Default in `DEFAULT_TIMEOUT` and `mergeTimeoutPolicy` propagate it (already generic spread).                                                         |

| Field       | Value                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                            |
| Lines       | `ContextProviderInput` type (line 173: `Omit<RunInput, 'stream'                                              | 'profile'>`)                                                                                                                       |
| Severity    | LOW                                                                                                          |
| Description | `ContextProviderInput` does not carry an `AbortSignal`. Context providers cannot be cooperatively cancelled. |
| Fix         | Change to `Omit<RunInput, 'stream'                                                                           | 'profile'> & { signal?: AbortSignal }`— additive optional field. The`signal`in`RunInput` is the user-provided cancellation signal. |

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/shared.ts`                                                                                          |
| Lines       | Context provider call site in `initializePipeline()` (`const messages = await provider.provide(contextProviderInput)`)          |
| Severity    | MEDIUM                                                                                                                          |
| Description | `provide()` call has no timeout wrapping. A hanging provider consumes the entire `totalTimeoutMs` budget.                       |
| Fix         | When `config.timeout.contextTimeoutMs` is set, wrap with `withTimeout(provider.provide(...), config.timeout.contextTimeoutMs)`. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**B6 — Skip behavior:**

- In the context loading loop, when a `ContextProvider.provide()` throws:
  - Check `config.contextPolicy.onProviderFailure`.
  - If `'fail'`: existing behavior — emit `context.failed`, transition to `RETRYING` (retryable) or `FAILED` (fatal).
  - If `'skip'`: emit `context.failed`, increment a local `skippedCount`. Do NOT transition state. Continue to the next provider.
- At the end of the loop (after all providers attempted), if `skippedCount === config.contextProviders.length && providerResults.length === 0`: transition to `FAILED` with `ContextLoadError('All context providers failed')`.
- The `context.skipped` event is emitted once per skipped provider with the provider's `id` and the error `message` as the `reason`.
- No partial state is stored across `run()` calls — all state is local to the invocation.

**B7 — Per-provider timeout:**

- The `contextTimeoutMs` wraps each individual `provider.provide()` call using the existing `withTimeout()` function from `policies.ts`.
- `withTimeout()` returns a `Promise` that rejects with `TimeoutExceededError` (which is `isRetryable() === true`). The B6 skip logic then handles it: with `onProviderFailure: 'skip'`, the timeout is treated as a provider failure and the next provider runs.
- The `totalTimeoutMs` hard ceiling at the pipeline top level (Step 0) is unchanged and independently enforced.
- The `signal` field on `ContextProviderInput` is the user-provided `RunInput.signal` for run-level cancellation. It is NOT the timeout signal — timeout is enforced by `withTimeout()`.

> **V2_EVOLUTION_PATH:** The skip-mode and `contextTimeoutMs` features are implemented in this milestone and ship in v1.1.0. Before v2 begins, an ADR must clarify (a) skip-mode state-machine semantics and (b) `contextTimeoutMs` / `totalTimeoutMs` precedence. These are evolutionary refinements — do not defer the v1 implementations. Also: §6 Step 6 `config.timeout.contextTimeoutMs!` non-null assertion violates implementation-standards — flag for SPBED.

### 4.2 What NOT to Do

- Do NOT change the default `onProviderFailure` value (`'fail'`) — skip mode is opt-in.
- Do NOT store partial context loading state across `run()` calls (Principle 4: Stateless Core).
- Do NOT add new exports to `@atisse/core` for internal context loading utilities.
- Do NOT modify the `ContextProvider.provide()` method signature — only `ContextProviderInput` gets an optional field.
- Do NOT add `contextTimeoutMs` to `totalTimeoutMs` calculation — they are independent.
- Do NOT change the `OrchestratorError` hierarchy or add new error codes — existing `CONTEXT_LOAD_FAILED` and `CONTEXT_PROVIDER_FAILED` codes are sufficient.
- Do NOT add new dependencies to core — `withTimeout` already exists in `policies.ts`.

---

## 5. Files to Modify

| File                                   | Action           | Notes                                                                                                                                                                        |
| -------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`      | MODIFY           | Add `onProviderFailure` to `ContextPolicy`; add `contextTimeoutMs` to `TimeoutPolicy`; add `signal?` to `ContextProviderInput`; add `context.skipped` to `OrchestratorEvent` |
| `packages/core/src/policies.ts`        | MODIFY           | Add `contextTimeoutMs` to `DEFAULT_TIMEOUT` (undefined); merge already handles spread                                                                                        |
| `packages/core/src/types.ts`           | MODIFY           | `ResolvedConfig.timeout` already typed as `TimeoutPolicy` — no change needed since field is optional                                                                         |
| `packages/core/src/pipeline/shared.ts` | MODIFY           | B6: context loading loop (in `initializePipeline()`) with skip logic; B7: timeout wrapping around `provide()`                                                                |
| `packages/core/src/events.ts`          | No change needed | Event emission uses inline objects — `interfaces.ts` defines the type                                                                                                        |

---

## 6. Implementation Strategy

### Phase 1 — Step 1: Add `onProviderFailure` to `ContextPolicy`

- Open `packages/core/src/interfaces.ts`
- Locate the `ContextPolicy` interface (added by A5, near `ToolPolicy`)
- Add:
  ```typescript
  /** Behavior when a ContextProvider fails. 'fail' aborts context loading; 'skip' continues with remaining providers. Default: 'fail' */
  onProviderFailure: 'fail' | 'skip';
  ```
- Update `DEFAULT_CONTEXT_POLICY` in `policies.ts` to include `onProviderFailure: 'fail'`.
- The spread-based `mergeContextPolicy()` already handles arbitrary fields — no merge logic change needed.

### Phase 1 — Step 2: Add `context.skipped` Event Type

- Open `packages/core/src/interfaces.ts`
- Add to the `OrchestratorEvent` union (after `context.failed`):
  ```typescript
  | { type: 'context.skipped'; runId: string; providerId: string; reason: string }
  ```

### Phase 1 — Step 3: Implement Skip Logic in `pipeline/shared.ts`

- Open `packages/core/src/pipeline/shared.ts` (where `initializePipeline()` — Steps 1–4 — lands after B1A)
- In the context loading loop of `initializePipeline()`, modify the catch block:

  ```typescript
  try {
    const messages = await provider.provide(contextProviderInput);
    // ... existing success handling ...
  } catch (error: unknown) {
    // Emit context.failed for every failure (visibility)
    eventBus.emit({
      type: 'context.failed',
      runId,
      providerId: provider.id,
      error: /* serialize error to EventErrorPayload */,
    });

    // Check skip mode
    if (config.contextPolicy.onProviderFailure === 'skip') {
      eventBus.emit({
        type: 'context.skipped',
        runId,
        providerId: provider.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      skippedCount++;
      continue; // Skip this provider, continue with next
    }

    // Existing fail-fast logic
    if (isRetryable(error)) {
      stateMachine.transition('RETRYING');
      // ... existing retry logic ...
    } else {
      stateMachine.transition('FAILED');
      // ... existing failure logic ...
    }
  }
  ```

- After the loop, add a check:
  ```typescript
  if (skippedCount === config.contextProviders.length && providerResults.length === 0) {
    const err = new ContextLoadError('All context providers were skipped');
    stateMachine.transition('FAILED');
    eventBus.emit({ type: 'run.failed', runId, error: /* serialize */ });
    logger.error('Run failed — all context providers skipped', { runId });
    throw err;
  }
  ```
- Ensure `skippedCount` is initialized as a local variable (`let skippedCount = 0`) before the loop.

### Phase 2 — Step 4: Add `contextTimeoutMs` to `TimeoutPolicy`

- Open `packages/core/src/interfaces.ts`
- Add to `TimeoutPolicy`:
  ```typescript
  /** Per ContextProvider.provide() timeout in ms. Default: undefined (no per-provider timeout) */
  contextTimeoutMs?: number;
  ```
- No changes to `mergeTimeoutPolicy()` needed — it already does a shallow spread.
- No changes to `DEFAULT_TIMEOUT` needed — `contextTimeoutMs` is optional.

### Phase 2 — Step 5: Add `signal` to `ContextProviderInput`

- Open `packages/core/src/interfaces.ts`
- Change `ContextProviderInput` type:
  ```typescript
  export type ContextProviderInput = Omit<RunInput, 'stream' | 'profile'> & {
    signal?: AbortSignal;
  };
  ```
- This is backward-compatible: existing `ContextProvider` implementations never read the `signal` field and will continue to work.
- Note: The `signal` here is the user-provided `RunInput.signal` for run-level cancellation. It is NOT the timeout signal — timeouts are handled by `withTimeout()`.

### Phase 2 — Step 6: Wrap `provider.provide()` with Timeout

- Open `packages/core/src/pipeline/shared.ts`
- Import `withTimeout` from `../policies.js` (already exported).
- In the context loading loop of `initializePipeline()`, wrap the `provide()` call:

  ```typescript
  const providePromise = provider.provide({
    ...contextProviderInput,
    signal: input.signal, // Forward user cancellation signal
  });

  const messages =
    config.timeout.contextTimeoutMs !== undefined
      ? await withTimeout(providePromise, config.timeout.contextTimeoutMs!)
      : await providePromise;
  ```

- When `contextTimeoutMs` fires, `withTimeout` throws `TimeoutExceededError` which is `isRetryable() === true`. The catch block (B6-modified) handles it according to `onProviderFailure`.

### Step 7: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
- All existing tests must pass without modification (both phases are additive/opt-in).

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

- **B6 — Skip mode:**
  - With `contextPolicy: { onProviderFailure: 'skip' }` and one failing provider, context loading proceeds with remaining providers.
  - `context.failed` event is emitted for the failing provider.
  - `context.skipped` event is emitted for the skipped provider.
  - With ALL providers failing and `onProviderFailure: 'skip'`, pipeline transitions to `FAILED`.
  - With `onProviderFailure: 'fail'` (default), behavior is unchanged — first failure aborts all loading.

- **B7 — Context timeout:**
  - With `timeout: { contextTimeoutMs: 50 }` and a provider that takes 100ms, the provider is timed out.
  - Timeout is treated as `ContextLoadError` (retryable) — follows retry/skip logic.
  - Without `contextTimeoutMs` (undefined), no timeout wrapping occurs.
  - `totalTimeoutMs` is still enforced independently at the top level.

- **Backward compatibility:**
  - An orchestrator config without `contextPolicy` gets defaults (`onProviderFailure: 'fail'`, no `contextTimeoutMs`).
  - All existing tests pass without modification.

---

## 8. Risk Assessment

| Risk                                             | Likelihood | Impact | Mitigation                                                                               |
| ------------------------------------------------ | ---------- | ------ | ---------------------------------------------------------------------------------------- |
| B6 changes core execution path (context loading) | Medium     | High   | Skip mode is opt-in; default behavior unchanged. All existing tests pass without change. |
| B7 adds signal to ContextProviderInput           | Low        | Medium | Field is optional; existing providers ignore it.                                         |
| `contextTimeoutMs` interacts with totalTimeoutMs | Low        | Medium | They are independent — totalTimeoutMs is a separate Promise.race at pipeline top level.  |
| Merge of `contextTimeoutMs` missed in profile.ts | Low        | Low    | Profile merge for timeout uses spread — new field propagates automatically.              |
| `context.skipped` event not emitted correctly    | Low        | Low    | Verify in unit test by subscribing to Orchestrator events.                               |

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — Frozen contracts (additive optional fields only)
- `.opencode/skill/interfaces/SKILL.md` — `TimeoutPolicy`, `OrchestratorEvent` definitions
- `.opencode/skill/architecture/SKILL.md` — Steps 2–3 (context loading), ContextProvider Partial Failure section, Timeout Enforcement section
- `DECISION-LOG.md` — ADR-015 (fail-fast context loading, deferred best-effort)
- `.opencode/skill/security/SKILL.md` — §S-5 (context provider output limits trust boundary)
- `packages/core/src/interfaces.ts` — Target for `ContextPolicy`, `TimeoutPolicy`, `ContextProviderInput`, `OrchestratorEvent`
- `packages/core/src/policies.ts` — Target for `DEFAULT_CONTEXT_POLICY` update; `withTimeout` already exported
- `packages/core/src/pipeline/shared.ts` — Context loading loop in `initializePipeline()` (formerly `pipeline.ts` lines ~369–410)
- `.opencode/milestones/v1/v1.0.2/P04-A5-context-policy-config.md` — A5 plan establishing `ContextPolicy` base
