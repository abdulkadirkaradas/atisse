# B15 — RoundExecutionStrategy Consolidation (Round-Loop Unification)

**Status:** Ready for SPBED implementation (after B1A–B1E)
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap; ADR-039 (part 1 and part 3)

> **Sequence (ADR-039):** B15 is the terminal closure point for the ~250-line duplication finding (Finding 1.2/1.3). Sequenced **after B1A–B1E** (needs the module boundaries they establish); may run **in parallel with M11 Phase 2 (B11) only** — B11 touches `pipeline/error-mapper.ts`, which B15 does not overlap. **NOT parallel with M11 Phase 1 (B2):** B2 refactors `pipeline/shared.ts`, `non-streaming.ts`, and `streaming.ts` — the same files B15 modifies. No public API change; internal to `pipeline/`.

---

## 1. Task Summary

> **Precondition:** B1A-E merged, `pipeline/*` skeleton exists, `pnpm typecheck && pnpm build` green. Monolith `pipeline.ts:1547` refs post-B1C re-verify. If `pipeline/*` not exists, STOP.

Eliminate the ~250-line duplication between the streaming and non-streaming round-execution paths (Finding 1.2/1.3) by consolidating them behind a single round loop:

1. Define one internal `RoundExecutionStrategy` interface in `pipeline/round-loop.ts`.
2. Implement two thin strategies: `NonStreamingRoundExecutionStrategy` and `StreamingRoundExecutionStrategy` — they supply only the **generate-call** and **chunk-consumption** variation.
3. Extract the shared round loop into `pipeline/round-loop.ts`; both paths execute through it.
4. Slim `non-streaming.ts` / `streaming.ts` (and the B1A–B1E engine modules) down to thin orchestrators over the shared loop.
5. All strategy types remain **internal** to `pipeline/` — NOT exported from `@atisse/core`.
6. `run()` return contracts unchanged (ADR-006). No public API change.

---

## 2. Context (Why This Exists)

The original B1 plan (§2) documents **~250 lines of duplication** between streaming and non-streaming paths — shared initialization and finalization logic copy-pasted with subtle variations. B1A–B1E relocate that duplication into separate modules (`non-streaming.ts` / `streaming.ts` and the engine files); B2 (PipelineRoundContext) improves parameter ergonomics; B11 (ProviderErrorMapper) centralizes only the error-classification slice. **None of these eliminate the duplicated round-execution logic itself** (`claude-technical-analysis.md` Finding 1.3).

The residual risk: a fix applied to one round path is not structurally guaranteed to be mirrored in the other — the two loops can silently diverge. This violates:

- **ADR-006 consistency** — a single round loop with a strategy seam embodies "streaming is a mode of `run()`"; two full copies of the loop contradict it.
- **Principle 1 (Explicit Over Magical)** — one visible loop is more traceable than two near-identical loops that can silently diverge.
- The DRY violation behind Finding 1.2 — B15 is its tracked closure point rather than having it implicitly closed by B1's restructuring alone.

This is not an ADR-034 case: the round-loop duplication is a DRY violation with a structural fix, not a layer-boundary artifact (ADR-039 rationale).

---

## 3. Issues/Changes

### Issue B15-1: Duplicated Round-Execution Loop

| Field       | Value                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/non-streaming.ts`, `packages/core/src/pipeline/streaming.ts` (after B1A–B1E)                                                      |
| Lines       | ~250 lines of duplicated round-execution logic (shared initialization and finalization copy-pasted with subtle variations)                                    |
| Severity    | HIGH                                                                                                                                                          |
| Description | The round-execution loop exists twice with subtle variations. A fix applied to one path is not structurally guaranteed to apply to the other.                 |
| Fix         | Unify behind `RoundExecutionStrategy`: one shared loop in `pipeline/round-loop.ts`; two thin strategies supply generate-call and chunk-consumption variation. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

- Create `packages/core/src/pipeline/round-loop.ts` hosting (internal L3 — NOT exported from `@atisse/core`; `RoundMutableState` from `pipeline/round-context.ts` per M11-B2B11 — `RoundState` does not exist):

  ```typescript
  // Internal L3 — NOT exported from @atisse/core (architecture SKILL:54-58 round-loop.ts internal, ADR-030 L3 internal)
  // RoundMutableState from pipeline/round-context.ts per M11-B2B11 — do NOT re-define RoundState
  export interface RoundExecutionStrategy {
    // SPBED must pick one seam and document choice:
    // Chosen: two-method seam to avoid if(stream) inside strategy, or split into two thin implementations per ADR-039 "two thin implementations".
    // Option A — two-method seam: single interface with
    //   executeGeneration(request: PromptRequest): Promise<PromptResponse> | Promise<AsyncIterable<StreamChunk>>
    //   — non-streaming returns PromptResponse via AIProvider.generate(); streaming returns AsyncIterable<StreamChunk> via AIProvider.generateStream()
    // Option B (preferable) — split into two thin implementations with distinct signatures; shared loop calls strategy-specific handler in type-safe branch.
    executeGeneration(
      request: PromptRequest,
    ): Promise<PromptResponse> | Promise<AsyncIterable<StreamChunk>>;
    // Streaming chunk consumption is NOT void consumeChunk(chunk, state): it accumulates over AsyncIterable
    consumeStream(
      iterable: AsyncIterable<StreamChunk>,
      mutable: RoundMutableState,
    ): Promise<{ accumulatedText: string; usage?: TokenUsage; pendingToolCalls: ToolCall[] }>;
    // Must wrap iterable with asyncIteratorWithIdleTimeout(timeoutMs, signal) per pipeline.ts:108-144
    // and handle accumulatedText/usage/pendingToolCalls + done/error at pipeline.ts:1186-1220
  }
  // Note retry delegation difference: non-streaming 825-851 delegates to RetryEngine/executeWithRetry
  // vs streaming 1131-1180 pre-stream custom retry loop with idle-timeout — shared loop MUST preserve both paths (see Fallback note below)
  ```

- Implement two thin strategies:
  - `NonStreamingRoundExecutionStrategy` — calls `AIProvider.generate()`; consumes the single complete response.
  - `StreamingRoundExecutionStrategy` — calls `AIProvider.generateStream()`; consumes `StreamChunk`s as they arrive (text / tool_call / tool_result / done / error).
- The shared round loop owns everything common: lifecycle transitions, retry integration (B1C), tool rounds via `ToolExecutor` (B1B), error normalization (B1D), event emission, hooks, and completion.
- Both paths execute through the **same** `runRound()` loop — a fix applied to one path is structurally applied to the other.
- Strategy types and `round-loop.ts` are internal to `pipeline/` — not exported from `pipeline/index.ts` or `packages/core/src/index.ts`.
- `run()` return contracts unchanged (ADR-006): `RunOutput` for non-streaming, `AsyncIterable<StreamChunk>` for streaming — the strategies produce the same outward shapes.
- All state remains local per call (Principle 4 — Stateless Core). No module-level state.
- Follow function body max 40 lines (per `implementation-standards.md`).

> **Fallback & retry semantics:** Fallback handling is non-streaming only (constraints `stream+fallback` `ConfigValidationError` at `pipeline.ts:1137-1144`, `orchestrator.ts`); `StreamingRoundExecutionStrategy` MUST NOT call `handleProviderError` fallback path. RETRYING: streaming pre-stream retry owns its loop; non-streaming delegates to `RetryEngine`/`executeWithRetry` — shared loop MUST NOT unify them into one retry path without preserving idle-timeout semantics (`pipeline.ts:108-144` `asyncIteratorWithIdleTimeout`). Non-streaming retry at `pipeline.ts:825-851` via `executeWithRetry`; streaming pre-stream custom loop at `pipeline.ts:1131-1180`.

### 4.2 What NOT to Do

- Do NOT export any `RoundExecutionStrategy` type or `round-loop.ts` symbol from `@atisse/core`.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, or any public contract.
- Do NOT merge the two strategies into one (no `if (stream)` inside the strategy) — keep two thin implementations.
- Do NOT change `run()` return shapes or the `StreamChunk` union.
- Do NOT change retry, tool, or error semantics already landed by B1A–B1E.
- Do NOT introduce new runtime dependencies.
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files.

---

## 5. Files to Modify

| File                                                    | Action | Notes                                                                                                                                                                                     |
| ------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/round-loop.ts`              | NEW    | `RoundExecutionStrategy` interface + shared `runRound()` loop                                                                                                                             |
| `packages/core/src/pipeline/non-streaming.ts`           | MODIFY | Replace duplicated loop with shared loop + `NonStreamingRoundExecutionStrategy`                                                                                                           |
| `packages/core/src/pipeline/streaming.ts`               | MODIFY | Replace duplicated loop with shared loop + `StreamingRoundExecutionStrategy`                                                                                                              |
| `packages/core/src/pipeline/generation-engine.ts` (B1A) | MODIFY | Slim to generate-call — loop moves to `round-loop.ts`, engine adapts only `generate`/`generateStream` call + `asyncIteratorWithIdleTimeout` wrapping for Strategy                         |
| `packages/core/src/pipeline/streaming-engine.ts` (B1E)  | MODIFY | Chunk consumption — strategy implementations live either as separate files or inside `round-loop.ts`, loop is in `round-loop.ts` (engine files only adapt for Strategy, loop centralized) |
| `packages/core/src/pipeline/index.ts`                   | MODIFY | Keep `executePipeline()` dispatch — no new exports                                                                                                                                        |
| `packages/core/src/index.ts`                            | NONE   | Verify no strategy types leak into the public API surface                                                                                                                                 |

### 5b. Changeset / Versioning

B15: `patch|none` — internal L3 refactor, no public export, ADR-039 NOT breaking; verify `pnpm build && api-extractor diff` empty; changeset `none` or `patch` per repo policy (same as M11 §5b pattern).

---

## 6. Implementation Strategy

### Step 1: Define the Strategy Interface

- Create `pipeline/round-loop.ts` with the `RoundExecutionStrategy` interface (internal).

### Step 2: Extract the Shared Round Loop

- Extract the common round-execution loop from the non-streaming path into `runRound()` in `round-loop.ts`.
- Parameterize the loop with a strategy: the loop calls `strategy.executeGeneration()` and `strategy.consumeStream()` at the two variation points (streaming `consumeStream` wraps `AsyncIterable<StreamChunk>` with `asyncIteratorWithIdleTimeout(timeoutMs, signal)` per `pipeline.ts:108-144`; accumulates `accumulatedText`/`usage`/`pendingToolCalls` + `done`/`error` handling at `pipeline.ts:1186-1220`; retry delegation preserved: non-streaming `825-851` via `executeWithRetry` vs streaming `1131-1180` pre-stream custom loop).

### Step 3: Adapt the Streaming Path

- Replace the streaming path's duplicated loop with the same `runRound()` call, supplying `StreamingRoundExecutionStrategy`.
- Verify streaming output shape (`AsyncIterable<StreamChunk>`) and chunk order are unchanged.

### Step 4: Slim the Engine Modules

- Reduce `generation-engine.ts` (B1A) and `streaming-engine.ts` (B1E) to their strategy-variation responsibilities.

### Step 5: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`.
- ALL tests must pass WITHOUT modification. No behavioral change, no public API change.

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build && api-extractor diff
madge --circular packages/core/src/pipeline/round-loop.ts
```

Specific assertions to verify:

- The two round paths share a **single** loop implementation (`runRound()` in `round-loop.ts`).
- A fix applied to one path is structurally guaranteed to apply to the other (same loop; strategies vary only generate-call and chunk-consumption).
- `NonStreamingRoundExecutionStrategy` and `StreamingRoundExecutionStrategy` are internal — absent from `@atisse/core` public API (`api-extractor` / `.api.md` diff shows no change); verify `madge --circular pipeline/round-loop.ts` no cycle and NOT exported from `@atisse/core` (`architecture` SKILL:54-58 `round-loop.ts` internal, ADR-030 L3 internal).
- `run()` return shapes unchanged: `RunOutput` / `AsyncIterable<StreamChunk>` (ADR-006).
- Duplicated block no longer present — no two near-identical round loops in the codebase.
- All tests pass without modification (ADR-039) — per `testing` SKILL:72 explicitly verify: streaming chunk order preserved, `tool_calls` round counter cumulative, `MockProvider` FIFO behavior unchanged.

---

## 8. Risk Assessment

| Risk                                                       | Likelihood | Impact | Mitigation                                                                                           |
| ---------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------- |
| Unifying too early (loop shape still shifting)             | Medium     | High   | Sequenced after B1A–B1E — module boundaries must exist before unification (ADR-039).                 |
| Streaming chunk semantics lost in the shared loop          | Medium     | High   | Streaming tests pass without modification; `StreamingRoundExecutionStrategy` owns chunk consumption. |
| Strategy types accidentally exported                       | Low        | High   | Internal to `pipeline/`; verify with API surface snapshot (B14) + `madge --circular` (like M11 §8).     |
| Overlap with B11 (ProviderErrorMapper)                     | Low        | Low    | B11 touches `pipeline/error-mapper.ts` only; B15 touches `round-loop.ts` + strategies — no overlap. Low correct. |
| Overlap with B2 (PipelineRoundContext)                     | High       | High   | NOT parallel — B2 modifies same files (`shared.ts`/`non-streaming.ts`/`streaming.ts`); B15 must be sequenced after B1A-E and not parallel with B2 Phase 1. |
| Regressions in retry/tool/error behavior landed by B1A–B1E | Medium     | Medium | B15 preserves engine semantics; retry/tool/error logic moves into the shared loop unchanged.         |

---

## 9. References

- `DECISION-LOG.md` — ADR-039 (RoundExecutionStrategy ruling; B15 terminal closure), ADR-006, ADR-030, ADR-034
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/claude-technical-analysis.md` — Finding 1.2/1.3 (duplication; B15 remediation)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1–2.2 (split rationale, target architecture)
- `.opencode/skill/architecture/SKILL.md` — Execution flow, Streaming Execution Flow, Layer Architecture
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical), Principle 4 (Stateless Core)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `M06-B1A-pipeline-generation-engine.md`, `M07-B1B-pipeline-tool-executor.md`, `M08-B1C-pipeline-retry-engine.md`, `M09-B1D-pipeline-error-mapper.md`, `M10-B1E-pipeline-streaming-engine.md` — B1A–B1E (module boundaries B15 builds upon)
- `.opencode/milestones/v1/v1.1.0/M11-B2B11-pipeline-context-and-error-mapper.md` — B2 (PipelineRoundContext) — sequential prerequisite; B11 (ProviderErrorMapper) — parallel with B15 (M11 Phase 2 only)
- `.opencode/milestones/v1/v1.1.0/M15-B14-ci-governance.md` — B14 (API surface snapshot — guards B15's internal-only constraint)
