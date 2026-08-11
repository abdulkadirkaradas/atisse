# B1A — GenerationEngine (Pipeline Decomposition, Part 1 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit.
>
> This file supersedes the monolithic B1 plan (see `_archive/000-superseded-b1-pipeline-decomposition.md`, now archived).

---

## 1. Task Summary

Extract the **GenerationEngine** — generation and fallback orchestration — from `packages/core/src/pipeline.ts` (~1547 lines, the largest file in core by 3.4×) into a new `packages/core/src/pipeline/` directory:

1. Create the `packages/core/src/pipeline/` directory skeleton: `index.ts`, `shared.ts`, `non-streaming.ts` (the `streaming.ts` file lands with B1E).
2. Extract generation-scoped logic into `generation-engine.ts`: the generate call (Step 5), the generation loop, and fallback handling (Step 8, `FALLBACKING`).
3. Move shared helpers into `shared.ts`: `buildPromptRequest()`, `resolveProfiles()`, `buildContextInput()`, and the M002-extracted `initializePipeline()` (Steps 1–4).
4. Keep `executePipeline()` as the single exported entry point from `pipeline/index.ts`, dispatching on `input.stream` (the streaming branch completes in B1E).
5. Update `orchestrator.ts` to import from `./pipeline/index.js`.
6. Public API unchanged — no consumer-visible changes.

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` is 1547 lines — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). It contains execution orchestration, retry handling and timeout management, tool execution, streaming workflows (async generator), event emission, lifecycle transitions, fallback handling, error normalization, and hook execution — all in one file.

The generation/fallback slice is one of six distinct orchestration concerns identified in review (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)** — the core itself is not small. It also causes:

- **High merge conflict frequency** — every pipeline change touches the same file.
- **Reduced maintainability** — a developer must understand the entire file to change one step.
- **Increased regression probability** — shared variables and inline state make it easy to introduce bugs.
- **~250 lines of duplication** between streaming and non-streaming paths (shared initialization and finalization logic copy-pasted with subtle variations). B1A relocates the generation slice of that duplication; B15 eliminates the duplication itself.

The earlier M002 consolidation (Option 1 — Minimal Consolidation) extracted `initializePipeline()`, `executeToolRound()`, and `finalizePipeline()` as helpers within the same file. B1A builds on M002's extracted functions and moves the generation helpers into the new module boundaries.

---

## 3. Issues/Changes

### Issue B1A-1: GenerationEngine embedded in a God Module

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                         |
| Lines       | 1–1547 (entire file); generation + fallback logic spans Steps 5 and 8                                                   |
| Severity    | HIGH                                                                                                                    |
| Description | Generation orchestration (`buildPromptRequest()`, generate call, fallback swap) is embedded in a single 1547-line file. |
| Fix         | Extract into `pipeline/generation-engine.ts` + `pipeline/shared.ts`. Pure restructuring — no behavioral change.         |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**Target directory structure (built across B1A–B1E; B1A lands the skeleton + generation slice):**

```
packages/core/src/pipeline/
├── index.ts              — re-exports executePipeline(); dispatches on input.stream
├── shared.ts             — common helpers shared by streaming and non-streaming (B1A: buildPromptRequest, resolveProfiles, buildContextInput, initializePipeline)
├── non-streaming.ts      — executeNonStreamingPipeline() and its sub-functions (shell lands in B1A; tool/retry/error slices land in B1B–B1D)
├── generation-engine.ts  — NEW (B1A): generation loop, fallback handling
├── tool-executor.ts      — NEW (B1B): tool round execution
├── retry-engine.ts       — NEW (B1C): retry/backoff/timeout handling
├── error-normalizer.ts   — NEW (B1D): handleOrchestratorError() normalization
└── streaming.ts          — NEW (B1E): streaming pipeline (async generator)
```

**Module responsibilities (B1A scope):**

| Module                 | Responsibility                                                                                                   | Approx. LOC |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------- |
| `index.ts`             | Barrel export — `executePipeline()` stream/non-stream dispatch                                                   | ~10         |
| `shared.ts` (B1A part) | `buildPromptRequest()`, `resolveProfiles()`, `buildContextInput()`, `initializePipeline()`, `finalizePipeline()` | ~200        |
| `generation-engine.ts` | Step 5 generate loop, fallback swap (Step 8)                                                                     | ~250        |
| `non-streaming.ts`     | Step 1–10 orchestration shell (full assembly after B1B–B1D)                                                      | ~400        |

**All state remains local per call (Principle 4 — Stateless Core).** No module-level state in any new file.

**Shared routing:** `index.ts` determines whether to call `executeNonStreamingPipeline()` or `executeStreamingPipeline()` based on `input.stream`. The current `pipeline.ts` already has this dispatch logic — it moves to `index.ts`. Until B1E lands, the streaming branch continues to call the existing streaming path (no behavioral change).

**Build upon M002 extracted helpers:** The M002 consolidation already extracted `initializePipeline()`, `executeToolRound()`, `finalizePipeline()` within the current pipeline.ts. B1A should:

1. Move `initializePipeline()` (Steps 1–4) and the generation helpers to `shared.ts`.
2. Import and call them from `generation-engine.ts` and `non-streaming.ts`.
3. Ensure the extraction boundaries respect the existing function signatures — no behavioral changes.

**Follow function body max 40 lines (per `implementation-standards.md`).** If any extracted function exceeds 40 lines, further decompose it.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). The single exported function `executePipeline()` must remain with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, or any other contract file.
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT attempt full EventSourcedPipeline refactor (Option 2/3 from M002 analysis).
- Do NOT create `.md` documentation files.
- Do NOT add exports beyond what `pipeline.ts` currently exports. If `pipeline.ts` currently exports only `executePipeline`, the new `index.ts` must export only `executePipeline`.
- Do NOT introduce module-level state or singletons in the new files.

---

## 5. Files to Modify

| File                                              | Action | Notes                                                                                                                                   |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline.ts`                   | MODIFY | Remove generation slice (Steps 5, 8) + shared generation helpers; retain tool/retry/error logic until B1B–B1D                           |
| `packages/core/src/pipeline/index.ts`             | NEW    | Entry point — re-exports `executePipeline`; dispatch on `input.stream`                                                                  |
| `packages/core/src/pipeline/shared.ts`            | NEW    | Generation + completion helpers: `buildPromptRequest`, `resolveProfiles`, `buildContextInput`, `initializePipeline`, `finalizePipeline` |
| `packages/core/src/pipeline/generation-engine.ts` | NEW    | Generation loop + fallback handling (Step 5 + Step 8)                                                                                   |
| `packages/core/src/pipeline/non-streaming.ts`     | NEW    | Non-streaming orchestration shell (Steps 1–10 assembly; tool/retry/error logic retained inline until B1B–B1D)                           |
| `packages/core/src/orchestrator.ts`               | MODIFY | Update import path from `./pipeline.js` to `./pipeline/index.js`                                                                        |

---

## 6. Implementation Strategy

### Step 1: Create Directory Structure

- Create `packages/core/src/pipeline/` directory.
- Create placeholder files: `index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`.

### Step 2: Extract Shared Generation Helpers

- Open `packages/core/src/pipeline.ts`.
- Identify generation-related helpers used by BOTH streaming and non-streaming paths:
  - `buildPromptRequest()` — assembles `PromptRequest` from config, messages, and input
  - `resolveProfiles()` — profile resolution logic (may already be in `profile.ts`)
  - `buildContextInput()` — builds the `ContextProviderInput` from `RunInput`
  - M002-extracted `initializePipeline()` (Steps 1–4)
  - M002-extracted `finalizePipeline()` (Steps 9–10)
  - `estimateTokens()` — token estimation utility (may already be duplicated between `pipeline.ts` and `prompt-composer.ts`)
  - `enforceCharLimit()` — context length enforcement
- Move these to `shared.ts`, maintaining exact same function signatures.
- Ensure all imports are updated to reference `./shared.js` where needed.

### Step 3: Extract GenerationEngine

- Identify the generation loop and fallback logic in `pipeline.ts` (Step 5 generate call, Step 8 fallback swap).
- Move to `generation-engine.ts` as the `GenerationEngine` module.
- Import shared utilities from `./shared.js`.

### Step 4: Create Non-Streaming Shell + Barrel

- Move the non-streaming pipeline body into `non-streaming.ts` (`executeNonStreamingPipeline()`).
- `index.ts` dispatches on `input.stream`:

  ```typescript
  export async function executePipeline(
    config: ResolvedConfig,
    input: RunInput & { stream?: boolean },
    eventBus: EventBus,
    logger: Logger,
  ): Promise<RunOutput | AsyncIterable<StreamChunk>> {
    if (input.stream) {
      // B1E replaces this branch with executeStreamingPipeline()
      return /* existing streaming path until B1E */;
    }
    return executeNonStreamingPipeline(config, input, eventBus, logger);
  }
  ```

- Update `orchestrator.ts` import from `'./pipeline.js'` to `'./pipeline/index.js'`.

### Step 5: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`.
- ALL tests must pass WITHOUT modification. This is a pure refactor — no behavioral change.

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

- `packages/core/src/pipeline/generation-engine.ts` and `shared.ts` exist and contain the generation helpers.
- `packages/core/src/orchestrator.ts` imports from `'./pipeline/index.js'`.
- `executePipeline()` has the exact same function signature as before.
- No new exports are added to `@atisse/core` public API.
- No behavioral change — test coverage and assertions remain identical; all tests pass without modification.

**Troubleshooting:** If a test fails because it mocks an internal function from `pipeline.ts`:

- Do NOT modify the test's behavioral assertions.
- Update the test's import path to point to the new module location.
- The internal restructuring should be transparent to test assertions.

---

## 8. Risk Assessment

| Risk                                                        | Likelihood | Impact | Mitigation                                                                                                 |
| ----------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| Largest refactor in v1.1.0 — highest surface for regression | Medium     | High   | B1A is 1/5 of B1 (ADR-039): atomic scope shrinks blast radius per commit. Tests pass without modification. |
| Imports in `orchestrator.ts` may reference the wrong path   | Low        | High   | Update import path explicitly in Step 4; verify with `pnpm typecheck`.                                     |
| Internal mocking in tests references pipeline internals     | Medium     | Medium | Update test imports only — preserve all behavioral assertions.                                             |
| Circular dependency introduced by shared.ts                 | Low        | High   | `shared.ts` imports only from Layer 0–1 (`interfaces.ts`, `errors.ts`, `policies.ts`).                     |
| M002 extracted functions have wrong signatures for B1 reuse | Low        | Medium | Review M002 function signatures before extraction; adjust if needed (no behavioral change).                |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow (steps 1–10), Layer Architecture diagram, `pipeline.ts` vs `orchestrator.ts`
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 7 (Small Core, Large Ecosystem)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `.opencode/skill/interfaces/SKILL.md` — `ResolvedConfig`, `RunInput`, `RunOutput`, `EventBus` types
- `DECISION-LOG.md` — ADR-039 (B1A–B1E atomic split; B15 closure)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1–2.2 (split rationale, target architecture)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/gemini-technical-analysis.md` — §2.1 (atomic segmentation)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior extraction of `initializePipeline()`, `executeToolRound()`, `finalizePipeline()`
- `packages/core/src/pipeline.ts` — Source file to decompose
- `packages/core/src/orchestrator.ts` — Consumer of pipeline entry point
- `M07-B1B-pipeline-tool-executor.md`, `M08-B1C-pipeline-retry-engine.md`, `M09-B1D-pipeline-error-mapper.md`, `M10-B1E-pipeline-streaming-engine.md` — Sibling sub-milestones (B1B–B1E)
