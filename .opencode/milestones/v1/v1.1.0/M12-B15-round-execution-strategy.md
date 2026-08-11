# B15 — RoundExecutionStrategy Consolidation (Round-Loop Unification)

**Status:** Ready for SPBED implementation (after B1A–B1E)
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap; ADR-039 (part 1 and part 3)

> **Sequence (ADR-039):** B15 is the terminal closure point for the ~250-line duplication finding (Finding 1.2/1.3). Sequenced **after B1A–B1E** (needs the module boundaries they establish); may run **in parallel with M11 Phase 2 (B11) only** — B11 touches `pipeline/error-mapper.ts`, which B15 does not overlap. **NOT parallel with M11 Phase 1 (B2):** B2 refactors `pipeline/shared.ts`, `non-streaming.ts`, and `streaming.ts` — the same files B15 modifies. No public API change; internal to `pipeline/`.

---

## 1. Task Summary

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

- Create `packages/core/src/pipeline/round-loop.ts` hosting:

  ```typescript
  // Internal — NOT exported from @atisse/core
  export interface RoundExecutionStrategy {
    generate(request: PromptRequest): Promise<PromptResponse>; // generate-call variation
    consumeChunk(chunk: StreamChunk, state: RoundState): void; // chunk-consumption variation
  }
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

| File                                                    | Action | Notes                                                                           |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/round-loop.ts`              | NEW    | `RoundExecutionStrategy` interface + shared `runRound()` loop                   |
| `packages/core/src/pipeline/non-streaming.ts`           | MODIFY | Replace duplicated loop with shared loop + `NonStreamingRoundExecutionStrategy` |
| `packages/core/src/pipeline/streaming.ts`               | MODIFY | Replace duplicated loop with shared loop + `StreamingRoundExecutionStrategy`    |
| `packages/core/src/pipeline/generation-engine.ts` (B1A) | MODIFY | Slim to the non-streaming strategy variation (generate-call)                    |
| `packages/core/src/pipeline/streaming-engine.ts` (B1E)  | MODIFY | Slim to the streaming strategy variation (chunk consumption)                    |
| `packages/core/src/pipeline/index.ts`                   | MODIFY | Keep `executePipeline()` dispatch — no new exports                              |
| `packages/core/src/index.ts`                            | NONE   | Verify no strategy types leak into the public API surface                       |

---

## 6. Implementation Strategy

### Step 1: Define the Strategy Interface

- Create `pipeline/round-loop.ts` with the `RoundExecutionStrategy` interface (internal).

### Step 2: Extract the Shared Round Loop

- Extract the common round-execution loop from the non-streaming path into `runRound()` in `round-loop.ts`.
- Parameterize the loop with a strategy: the loop calls `strategy.generate()` and `strategy.consumeChunk()` at the two variation points.

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
```

Specific assertions to verify:

- The two round paths share a **single** loop implementation (`runRound()` in `round-loop.ts`).
- A fix applied to one path is structurally guaranteed to apply to the other (same loop; strategies vary only generate-call and chunk-consumption).
- `NonStreamingRoundExecutionStrategy` and `StreamingRoundExecutionStrategy` are internal — absent from `@atisse/core` public API (`api-extractor` / `.api.md` diff shows no change).
- `run()` return shapes unchanged: `RunOutput` / `AsyncIterable<StreamChunk>` (ADR-006).
- Duplicated block no longer present — no two near-identical round loops in the codebase.
- All tests pass without modification.

---

## 8. Risk Assessment

| Risk                                                       | Likelihood | Impact | Mitigation                                                                                           |
| ---------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------- |
| Unifying too early (loop shape still shifting)             | Medium     | High   | Sequenced after B1A–B1E — module boundaries must exist before unification (ADR-039).                 |
| Streaming chunk semantics lost in the shared loop          | Medium     | High   | Streaming tests pass without modification; `StreamingRoundExecutionStrategy` owns chunk consumption. |
| Strategy types accidentally exported                       | Low        | High   | Internal to `pipeline/`; verify with API surface snapshot (B14).                                     |
| Overlap with B11 (ProviderErrorMapper)                     | Low        | Low    | B11 touches `pipeline/error-mapper.ts` only; B15 touches `round-loop.ts` + strategies — no overlap.  |
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
