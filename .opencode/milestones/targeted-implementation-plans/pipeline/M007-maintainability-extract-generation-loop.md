# M007 — Maintainability: Extract Generation Loop and Promote `_execute`

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline enterprise analysis — Maintainability (Strong)

---

## 1. Task Summary

Extract what M002 does NOT cover: the inner generation loop (Steps 5–8 wrapping GENERATING → TOOL_EXECUTING → GENERATING loop), promote the nested `_execute` function to a module-level top-level function, and consolidate the duplicated tool definitions array onto `ResolvedConfig` (delegated to M006 — this plan references it as a prerequisite).

### What M002 Already Covers

M002 extracts:

- `initializePipeline()` — Steps 1–4 (INITIALIZED → CONTEXT_INJECTING → CONTEXT_INJECTED → PROMPT_COMPOSED)
- `executeToolRound()` — Step 6 (TOOL_EXECUTING body)
- `finalizePipeline()` — Steps 9–10 (COMPLETING → COMPLETED)

**M007 does NOT duplicate any of these extractions.** M007 operates on the code SURROUNDING the M002 extraction boundaries.

### What M007 Covers

1. **Extract the generation loop body** — the `while (true)` block inside `_execute()` that wraps Steps 5–8 (GENERATING → TOOL_EXECUTING loop). This is the code AFTER `initializePipeline()` returns and BEFORE `finalizePipeline()` is called.
2. **Promote `_execute` to a top-level function** — break the closure by extracting `_execute` into a named module-level function `executeGenerationPipeline()`, passing all captured state as explicit parameters.
3. **Reference M006** — the duplicated tool definitions `Array.from(config.tools.values()).map(...)` pre-computation is covered by M006. This plan lists it as a prerequisite.

---

## 2. Context (Why This Exists)

### The Nesting Problem

The non-streaming path has three levels of nested control flow:

```
executePipeline()                          // Level 1
  ├── _execute()                           // Level 2 (nested function)
  │     ├── while(true)                    // Level 3 (retry/outer loop)
  │     │     ├── try                      // Level 3
  │     │     │     ├── while(true)        // Level 4 (generation loop)
  │     │     │     │     ├── try/catch    // Level 5 (provider retry)
  │     │     │     │     ├── try/catch    // Level 5 (tool execution)
```

After M002 extraction, this becomes:

```
executePipeline()                          // Level 1
  ├── _execute()                           // Level 2 (nested function)
  │     ├── while(true)                    // Level 3 (retry/outer loop)
  │     │     ├── try                      // Level 3
  │     │     │     ├── initializePipeline()  // Extracted by M002
  │     │     │     ├── while(true)        // Level 4 (generation loop)
  │     │     │     │     ├── GENERATING block  (~50 lines still inline)
  │     │     │     │     ├── executeToolRound() // Extracted by M002
  │     │     │     ├── finalizePipeline()  // Extracted by M002
```

The `_execute` function remains a closure nested inside `executePipeline()`, capturing `input`, `config`, `eventBus`, and `logger`. This creates:

- A long function body (even after M002, \_execute is ~200+ lines)
- Inability to unit-test the generation loop independently
- Violation of the 40-line function body limit (each while loop iteration body is still ~80+ lines)
- Violation of the 3-level nesting cap (the inner while loop is at level 4)

### The Generation Loop Boundary

The generation loop (the inner `while(true)` at level 4) handles:

- State machine transition to GENERATING
- `beforeGenerate` hooks
- `generate.started` event emission
- `PromptRequest` construction (with tool definitions — now pre-computed by M006)
- Provider generation call with retry loop and fallback
- `finishReason` evaluation (`'stop' | 'tool_calls' | 'length'`)
- Assistant message construction and storage in `tempMessages`
- Router to tool execution or break
- Tool execution via `executeToolRound()` (extracted by M002) with error handling and retry

This is conceptually an `executeGenerationRound()` function: "Given the current messages and state, produce the next response and decide whether to continue looping." It encapsulates Steps 5–8.

---

## 3. Issues/Changes

### Issue 1: Nested `_execute` Closure

| Field       | Value                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                                                                                                      |
| Lines       | 414–677 (before M002), closure adds unnecessary complexity                                                                                                                                           |
| Severity    | MEDIUM                                                                                                                                                                                               |
| Description | `_execute()` is a nested function inside `executePipeline()`, creating a closure over `input`, `config`, `eventBus`, `logger`. This prevents independent testing and contributes to function length. |
| Fix         | Promote to top-level `executeGenerationPipeline()` with explicit parameters.                                                                                                                         |

### Issue 2: Generation Loop Body Exceeds Size Limits

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                                                   |
| Lines       | ~80 lines per generation iteration (even after M002 extraction)                                                                                   |
| Severity    | MEDIUM                                                                                                                                            |
| Description | The `while(true)` generation loop body violates the 40-line function body limit and 3-level nesting cap from `rules/implementation-standards.md`. |
| Fix         | Extract the generation round body into `executeGenerationRound()`.                                                                                |

### Issue 3: Streaming Path Duplication

| Field       | Value                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                                                                                                                              |
| Lines       | 722–1005 (streaming generation loop)                                                                                                                                                                                         |
| Severity    | MEDIUM                                                                                                                                                                                                                       |
| Description | The streaming path has an equivalent generation loop with duplicate pattern but different implementation (yield-based). The `_execute` extraction and round extraction apply a similar pattern within streaming constraints. |
| Fix         | Extract the streaming generation round body into `executeStreamingGenerationRound()`.                                                                                                                                        |

---

## 4. Architectural Directives

### 4.1 Promote `_execute` to Top-Level `executeNonStreamingPipeline()\*\*

**Before (current) — closure inside executePipeline():**

```typescript
export async function executePipeline(input, config, eventBus, logger) {
  if (input.stream === true) {
    return executeStreamingPipeline(input, config, eventBus, logger);
  }

  try {
    return await Promise.race([_execute(), rejectAfter(config.timeout.totalTimeoutMs)]);
  } catch (error) { ... }

  async function _execute(): Promise<RunOutput> {
    let runId = '';
    let stateMachine = new LifecycleStateMachine();
    let activeProvider = config.provider;
    let roundCounter = 0;
    let attempt = 0;  // Will be split by M003

    while (true) {
      try {
        const init = await initializePipeline(input, config, eventBus, logger);
        // ... generation loop ...
      } catch (error) { ... }
    }
  }
}
```

**After — top-level function:**

```typescript
export async function executePipeline(input, config, eventBus, logger) {
  if (input.stream === true) {
    return executeStreamingPipeline(input, config, eventBus, logger);
  }

  try {
    return await Promise.race([
      executeNonStreamingPipeline(input, config, eventBus, logger),
      rejectAfter(config.timeout.totalTimeoutMs),
    ]);
  } catch (error) { ... }
}

/**
 * Execute the non-streaming pipeline (Steps 1–10).
 * Top-level function — no closure over executePipeline scope.
 * All state is received via parameters and stored in local variables.
 *
 * File-private — NOT exported.
 */
async function executeNonStreamingPipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
): Promise<RunOutput> {
  let runId = '';
  let stateMachine = new LifecycleStateMachine();
  let activeProvider = config.provider;
  let roundCounter = 0;
  let providerAttempt = 0;  // M003 split
  let toolAttempt = 0;      // M003 split

  while (true) {
    try {
      const init = await initializePipeline(input, config, eventBus, logger);
      // ... generation loop (see §4.2) ...
    } catch (error) { ... }
  }
}
```

**Parameters passed explicitly.** No closure over `executePipeline()`'s parameters — they are passed directly.

### 4.2 Extract Generation Round Body for Non-Streaming

Extract the body of the inner `while(true)` generation loop into `executeGenerationRound()`:

```typescript
/**
 * Execute one round of the generation loop (Steps 5–8).
 *
 * After initialization (Steps 1–4) and before finalization (Steps 9–10),
 * this function handles one complete pass through:
 * 1. State machine → GENERATING
 * 2. beforeGenerate hooks
 * 3. Provider generation with retry and fallback
 * 4. finishReason evaluation
 * 5. Assistant message construction
 * 6. Tool execution routing (calls executeToolRound if needed)
 *
 * Returns a result indicating whether to continue the generation loop
 * (more tool calls) or break (stop/length finish reason).
 *
 * Mutates messages and tempMessages in-place.
 *
 * @returns A GenerationRoundResult indicating the next action.
 *
 * File-private — NOT exported.
 */
type GenerationRoundResult =
  | { action: 'continue' }       // More tool calls — loop back to GENERATING
  | { action: 'break'; response: PromptResponse };  // Stop/length — exit loop

async function executeGenerationRound(
  roundCounter: number,
  activeProvider: AIProvider,
  config: ResolvedConfig,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  stateMachine: LifecycleStateMachine,
  trackDuration: () => number,
  messages: Message[],
  tempMessages: [Message, Message],
  allToolResults: ToolResult[],
  input: RunInput,
): Promise<GenerationRoundResult> {
  ...
}
```

**Inside the function:**

1. `stateMachine.transition('GENERATING')` — logged
2. `await runHooks(hooks.beforeGenerate, { messages, input, runId })`
3. `eventBus.emit({ type: 'generate.started', runId, messageCount: messages.length })`
4. Build `PromptRequest`:
   ```typescript
   const promptRequest: PromptRequest = {
     messages,
     ...(config.toolDefinitions ? { tools: config.toolDefinitions } : {}),
     ...(config.timeout.generateTimeoutMs > 0
       ? { signal: AbortSignal.timeout(config.timeout.generateTimeoutMs) }
       : null),
   };
   ```
5. Try `executeWithRetry(() => activeProvider.generate(promptRequest), config.retry, onRetry)`:
   - `onRetry` updates `attempt`, transitions to RETRYING, emits `retry.attempted`
   - On `MaxRetriesExceededError` + `config.fallbackProvider` exists: fallback logic
   - On non-retryable error: rethrow
   - On retryable without fallback: sleep, return `{ action: 'continue' }` (loop retries internally via RETRYING state machine — but the outer caller's while loop is for tool retries, not provider retries)
6. Emit `generate.completed`
7. Construct `tempMessages[1]`
8. If `finishReason === 'tool_calls'`:
   - Increment roundCounter
   - Check `roundCounter >= config.toolPolicy.maxToolRounds` → throw `MaxToolRoundsExceededError`
   - `stateMachine.transition('TOOL_EXECUTING')`
   - Try `await executeToolRound(...)`:
     - On `ToolValidationError` / `ToolNotFoundError`: rethrow (fail-fast)
     - On `ToolExecutionError`: emit `tool.failed`, sleep, return `{ action: 'continue' }`
   - Return `{ action: 'continue' }`
9. Else (stop/length): Return `{ action: 'break', response }`

**The outer while loop in the caller becomes:**

```typescript
while (true) {
  try {
    const init = await initializePipeline(...);  // M002
    activeProvider = init.activeProvider;
    runId = init.runId;
    stateMachine = init.stateMachine;
    const { startTime, trackDuration, hooks, activeProfile, tempMessages } = init;
    const messages = init.messages;
    const allToolResults: ToolResult[] = [];
    let response: PromptResponse;

    while (true) {
      const result = await executeGenerationRound(
        roundCounter, activeProvider, config, hooks, eventBus, logger,
        runId, stateMachine, trackDuration, messages, tempMessages, allToolResults, input,
      );
      if (result.action === 'break') {
        response = result.response;
        break;
      }
      // continue loops back to GENERATING
    }

    // AfterGenerate hooks
    try {
      await runHooks(hooks.afterGenerate, { messages, response, input, runId });
    } catch (hookError) {
      throw handleOrchestratorError(hookError, config);
    }

    return await finalizePipeline(...);  // M002
  } catch (error) {
    // FAILED handling — unchanged
  }
}
```

**40-line limit:** The `executeGenerationRound` function body will be ~60 lines due to the fallback handling and tool retry/error handling branches. **Extract sub-helpers if needed:**

- `buildPromptRequest(config, messages): PromptRequest` — 15 lines
- `executeWithFallback(activeProvider, promptRequest, config, ...)` — 30 lines

### 4.3 Streaming Path: `executeStreamingGenerationRound()`

The streaming path has the same loop structure but uses `yield` internally. Extract a similar function:

```typescript
type StreamingGenerationRoundResult =
  | { action: 'continue'; chunksToYield: StreamChunk[] }
  | { action: 'break'; response: PromptResponse; finalChunks: StreamChunk[] }
  | { action: 'error'; error: OrchestratorError };

async function executeStreamingGenerationRound(
  roundCounter: number,
  activeProvider: AIProvider,
  config: ResolvedConfig,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  stateMachine: LifecycleStateMachine,
  trackDuration: () => number,
  messages: Message[],
  tempMessages: [Message, Message],
  allToolResults: ToolResult[],
  input: RunInput,
  accumulatedUsage: TokenUsage,
  accumulatedText: string,
  pendingToolCalls: ToolCall[],
): Promise<{
  result: StreamingGenerationRoundResult;
  accumulatedUsage: TokenUsage;
  accumulatedText: string;
  pendingToolCalls: ToolCall[];
}>;
```

This function encapsulates the streaming generation round including:

1. Stream setup (generateStream with retry loop — lines 755–811)
2. Stream consumption with timeout (lines 813–863)
3. Stream error handling (lines 867–885)
4. PromptResponse construction from chunks (lines 889–909)
5. Tool execution routing (lines 912–1001)

The caller (the outer while loop in `executeStreamingPipeline`) checks the result and yields chunks or breaks.

### 4.4 Prerequisites

This plan depends on:

- **M002** — `initializePipeline()`, `executeToolRound()`, `finalizePipeline()` must be extracted first
- **M003** — the `attempt` counter split must be applied (the generation round function needs separate `providerAttempt` and `toolAttempt` counters)
- **M006** — tool definitions pre-computation on `ResolvedConfig` must be applied (`config.toolDefinitions` replaces `Array.from(config.tools.values()).map(...)`)

### 4.5 What NOT to Do

- Do NOT re-extract what M002 already covers — `executeGenerationRound` calls `executeToolRound()` (extracted by M002), it does not duplicate it
- Do NOT attempt to share a single generation round function between streaming and non-streaming — the yield-based nature of streaming requires a separate extraction
- Do NOT extract PromptRequest building into a separate file — a file-private helper in pipeline.ts is sufficient
- Do NOT remove the outer retry while(true) loop — it is needed for the scenario where `initializePipeline()` throws and the run retries from scratch (this is the outer retry/loop that wraps everything)
- Do NOT change the public exports of pipeline.ts — all extracted functions remain file-private
- Do NOT add new runtime dependencies

---

## 5. Files to Modify

| File                                        | Action            | Notes                                                                                                      |
| ------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline.ts`             | REFACTOR          | Promote `_execute` to top-level; extract `executeGenerationRound` and `executeStreamingGenerationRound`    |
| `packages/core/tests/unit/pipeline.test.ts` | CREATE (optional) | Optional: unit tests for generation round functions (only if extraction makes them independently testable) |

**Note:** No changes to interfaces.ts, types.ts, errors.ts, or any frozen contract file. All extracted functions are file-private and use existing types.

---

## 6. Implementation Strategy

### Prerequisite: Ensure M002, M003, M006 Are Applied

Before starting M007, verify that:

- `initializePipeline()`, `executeToolRound()`, `finalizePipeline()` exist as extracted functions (M002)
- `attempt` counter is split into `providerAttempt` and `toolAttempt` (M003)
- `config.toolDefinitions` is available on `ResolvedConfig` (M006)

### Step 1: Promote `_execute` to `executeNonStreamingPipeline()`

1. Rename the nested `_execute` function to `executeNonStreamingPipeline`
2. Move it outside `executePipeline()` — place it between `executePipeline` and `executeStreamingPipeline`
3. Add `input`, `config`, `eventBus`, `logger` as explicit parameters (they are already captured by closure, so this is a mechanical change)
4. Update the call site in `executePipeline()`: `return _execute()` → `return executeNonStreamingPipeline(input, config, eventBus, logger)`
5. Remove `async function _execute()` and hoist its body into the new top-level function

### Step 2: Extract `executeGenerationRound()`

1. Define the `GenerationRoundResult` type at module level
2. Extract the inner while(true) loop body (currently lines 439–627) into `executeGenerationRound()`
3. The function takes all state it needs as parameters (listed in §4.2)
4. The function returns `GenerationRoundResult`
5. The outer while(true) loop in `executeNonStreamingPipeline` calls `executeGenerationRound()` in a loop
6. After the inner loop breaks, the afterGenerate hooks and finalizePipeline call remain in the outer try block

### Step 3: Extract `executeStreamingGenerationRound()`

1. Define the `StreamingGenerationRoundResult` type at module level
2. Extract the streaming generation round body (lines 722–1005) into `executeStreamingGenerationRound()`
3. The non-yield portions of streaming (state machine transitions, event emission, PromptRequest building, result routing) are extracted as a regular async function
4. The yield chunks are collected into arrays and returned in the result
5. The caller in `executeStreamingPipeline` yields the collected chunks after each round

**Important streaming constraint:** The streaming generation round function CANNOT `yield` directly (because it's not a generator). Instead, it collects chunks into arrays and returns them. The caller (which IS a generator) yields them after the function returns.

### Step 4: Extract `buildPromptRequest()` (Sub-Helper)

```typescript
function buildPromptRequest(messages: Message[], config: ResolvedConfig): PromptRequest {
  return {
    messages,
    ...(config.toolDefinitions ? { tools: config.toolDefinitions } : {}),
    ...(config.timeout.generateTimeoutMs > 0
      ? { signal: AbortSignal.timeout(config.timeout.generateTimeoutMs) }
      : null),
  };
}
```

This is a 15-line helper used by both generation round functions. Keeps the round functions under 40 lines each where possible.

### Step 5: Clean Up and Verify

- Remove any now-unused variables from the outer scopes (e.g., `let providerAttempt` that was hoisted for the callback can now be local to `executeGenerationRound`)
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:coverage`

---

## 7. Verification Requirements

After implementation, the SPBED MUST run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

### Specific assertions to verify:

1. No function body in `pipeline.ts` exceeds 40 lines (extract further sub-helpers if needed)
2. No nesting exceeds 3 levels
3. `executeNonStreamingPipeline` is a top-level function — not nested inside `executePipeline`
4. `executeGenerationRound` handles one complete generate→tool round and returns a `GenerationRoundResult`
5. All tool-calling scenarios still work through the extracted round function
6. Fallback still works when primary provider is exhausted
7. Streaming still yields correct chunks in correct order
8. No closure captures remain from `executePipeline` into the extracted functions

### If a Test Fails:

1. **Test mocks `_execute`:** After extraction, `_execute` no longer exists. Update the test to mock `executeNonStreamingPipeline` or use higher-level mocking (mock the provider).
2. **Test asserts specific internal function name:** Update assertion to use new function name.
3. **Behavioral test fails:** The refactoring should not change behavior. Investigate whether the extraction introduced a logic error. The most common cause: a variable that was accessible by closure is now passed incorrectly.
4. **If uncertain:** Return to SPSA for guidance.

---

## 8. Risk Assessment

| Risk                                                          | Likelihood | Impact | Mitigation                                                                                                                                                             |
| ------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closure variable missed during `_execute` promotion           | Medium     | High   | Pass all accessed variables as explicit parameters. Review: `input`, `config`, `eventBus`, `logger`, plus `handleOrchestratorError` (module-level, always accessible). |
| Streaming generation round collects too many chunks in memory | Low        | Medium | Each round's chunks are bounded by the provider's stream output. For large streams, collect and yield in batches — but this optimization is out of scope.              |
| Function body exceeds 40 lines for `executeGenerationRound`   | High       | Low    | Extract `buildPromptRequest()` (15 lines) and `executeWithFallback()` (20 lines) as sub-helpers. The main round function should be ~35–40 lines.                       |
| Test test coverage drops due to internal restructuring        | Low        | Medium | All existing behavioral tests cover the extraction paths. New unit tests for round functions are optional but recommended.                                             |
| M002 not yet applied                                          | Medium     | High   | M007 must be sequenced AFTER M002. The extraction boundaries assume M002 helpers exist.                                                                                |

---

## 9. References

- `.opencode/rules/architecture.md` — Execution Flow Steps 5–8 (GENERATING → TOOL_EXECUTING loop)
- `.opencode/rules/implementation-standards.md` — 40-line function body limit, 3-level nesting cap
- `.opencode/rules/typescript-style.md` — Naming conventions, async patterns
- `.opencode/milestones/targeted-implementation-plans/M002-pipeline-consolidation-implementation-plan.md` — M002 extraction boundaries (prerequisite)
- `.opencode/milestones/targeted-implementation-plans/M003-reliability-fix-retry-counter-and-memory-save.md` — M003 attempt counter split (prerequisite)
- `.opencode/milestones/targeted-implementation-plans/M006-performance-precompute-tool-definitions.md` — M006 tool definitions pre-computation (prerequisite)
- `packages/core/src/pipeline.ts` — Full file; lines 414–677 (\_execute), lines 722–1005 (streaming loop)
- `packages/core/src/types.ts` — `ResolvedConfig` with `toolDefinitions`
- `packages/core/src/interfaces.ts` — `PromptRequest`, `ToolDefinition`
