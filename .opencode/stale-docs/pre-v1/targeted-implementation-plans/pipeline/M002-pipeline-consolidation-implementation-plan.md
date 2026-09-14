# M002 — Pipeline Consolidation Implementation Plan

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline architecture analysis

---

## 1. Task Summary

Implement **Option 1 (Minimal Consolidation)** of the pipeline architecture analysis:

1. **Extract Steps 1–4** (INITIALIZED → CONTEXT_INJECTED → PROMPT_COMPOSED) into an `initializePipeline()` helper
2. **Extract Steps 9–10** (COMPLETING → COMPLETED) into a `finalizePipeline()` helper
3. **Extract tool execution** (Step 6) into an `executeToolRound()` helper
4. **Fix 3 identified bugs** (B-MED-01, B-LOW-02, B-LOW-03)
5. **Verify no behavioral regression** via existing tests — all tests must pass without modification

---

## 2. Context (Why This Exists)

The current `packages/core/src/pipeline.ts` contains two pipeline functions:

- `executePipeline()` (line 66–564) — non-streaming path
- `executeStreamingPipeline()` (line 575–1048) — streaming path

These two functions share **Steps 1–4** (~120 lines of near-identical code), **Steps 9–10** (~80 lines of near-identical code), and **tool execution logic** (~50 lines of similar code). The shared code is copy-pasted with subtle variations — approximately **250 lines of duplication** out of ~970 total lines of execution logic.

**Option 1** (chosen) has the highest value-to-risk ratio:
- Eliminates ~200 lines of duplication
- Bundles fixes for 3 latent bugs
- ~10% of the risk of a full Option 2/3 refactor
- Pure restructuring — no behavioral changes except the bug fixes
- All existing tests must pass without modification

---

## 3. All Marked Issues (Bug Reports)

### Issue B-MED-01: Missing `afterGenerate` error handling in streaming

| Field       | Value                                                         |
|-------------|---------------------------------------------------------------|
| File        | `packages/core/src/pipeline.ts`                               |
| Lines       | 867 (streaming), reference: 376–391 (non-streaming)           |
| Severity    | MEDIUM                                                        |
| Description | Streaming path calls `runHooks(hooks.afterGenerate, ...)` on line 867 **without** try/catch wrapping. The non-streaming path (lines 376–391) wraps it in a try/catch that rethrows errors properly. If streaming's `afterGenerate` throws, the error propagates as an unhandled rejection from the async generator, NOT as a controlled `yield { type: 'error' }` chunk. This breaks the `StreamChunk` error contract — consumers get a `throw` from `for await...of` instead of a typed error chunk. |
| Fix         | Wrap the streaming `afterGenerate` call (line 867 area) in a try/catch that matches the non-streaming pattern. On error, yield `{ type: 'error', error }` and return. |

**Reference — non-streaming pattern (lines 376–391):**
```typescript
try {
  await runHooks(hooks.afterGenerate, { messages, response, input, runId });
} catch (hookError: unknown) {
  if (hookError instanceof Error) {
    throw hookError;
  }
  const err = new Error(String(hookError));
  if (hookError !== null && typeof hookError === 'object') {
    Object.defineProperty(err, 'cause', { value: hookError, enumerable: false });
  }
  throw err;
}
```

**Required streaming fix pattern:**
```typescript
try {
  await runHooks(hooks.afterGenerate, { messages, response, input, runId });
} catch (hookError: unknown) {
  const err = hookError instanceof OrchestratorErrorClass
    ? hookError
    : new Error(String(hookError)); // wrap non-OrchestratorError
  yield { type: 'error', error: err as OrchestratorErrorClass };
  // Transition to FAILED, emit run.failed, log, and return
  try { stateMachine.transition('FAILED'); } catch { /* already terminal */ }
  eventBus.emit({ type: 'run.failed', runId, error: err as OrchestratorErrorClass });
  logger.error('Run failed', { runId, error: (err as OrchestratorErrorClass).message, code: (err as OrchestratorErrorClass).code });
  return;
}
```

---

### Issue B-LOW-02: Missing tool execution error recovery in streaming

| Field       | Value                                                         |
|-------------|---------------------------------------------------------------|
| File        | `packages/core/src/pipeline.ts`                               |
| Lines       | 919 (streaming), reference: 461–486 (non-streaming)           |
| Severity    | LOW                                                           |
| Description | Non-streaming path (lines 461–486) catches `ToolExecutionError`, emits `tool.failed`, sleeps via `trackDuration`, and continues the loop for retry. Streaming path (line 919) has **NO try/catch** around `toolController.executeRound()` — any execution error propagates to the outer catch (line 1025) which yields an `error` chunk and terminates. The streaming path cannot recover from a transient tool failure, while the non-streaming path can. |
| Fix         | Add equivalent try/catch in streaming tool execution that catches `ToolExecutionError`, emits `tool.failed` event, adds the tool result with error, and continues the tool loop. |

**Reference — non-streaming pattern (lines 461–486):**
```typescript
} catch (error: unknown) {
  const err =
    error instanceof OrchestratorErrorClass
      ? error
      : new ToolExecutionError('unknown', error);

  // ToolValidationError, ToolNotFoundError -> FAILED (fail-fast)
  if (err instanceof ToolValidationError || err instanceof ToolNotFoundError) {
    throw err;
  }

  // ToolExecutionError -> emit failed event and retry
  const toolCallName = err instanceof ToolExecutionError ? err.toolName : 'unknown';

  eventBus.emit({
    type: 'tool.failed',
    runId,
    toolName: toolCallName,
    error: toEventErrorPayload(err),
  });

  // Retry
  const delayMs = calculateDelay(attempt, config.retry, err);
  await sleep(delayMs);
  continue;
}
```

**Philosophical note:** The non-streaming behavior is to retry transient tool failures. The streaming behavior currently hard-fails. The SPSA considers the non-streaming behavior correct — falling back differently destroys the consistency guarantee between the two pipeline paths.

---

### Issue B-LOW-03: `activeProvider` vs `config.provider` split

| Field       | Value                                                         |
|-------------|---------------------------------------------------------------|
| File        | `packages/core/src/pipeline.ts`                               |
| Lines       | 673 (streaming), 218 (non-streaming), 696 (streaming decl)    |
| Severity    | LOW                                                           |
| Description | Non-streaming tracks `activeProvider` as a mutable variable (line 134, may swap to fallback at line 323). The PROMPT_COMPOSED memory budget calculation (line 218) uses `activeProvider.capabilities.maxContextTokens`. Streaming declares `const activeProvider = config.provider;` on line 696, but the memory budget calculation on line 673 uses `config.provider.capabilities.maxContextTokens` — an inconsistency. They are functionally equivalent at this point (no fallback swap yet) but the inconsistency is a maintenance hazard. |
| Fix         | After consolidation, ensure both paths reference the same variable. Both should reference `activeProvider` (or the extracted shared context object), even before any fallback swap, so that future edits to one path automatically apply to both. |

---

## 4. Architectural Directives

### 4.1 Extracted Helper Signatures (Design Constraints)

These signatures are prescriptive — SPBED MUST implement these exact extraction boundaries.

**Helper 1: `initializePipeline()` — Steps 1–4**
```typescript
/**
 * Execute Steps 1–4 of the pipeline: INITIALIZED, beforeRun hooks,
 * CONTEXT_INJECTING (context providers), CONTEXT_INJECTED (memory load),
 * and PROMPT_COMPOSED (PromptComposer.compose).
 *
 * Returns all shared state needed by both streaming and non-streaming paths.
 * All state is returned — never stored on module-level or instance-level scope.
 */
async function initializePipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
): Promise<{
  runId: string;
  startTime: number;
  trackDuration: () => number;
  stateMachine: LifecycleStateMachine;
  hooks: ReturnType<typeof normalizeHookRegistry>;
  activeProfile: string;
  activeProvider: AIProvider;
  messages: Message[];
  tempMessages: [Message, Message];
  contextMessages: SystemMessage[];
  context: RunContext;
}>;
```

**Helper 2: `executeToolRound()` — Step 6 (Tool execution loop helper)**
```typescript
/**
 * Execute a single tool round: run beforeTool hooks, execute tools via
 * ToolController, append tool results to messages, run afterTool hooks,
 * emit tool events.
 *
 * Returns updated messages and tool results for the caller to accumulate.
 * Mutates messages array in-place (appending tool result messages).
 * NOT responsible for roundCounter increment or maxToolRounds check — that
 * remains in the caller.
 */
async function executeToolRound(
  roundNumber: number,
  toolCalls: ToolCall[],
  config: ResolvedConfig,
  hooks: ReturnType<typeof normalizeHookRegistry>,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  trackDuration: () => number,
  attempt: number,
  messages: Message[],
  allToolResults: ToolResult[],
  isStreaming: boolean,
): Promise<{
  messages: Message[];
  allToolResults: ToolResult[];
}>;
```

**Helper 3: `finalizePipeline()` — Steps 9–10**
```typescript
/**
 * Execute Steps 9–10: COMPLETING (memory save, afterRun hooks, build output),
 * COMPLETED (emit run.completed event, log).
 *
 * For streaming: yields the 'done' chunk and return (not a Promise return).
 * For non-streaming: returns the RunOutput.
 *
 * The isStreaming flag controls whether to yield 'done' or return RunOutput.
 */
async function finalizePipeline(
  stateMachine: LifecycleStateMachine,
  hooks: ReturnType<typeof normalizeHookRegistry>,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  startTime: number,
  messages: Message[],
  tempMessages: [Message, Message],
  response: PromptResponse,
  input: RunInput,
  allToolResults: ToolResult[],
  activeProfile: string,
  isStreaming: boolean,
): Promise<RunOutput | void>;
```

### 4.2 Naming and Code Style

- Follow existing codebase conventions in `.opencode/rules/typescript-style.md`
- Extracted helpers are **file-private** (NOT exported) — they are implementation details of `pipeline.ts`
- Use explicit typing — no `any`, no implicit `unknown` that should be typed
- All state is passed explicitly as parameters — no module-level state (Principle 4: Stateless Core)
- Use `camelCase` for function names, `PascalCase` for types
- Respect function body max length: **40 lines**. If a helper exceeds 40 lines, extract further.
- Respect max parameters: **3** — use an options object if more are needed. **Exception:** The extracted helpers have more parameters by necessity (they consolidate shared state). This is architecturally approved.

### 4.3 What NOT to Do

- **Do NOT** create new files — all extracted helpers live in `pipeline.ts`
- **Do NOT** modify the public exports of `pipeline.ts` or any interface file
- **Do NOT** introduce new runtime dependencies
- **Do NOT** change the behavior of `executePipeline` or `executeStreamingPipeline` except for the bug fixes
- **Do NOT** attempt Option 2 or Option 3 patterns (full EventSourcedPipeline refactor)
- **Do NOT** touch `packages/core/src/interfaces.ts` — frozen contract
- **Do NOT** touch `packages/core/src/types.ts` — frozen contract
- **Do NOT** add comments unless the patterns in the codebase already use them
- **Do NOT** create `.md` documentation files unless explicitly requested
- **Do NOT** refactor `resolveProfiles()` or `handleOrchestratorError()` — they are already shared

---

## 5. Files to Modify

| File                                     | Action                | Notes                                                     |
|------------------------------------------|-----------------------|-----------------------------------------------------------|
| `packages/core/src/pipeline.ts`          | REFACTOR + BUGFIX     | Extract helpers, fix B-MED-01, B-LOW-02, B-LOW-03         |
| `packages/core/src/pipeline.ts`          | No export changes     | Helpers are file-private, no change to public API          |

**No other files should be modified.** The public API surface is unchanged.

---

## 6. Implementation Strategy

### Step 1: Extract `initializePipeline()`
- Consolidate all code from Steps 1–4 that is identical between both paths
- This includes: runId generation, stateMachine creation, startTime, activeProfile, run.started event, resolveProfiles, hooks normalization, trackDuration, context provider loading, memory loading, PromptComposer.compose
- **Bug B-LOW-03 fix:** Use a `let activeProvider = config.provider` variable for both paths (matching the non-streaming pattern) and reference it in memory budget calculation

### Step 2: Extract `executeToolRound()`
- Consolidate tool execution logic shared between both paths
- Before tool hooks, ToolController.executeRound, tool result message appending, after tool hooks, event emission
- **Bug B-LOW-02 fix:** Add try/catch around `toolController.executeRound()` in the streaming path matching the non-streaming pattern

### Step 3: Extract `finalizePipeline()`
- Consolidate Steps 9-10: memory save, output building, afterRun hooks, COMPLETED state transition, run.completed event
- Handle the streaming vs non-streaming difference (yield 'done' vs return RunOutput)

### Step 4: Fix B-MED-01
- Add try/catch around the streaming `afterGenerate` hook call

### Step 5: Verify
- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
- All tests must pass without modification

---

## 7. Verification Requirements

After implementation, the SPBED MUST run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

**All existing tests MUST pass without modification.** The refactor is a pure restructuring — no behavioral change except the three bug fixes.

### If a Test Fails:

1. **Determine root cause:** Is the failure caused by a bug in the refactored code or a pre-existing test sensitivity (e.g., mocking internal functions)?
2. **If refactored code introduced the failure:** Fix the code, not the test.
3. **If the test was sensitive to internal structure** (e.g., mocking `_execute` which no longer exists): Update the test to work with the new structure, but **do NOT change test assertions about behavior**. The refactor must produce identical behavioral output.
4. **If uncertain:** Return to SPSA for guidance (do not guess).

---

## 8. Approval Gating

- **This handoff is `REVISION_REQUIRED.ARCHITECTURE`** — SPBED implements, then returns to SPSA for review
- **HARD STOP — return to SPSA** if:
  - Any change requires modifying frozen contracts (`rules/interfaces-core.md`, `rules/interfaces-runtime.md`)
  - Any change requires new runtime dependencies
  - Any v1 scope limit is violated (see `rules/constraints.md`)
- **Document deviations:** If SPBED identifies a better extraction boundary than the proposed signatures, implement it but document the deviation clearly in the return handoff

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bug fix changes streaming error contract | Low | Medium | Fix matches non-streaming pattern exactly; all existing tests verify behavior |
| Helper extraction accidentally changes behavior | Low | High | All existing tests must pass without modification — this is the safety net |
| Function body exceeds 40-line limit | Medium | Low | Extract further sub-helpers if needed |
| Test mocking breaks due to internal restructuring | Low | Medium | Update test structure, preserve behavioral assertions |
| Circular dependency introduced | Very Low | High | Extraction stays within `pipeline.ts` — no new import relationships |

---

## 10. References

- `.opencode/rules/architecture.md` — Execution Flow steps 1–10
- `.opencode/rules/interfaces-core.md` — Frozen contracts (AIProvider, StreamChunk, etc.)
- `.opencode/rules/interfaces-runtime.md` — Frozen contracts (RunInput, RunOutput, HookRegistry)
- `.opencode/rules/constraints.md` — v1 scope limits, forbidden patterns
- `.opencode/rules/implementation-standards.md` — Defensive programming, function size limits
- `.opencode/rules/typescript-style.md` — Naming, typing, async conventions
- `.opencode/workflows/error-handling.md` — Error throwing/catching patterns
