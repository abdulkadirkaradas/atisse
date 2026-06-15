# M005 — Observability: Add `TimingCollector` for Per-Step Durations

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline enterprise analysis — Observability (Moderate)

---

## 1. Task Summary

Add a `TimingCollector` utility class that records per-step wall-clock durations during pipeline execution. The collected timings are emitted as an optional structured payload on the existing `run.completed` event without breaking the frozen `OrchestratorEvent` union. Add a `StepTimings` interface to the frozen contract (backward-compatible — optional field on `run.completed`).

---

## 2. Context (Why This Exists)

Currently, the pipeline tracks only total `durationMs` on `run.completed`. There is no visibility into how that time is distributed across individual steps:

- How long did context provider loading take? (Step 2)
- How long did the first generate call take vs retries? (Step 5)
- How long did tool execution consume across all rounds? (Step 6)
- How long did finalization (memory save, afterRun hooks) take? (Step 9–10)

This timing data is valuable for:

- Debugging slow runs (is the provider slow, or is tool execution the bottleneck?)
- Observability dashboards (p50/p95 per-step latencies)
- User-facing progress monitoring
- Performance regression detection

Current state: `startTime` and `trackDuration()` exist in pipeline.ts but provide only cumulative wall-clock time. Per-step data requires manually inserting `Date.now()` calls at each transition point, which is what `TimingCollector` formalizes.

The constraint: the `OrchestratorEvent` union is frozen. Adding a required field would be a breaking change. Adding an **optional** field is backward-compatible and permitted with SPSA approval.

---

## 3. Issues/Changes

### Issue: No Per-Step Timing Data

| Field       | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`, `packages/core/src/interfaces.ts`                                               |
| Severity    | MODERATE                                                                                                         |
| Description | Pipeline emits only total `durationMs` on `run.completed`. No per-step breakdown is available for observability. |
| Fix         | Add `TimingCollector` class + `StepTimings` interface + optional `timings` field on `run.completed`.             |

---

## 4. Architectural Directives

### 4.1 `StepTimings` Interface — Add to `interfaces.ts`

```typescript
/**
 * Per-step timing breakdown for a pipeline execution.
 * All values are in milliseconds, measured as wall-clock time.
 *
 * Emitted as an optional field on `run.completed` — consumers that
 * do not need timing data can ignore it.
 */
export interface StepTimings {
  /** Time spent in CONTEXT_INJECTING + CONTEXT_INJECTED (context provider loading + memory load) */
  contextLoadingMs: number;
  /** Time spent in PROMPT_COMPOSED (single composition call — typically <1ms) */
  compositionMs: number;
  /** Total time spent in GENERATING across all rounds (includes retries) */
  generationMs: number;
  /** Total time spent in TOOL_EXECUTING across all rounds */
  toolExecutionMs: number;
  /** Time spent in COMPLETING (memory save + afterRun hooks) */
  finalizationMs: number;
  /** Total pipeline wall-clock time (sum of all above; may be less than durationMs due to scheduling) */
  totalMs: number;
}
```

### 4.2 `run.completed` Event — Add Optional `timings` Field

Change the `run.completed` member of `OrchestratorEvent` from:

```typescript
| { type: 'run.completed'; runId: string; durationMs: number; usage: TokenUsage }
```

To:

```typescript
| { type: 'run.completed'; runId: string; durationMs: number; usage: TokenUsage; timings?: StepTimings }
```

This is a backward-compatible addition — all existing consumers continue to work unchanged.

### 4.3 `TimingCollector` Class — New File `packages/core/src/timing-collector.ts`

Create a dedicated file for the `TimingCollector` class. This keeps the timing logic separate from pipeline.ts and avoids bloating the pipeline further.

```typescript
import type { StepTimings } from './interfaces.js';

/**
 * Per-run timing collector.
 *
 * Records wall-clock timestamps at named step boundaries and produces
 * a StepTimings payload for emission on the run.completed event.
 *
 * Usage:
 *   const timing = new TimingCollector();
 *   timing.mark('contextLoading');
 *   // ... context loading happens ...
 *   timing.mark('composition');
 *   // ... etc ...
 *   const timings = timing.snapshot(); // StepTimings
 *
 * File-private to pipeline.ts layer — NOT exported from @atisse/core.
 */
export class TimingCollector {
  private marks: Map<string, number> = new Map();

  /**
   * Record a wall-clock timestamp at the current step boundary.
   * The step name should align with pipeline state transitions.
   * Calling mark() twice with the same name overwrites (last-write-wins).
   */
  mark(step: string): void {
    this.marks.set(step, Date.now());
  }

  /**
   * Calculate elapsed ms from a previous mark to now.
   * Returns 0 if the mark was never recorded.
   */
  private elapsed(fromMark: string): number {
    const from = this.marks.get(fromMark);
    if (from === undefined) return 0;
    return Date.now() - from;
  }

  /**
   * Calculate elapsed ms between two marks.
   * Returns 0 if either mark was never recorded.
   */
  private between(fromMark: string, toMark: string): number {
    const from = this.marks.get(fromMark);
    const to = this.marks.get(toMark);
    if (from === undefined || to === undefined) return 0;
    return to - from;
  }

  /**
   * Produce the final StepTimings snapshot.
   * Should be called once at pipeline completion (before or after Emit).
   * Subsequent calls return the same values (marks are not cleared).
   */
  snapshot(): StepTimings {
    const now = Date.now();
    return {
      contextLoadingMs: this.between('context_start', 'context_end'),
      compositionMs: this.between('composition_start', 'composition_end'),
      generationMs: this.elapsed('generation_start'),
      toolExecutionMs: this.elapsed('tool_execution_start'),
      finalizationMs: this.elapsed('finalization_start'),
      totalMs: now - (this.marks.get('start') ?? now),
    };
  }
}
```

**Design notes:**

- `mark()` is called at pipeline state transition boundaries
- `snapshot()` produces the final payload — called at the end of the pipeline just before emitting `run.completed`
- Non-exported (`private`) `elapsed()` and `between()` helpers keep the interface clean
- The class is NOT exported from `@atisse/core` — it's an internal implementation detail

### 4.4 Integration Points in `pipeline.ts`

The `TimingCollector` is instantiated once per pipeline execution and `mark()` calls are inserted at state transition boundaries:

| Event                                               | TimingCollector.mark() call                          |
| --------------------------------------------------- | ---------------------------------------------------- |
| Before context provider loading (after INITIALIZED) | `timing.mark('start'); timing.mark('context_start')` |
| After memory load, before PromptComposer            | `timing.mark('context_end')`                         |
| Before PromptComposer.compose()                     | `timing.mark('composition_start')`                   |
| After PromptComposer.compose()                      | `timing.mark('composition_end')`                     |
| Before `activeProvider.generate()`                  | `timing.mark('generation_start')`                    |
| After generate completes (before tool check)        | `timing.mark('generation_end')` — reset on retry     |
| Before ToolController.executeRound()                | `timing.mark('tool_execution_start')`                |
| After tool round (in retry path, accumulates)       | — timing is cumulative via snapshot's `elapsed()`    |
| Before memoryAdapter.save() in COMPLETING           | `timing.mark('finalization_start')`                  |
| After afterRun hooks                                | — timing captured at snapshot                        |
| Before emit `run.completed`                         | `const timings = timing.snapshot()`                  |

**Important:** In the generation retry loop, `timing.mark('generation_start')` should be called at the BEGINNING of each generate attempt (not just the first). This means the `generationMs` value in the snapshot reflects TOTAL time spent generating (includes retry delays), which is the most useful metric. Similarly for tool execution.

### 4.5 Attach Timings to `run.completed`

In `finalizePipeline()` (or wherever `run.completed` is emitted), add the `timings` field:

```typescript
// In finalizePipeline() or in the caller that emits run.completed:
eventBus.emit({
  type: 'run.completed',
  runId,
  durationMs: Date.now() - startTime,
  usage: output.usage,
  timings: timing.snapshot(), // NEW
});
```

### 4.6 What NOT to Do

- Do NOT export `TimingCollector` from `packages/core/src/index.ts` — it is an internal implementation detail
- Do NOT break the `run.completed` event shape — `timings` is optional, all existing consumers ignore it
- Do NOT add `TimingCollector` as a parameter to extracted helpers — it should be created and managed in the top-level pipeline functions and passed to helpers that need it, OR created in `initializePipeline` and threaded through
- Do NOT add `generate_start` / `generate_end` that gets overwritten mid-retry — the mark is set once at the start of the first generation attempt in each round
- Do NOT add timing marks at every state machine transition — only the meaningful step boundaries listed above

---

## 5. Files to Modify

| File                                                | Action            | Notes                                                                             |
| --------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`                   | MODIFY (additive) | Add `StepTimings` interface; add `timings?: StepTimings` to `run.completed` event |
| `packages/core/src/timing-collector.ts`             | CREATE            | New file — `TimingCollector` class                                                |
| `packages/core/src/pipeline.ts`                     | MODIFY (additive) | Import `TimingCollector`, add mark() calls, attach timings on completion          |
| `packages/core/tests/unit/timing-collector.test.ts` | CREATE            | Unit tests for `TimingCollector`                                                  |

---

## 6. Implementation Strategy

### Step 1: Create `timing-collector.ts`

- Create `packages/core/src/timing-collector.ts` with the `TimingCollector` class as specified in §4.3
- Keep it simple — no dependencies beyond `import type { StepTimings } from './interfaces.js'`
- Function body: 40-line limit respected by keeping each method small

### Step 2: Add `StepTimings` and update `run.completed` in interfaces.ts

- Add `StepTimings` interface to `packages/core/src/interfaces.ts`
- Add `timings?: StepTimings` as the last field in the `run.completed` event member
- No `import` changes needed — `StepTimings` is defined in the same file

### Step 3: Integrate into non-streaming pipeline

In `_execute()` inside `executePipeline()`:

1. Create `const timing = new TimingCollector();` at the top (before the while loop)
2. Add timing marks at the boundaries listed in §4.4
3. After `finalizePipeline()` returns, the caller emits `run.completed` — inject `timings` there
4. Pass `timing` to `finalizePipeline()` or add the mark calls inside `finalizePipeline()`

The cleanest integration: create `timing` in the non-streaming `_execute()` body and call `mark()` at each step boundary. For `finalizePipeline()`, either:

- Pass `timing` as a parameter (adds to the parameter list but keeps timing logic centralized)
- Or call `mark()` before and after the `finalizePipeline()` call in the caller

**Recommendation:** Add `mark()` calls directly in the pipeline functions at the transition points. The `TimingCollector` instance lives at the `_execute()` scope.

### Step 4: Integrate into streaming pipeline

Same approach as Step 3 — create `timing` at the top of `executeStreamingPipeline()` (after line 696, before the try block) and add mark calls at the same step boundaries. `finalizePipeline()` in streaming is called at line 1024 — pass timing there too.

### Step 5: Update `finalizePipeline()` to attach timings

Add an optional `timing?: TimingCollector` parameter to `finalizePipeline()`. If provided, call `timing.mark('finalization_start')` before memory save and include `timings: timing.snapshot()` in the emitted `run.completed` event.

**Signature change:**

```typescript
async function finalizePipeline(
  stateMachine: LifecycleStateMachine,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  startTime: number,
  tempMessages: [Message, Message],
  usage: TokenUsage,
  input: RunInput,
  allToolResults: ToolResult[],
  activeProfile: string,
  memoryAdapter: ResolvedConfig['memoryAdapter'],
  responseText: string,
  timing?: TimingCollector, // NEW optional parameter
): Promise<RunOutput>;
```

### Step 6: Create unit tests

Create `packages/core/tests/unit/timing-collector.test.ts`:

- `mark()` and `snapshot()` returns all-zero timings when no marks recorded
- `mark()` with step names followed by `snapshot()` returns positive values
- `snapshot()` is idempotent (multiple calls return same structure)
- `totalMs` approximately equals `Date.now() - recordedStartTime`
- `between()` correctly calculates differences between ordered marks
- Marking same step name twice uses last value

### Step 7: Verify

Run:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage
```

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

1. `TimingCollector.snapshot()` returns a valid `StepTimings` object with all numeric fields
2. `run.completed` event includes `timings` field when `TimingCollector` is used
3. All existing tests pass without modification — `timings` is optional, existing assertions ignore it
4. Timing values are positive and internally consistent (sum of parts ≤ totalMs + small skew)
5. No runtime errors when `TimingCollector` is not used (i.e., if someone creates a pipeline without it)

### If a Test Fails:

1. **Test asserting specific `run.completed` shape:** Ensure the test allows extra fields on the event object (using `toMatchObject()` or partial matching)
2. **Test asserting event emission count:** Adding an optional field does not change emission count
3. **Other failures:** Investigate for unintended side effects of the mark() calls

---

## 8. Risk Assessment

| Risk                                                                            | Likelihood | Impact | Mitigation                                                                                                                                  |
| ------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding `timings` to `run.completed` breaks consumers using exact shape matching | Low        | Medium | `timings` is optional; consumers using `toMatchObject()` or partial destructuring are unaffected. Document as backward-compatible addition. |
| `TimingCollector` adds overhead to pipeline                                     | Low        | Low    | Each `mark()` is a single `Map.set()` — negligible. `snapshot()` computes 6 arithmetic operations.                                          |
| Incorrect mark placement produces misleading timing data                        | Medium     | Low    | Timing data is advisory/debugging — incorrect values do not affect correctness. Test coverage on non-streaming path validates basic sanity. |
| Parameter count on `finalizePipeline()` grows                                   | Medium     | Low    | Already approved for many parameters (see M002). Adding one optional parameter is within the exception.                                     |

---

## 9. References

- `.opencode/rules/architecture.md` — Execution Flow steps 1–10, state transition boundaries
- `.opencode/rules/interfaces-core.md` — Frozen contracts, `OrchestratorEvent` union
- `.opencode/rules/interfaces-runtime.md` — `OrchestratorEvent` union definition
- `.opencode/rules/constraints.md` — Interface modification rules (optional fields allowed)
- `.opencode/workflows/observability-standards.md` — Log points, runId correlation
- `.opencode/rules/implementation-standards.md` — 40-line function body limit, 3-level nesting
- `packages/core/src/pipeline.ts` — All 10 execution steps, `run.completed` emission points
- `packages/core/src/interfaces.ts` — `OrchestratorEvent` union, `TokenUsage` reference
