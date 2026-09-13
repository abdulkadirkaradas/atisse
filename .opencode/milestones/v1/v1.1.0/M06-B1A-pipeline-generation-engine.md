# B1A — GenerationEngine (Pipeline Decomposition, Part 1 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit.
>
> This file supersedes the monolithic B1 plan (see `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — prior archive `_archive/000-superseded-b1-pipeline-decomposition.md` preserved for history).

---

## 1. Task Summary

Extract the **GenerationEngine** — generation and fallback orchestration — from `packages/core/src/pipeline.ts` (source ranges: `buildPromptRequest:67-85`, `initializePipeline:300-476`, `handleProviderError:656-705`, `executeGenerationRound:788-926` within the 1547-line file, the largest file in core by 3.4×) into a new `packages/core/src/pipeline/` directory:

1. Create the `packages/core/src/pipeline/` directory skeleton: `index.ts`, `shared.ts`, `non-streaming.ts` (the `streaming.ts` file lands with B1E — use `streaming.ts` consistently, not `streaming-engine.ts`; B1E aligns the final name per ADR-039).
2. Extract generation-scoped logic into `generation-engine.ts`: the generate call (Step 5) and fallback handling (Step 8, `FALLBACKING`) — **tool branching excluded** (see §4.1).
3. Move shared helpers into `shared.ts` (B1A scope narrowed — see §4.1, §5, §6 Step 2): `buildPromptRequest:67-85` + `initializePipeline:300-476` (including `resolveProfiles` Steps 1–4) only.
4. Keep `executePipeline()` as the single exported entry point from `pipeline/index.ts`, dispatching on `input.stream` — **in B1A, `pipeline.ts` is NOT deleted**; `pipeline/index.ts` delegates streaming to the legacy path until B1E (see §4.1, §6 Step 1).
5. Update `orchestrator.ts:22` import from `'./pipeline.js'` to `'./pipeline/index.js'` (ESM NodeNext specifier).
6. Public API unchanged — no consumer-visible changes. Classification: internal refactor, no `interfaces.ts` change → `changeset: patch` or `none`; `api-extractor` diff empty; ADR-039 NOT breaking (see §5b).

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` is 1547 lines — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). It contains execution orchestration, retry handling and timeout management, tool execution, streaming workflows (async generator), event emission, lifecycle transitions, fallback handling, error normalization, and hook execution — all in one file.

The generation/fallback slice is one of six distinct orchestration concerns identified in review (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)** — the core itself is not small. It also causes:

- **High merge conflict frequency** — every pipeline change touches the same file.
- **Reduced maintainability** — a developer must understand the entire file to change one step.
- **Increased regression probability** — shared variables and inline state make it easy to introduce bugs.
- **~250 lines of duplication** between streaming and non-streaming paths (shared initialization and finalization logic copy-pasted with subtle variations). B1A relocates the generation slice of that duplication; B15 eliminates the duplication itself.

The earlier M002 consolidation (Option 1 — Minimal Consolidation, see `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md`) extracted `initializePipeline()`, `executeToolRound()`, and `finalizePipeline()` as helpers within the same file. B1A builds on M002's extracted functions and moves the generation helpers into the new module boundaries.

---

## 3. Issues/Changes

### Issue B1A-1: GenerationEngine embedded in a God Module

| Field       | Value                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                                                                 |
| Lines       | Precise ranges: `buildPromptRequest:67-85`, `initializePipeline:300-476`, `handleProviderError:656-705`, `executeGenerationRound:788-926` (within 1–1547 total) |
| Severity    | HIGH                                                                                                                                                            |
| Description | Generation orchestration (`buildPromptRequest()`, generate call, fallback swap) is embedded in a single 1547-line file.                                         |
| Fix         | Extract into `pipeline/generation-engine.ts` + `pipeline/shared.ts`. Pure restructuring — no behavioral change.                                                 |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**Target directory structure (built across B1A–B1E; B1A lands the skeleton + generation slice):**

```
packages/core/src/pipeline/
├── index.ts              — re-exports executePipeline(); dispatches on input.stream
├── shared.ts             — common helpers shared by streaming and non-streaming (B1A: buildPromptRequest:67-85, initializePipeline:300-476 including resolveProfiles Steps 1-4)
├── non-streaming.ts      — executeNonStreamingPipeline() and its sub-functions (shell lands in B1A; tool/retry/error slices land in B1B–B1D)
├── generation-engine.ts  — NEW (B1A): generation loop, fallback handling (Step 5 + Step 8); tool branching excluded
├── tool-executor.ts      — NEW (B1B): tool round execution
├── retry-engine.ts       — NEW (B1C): retry/backoff/timeout handling
├── error-normalizer.ts   — NEW (B1D): handleOrchestratorError() normalization
└── streaming.ts          — NEW (B1E): streaming pipeline (async generator) — use streaming.ts consistently; streaming-engine.ts alias is stale
```

**Module responsibilities (B1A scope):**

| Module                 | Responsibility                                                                                                                                                                                                                                                                                                                                                                | Approx. LOC |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `index.ts`             | Barrel export — `executePipeline()` stream/non-stream dispatch. In B1A, `pipeline.ts` is NOT deleted; `pipeline/index.ts` dispatches: `if (input.stream) delegate temporarily to legacy` `../pipeline.legacy.js` or existing `executeStreamingPipeline`, which will be moved to `streaming.ts` in B1E. B1A only extracts non-streaming path.                                  | ~10         |
| `shared.ts` (B1A part) | `buildPromptRequest:67-85`, `initializePipeline:300-476` (including `resolveProfiles` Steps 1–4). Deferred to B1D/B2: `enforceCharLimit:262-288`, `estimateTokens:435-441` local lambda, `buildContextInput` (inline object :363-368, not a function), `finalizePipeline:575-644` Steps 9–10 COMPLETING/COMPLETED. `shared.ts` scope in B1A is strictly the two ranges above. | ~200        |
| `generation-engine.ts` | Step 5 generate call + fallback swap (Step 8, `FALLBACKING`) — non-streaming generate call + fallback swap, **tool branching excluded**; if `finishReason==='tool_calls'` return `PromptResponse` with `toolCalls`, caller delegates execution to B1B ToolExecutor. ~250 LOC must be split into sub-functions to meet 40-line rule.                                           | ~250        |
| `non-streaming.ts`     | Steps 1–10 shell — orchestrates `initializePipeline` → `generation-engine` → finalize (Steps 9–10 remain via legacy `finalizePipeline` until B1D/B2). Tool/retry/error inline remain until B1B–D. `executeToolRoundWithErrorHandling():717-776` is NOT moved in B1A — avoids twice-move with B1B.                                                                             | ~400        |

**All state remains local per call (Principle 4 — Stateless Core).** No module-level state in any new file.

**Param object constraint (code-standards):** State machine, eventBus, logger, runId passed via shared context option object (e.g., `PipelineRoundContext`) to keep param count ≤3 per `code-standards` (≤3 params else options object). This applies to `generation-engine.ts` and `shared.ts` helpers — bundle `eventBus`, `logger`, `stateMachine`, `runId`, `trackDuration` into `PipelineRoundContext` rather than 5+ positional args.

**Shared routing (interim B1A):** `index.ts` determines whether to call `executeNonStreamingPipeline()` or the legacy streaming path based on `input.stream`. Until B1E lands, the streaming branch continues to call the existing streaming path (no behavioral change) — **pipeline.ts is NOT deleted in B1A**; either keep a `pipeline.legacy.ts` copy or re-export the existing `executeStreamingPipeline` from its current location until B1E moves it to `streaming.ts`. Remove ambiguous "streaming will change in B1E" without interim — the interim delegation must be explicit.

**Fallback/Retry separation (B1A vs B1C):** Two valid orderings, pick one and document to avoid circular import:

- **Option A (preferred for B1A):** Keep `executeWithRetry` wrapper (`:826-851`) in `non-streaming.ts` for B1A and note "B1A imports retry helpers via `policies.ts` L1 (`calculateDelay`, `isRetryable` helpers are L1; B1C moves them to `retry-engine.ts`)". `generation-engine.ts` owns `handleProviderError:656-705` (fallback swap) but delegates retry-backoff (`calculateDelay`/`isRetryable`/`MaxRetriesExceededError`) via `policies.ts` — document that `calculateDelay`/`isRetryable`/`MaxRetriesExceededError` belong to B1C `retry-engine.ts`.
- **Option B:** Keep fallback (`handleProviderError`) in `generation-engine.ts` but explicitly state ordering `generation-engine.ts → policies.ts (L1)` and `non-streaming.ts → generation-engine.ts` to avoid circular `generation-engine ↔ non-streaming` import.

Document the chosen option in the PR description; either way, B1A must not create `retry-engine.ts` — B1C owns `calculateDelay`/`isRetryable`/`MaxRetriesExceededError` relocation.

**Build upon M002 extracted helpers:** The M002 consolidation already extracted `initializePipeline()`, `executeToolRound()`, `finalizePipeline()` within the current pipeline.ts. B1A should:

1. Move `initializePipeline()` (Steps 1–4, `300-476`) and `buildPromptRequest:67-85` to `shared.ts` (B1A narrowed scope).
2. Import and call them from `generation-engine.ts` and `non-streaming.ts` via `PipelineRoundContext`.
3. Ensure the extraction boundaries respect the existing function signatures — no behavioral changes. Extraction keeps the canonical signature `executePipeline(input: RunInput, config: ResolvedConfig, eventBus: EventBus, logger: Logger)` per `pipeline.ts:1523` and `orchestrator.ts:200`.

**Follow `code-standards/SKILL.md`:** Function body max **40 lines**, cyclomatic complexity **7**, nesting depth **3**. If any extracted function exceeds 40 lines, further decompose it. Note that `generation-engine.ts` ~250 LOC and `shared.ts` ~200 LOC are module totals — each file must be split into sub-functions (each ≤40 lines) to meet the rule; a single 250-line function is forbidden.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). The single exported function `executePipeline()` must remain with the same signature `executePipeline(input: RunInput, config: ResolvedConfig, eventBus: EventBus, logger: Logger)`.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, or any other contract file.
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT attempt full EventSourcedPipeline refactor (Option 2/3 from M002 analysis).
- Do NOT create `.md` documentation files.
- Do NOT add exports beyond what `pipeline.ts` currently exports. If `pipeline.ts` currently exports only `executePipeline`, the new `index.ts` must export only `executePipeline`.
- Do NOT introduce module-level state or singletons in the new files.
- Do NOT move `finalizePipeline:575-644`, `enforceCharLimit:262-288`, `estimateTokens:435-441`, or `buildContextInput` (:363-368 inline object) in B1A — deferred to B1D/B2.
- Do NOT move `executeToolRoundWithErrorHandling:717-776` in B1A — B1B owns it.

---

## 5. Files to Modify

| File                                              | Action | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline.ts`                   | MODIFY | Remove generation slice (`buildPromptRequest:67-85`, `initializePipeline:300-476`, `handleProviderError:656-705`, `executeGenerationRound:788-926`); retain tool/retry/error logic until B1B–B1D. In B1A, NOT deleted — legacy streaming path remains until B1E.                                                                                                                                                                                              |
| `packages/core/src/pipeline/index.ts`             | NEW    | Entry point — re-exports `executePipeline`; dispatch on `input.stream` (stream → legacy `../pipeline.legacy.js` or existing `executeStreamingPipeline` until B1E)                                                                                                                                                                                                                                                                                             |
| `packages/core/src/pipeline/shared.ts`            | NEW    | B1A narrowed scope: `buildPromptRequest:67-85` + `initializePipeline:300-476` (including `resolveProfiles` Steps 1–4) only. Deferred to B1D/B2: `enforceCharLimit:262-288`, `estimateTokens:435-441` lambda, `buildContextInput` inline object :363-368, `finalizePipeline:575-644`. Limits `maxMessagesPerProvider:50 / maxContentLengthChars:50_000` now via `ContextPolicy` per ADR-042, not hard-coded in shared.ts — enforce via `config.contextPolicy`. |
| `packages/core/src/pipeline/generation-engine.ts` | NEW    | Generation loop + fallback handling (Step 5 + Step 8) — non-streaming generate call + fallback swap, tool branching excluded; `finishReason==='tool_calls'` returns `PromptResponse` with `toolCalls` for B1B ToolExecutor. `PipelineRoundContext` param object (≤3 params).                                                                                                                                                                                  |
| `packages/core/src/pipeline/non-streaming.ts`     | NEW    | Non-streaming orchestration shell (Steps 1–10 assembly; tool/retry/error logic retained inline until B1B–B1D; `executeToolRoundWithErrorHandling:717-776` NOT moved). `executeWithRetry:826-851` wrapper stays here for B1A (B1C moves to `retry-engine.ts`); imports retry helpers via `policies.ts` L1.                                                                                                                                                     |
| `packages/core/src/orchestrator.ts`               | MODIFY | Update import path at `orchestrator.ts:22` from `'./pipeline.js'` to `'./pipeline/index.js'` for ESM NodeNext. Build verification: `pnpm build` emits `dist/pipeline/index.js` transitive; `tsup.config.ts` has only `src/index.ts` + `testing/mock-provider.ts` entries, pipeline directory is transitive — verify no leak via `grep -r "from.*pipeline" packages/core/dist` (internal, no export).                                                          |

### 5b. Changeset / Versioning Classification

Classification: **internal refactor, no `interfaces.ts` change** → `changeset: patch` or `none`; `api-extractor` diff empty; ADR-039 NOT breaking (no MAJOR). No public type or runtime export changes. Verify with `pnpm changeset` (no changeset required if `none`, or `patch` if repo policy requires one for internal refactors) and `pnpm build && api-extractor` diff check.

---

## 6. Implementation Strategy

### Step 1: Create Directory Structure

- Create `packages/core/src/pipeline/` directory.
- Create placeholder files: `index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`.
- **Streaming interim (B1A):** `pipeline.ts` is NOT deleted; `pipeline/index.ts` dispatches `if (input.stream) delegate temporarily to legacy` `../pipeline.legacy.js` or existing `executeStreamingPipeline`, which will be moved to `streaming.ts` in B1E. B1A only extracts non-streaming path. Ensure build still resolves both branches.

### Step 2: Extract Shared Generation Helpers (Narrowed Scope)

- Open `packages/core/src/pipeline.ts`.
- Move to `shared.ts` (B1A part) **only**:
  - `buildPromptRequest:67-85` — assembles `PromptRequest` from messages/config/signal (shared by streaming and non-streaming)
  - `initializePipeline:300-476` — Steps 1–4 (INITIALIZED → CONTEXT_INJECTING → CONTEXT_INJECTED → PROMPT_COMPOSED), including `resolveProfiles` Steps 1–4 logic
- **Deferred to B1D/B2 (do NOT move in B1A):**
  - `enforceCharLimit:262-288` — S-5 limits `maxMessagesPerProvider:50 / maxContentLengthChars:50_000` now via `ContextPolicy` per ADR-042, not hard-coded in shared.ts; B1D/B2 wires `config.contextPolicy` instead
  - `estimateTokens:435-441` — local lambda inside `initializePipeline`, stays inline until B1D/B2
  - `buildContextInput` — inline object `:363-368` (`{ prompt, sessionId, metadata }`), not a function — no extraction
  - `finalizePipeline:575-644` — Steps 9–10 COMPLETING/COMPLETED, deferred to B1D/B2
- Maintain exact same function signatures; use `PipelineRoundContext` option object where param count would exceed 3.
- `shared.ts` imports only L0–L1 (`interfaces`, `errors`, `types`, `lifecycle`, `policies`, `prompt-composer`); no L2 imports (`tool-controller`/`hooks`) in B1A — L3 may import L0–L3 per ADR-030, but B1A `shared.ts` restricts to L0–L1 to avoid premature L2 coupling. Ensure imports updated to `./shared.js` where needed and `code-standards/SKILL.md` 40-line/7-complexity/3-nesting limits met (split `shared.ts` ~200 LOC into sub-helpers).

### Step 3: Extract GenerationEngine (Tool Routing Boundary)

- Identify the generation loop and fallback logic in `pipeline.ts` (`executeGenerationRound:788-926` + `handleProviderError:656-705`).
- Move to `generation-engine.ts`:
  - Non-streaming generate call (`activeProvider.generate(promptRequest)`) + fallback swap (`FALLBACKING` → `GENERATING` via `config.fallbackProvider`)
  - **Tool branching excluded:** if `finishReason==='tool_calls'` return `PromptResponse` with `toolCalls` — caller (`non-streaming.ts`) delegates execution to B1B ToolExecutor. Do NOT inline `executeToolRoundWithErrorHandling:717-776` — it stays in `non-streaming.ts` until B1B to avoid twice-move.
  - Fallback/retry separation: `generation-engine.ts` owns fallback swap; retry helpers (`calculateDelay`/`isRetryable`/`MaxRetriesExceededError` + `executeWithRetry:826-851`) stay in `non-streaming.ts` for B1A and are imported via `policies.ts` L1 (B1C moves them to `retry-engine.ts`). Document ordering to avoid circular `generation-engine ↔ non-streaming`.
- Import shared utilities from `./shared.js` via `PipelineRoundContext`.
- Keep signature `executePipeline(input: RunInput, config: ResolvedConfig, eventBus: EventBus, logger: Logger)` per `pipeline.ts:1523` / `orchestrator.ts:200`.

### Step 4: Create Non-Streaming Shell + Barrel (Correct Signature + ESM Import)

- Move the non-streaming pipeline body into `non-streaming.ts` (`executeNonStreamingPipeline()`). Tool/retry/error inline remain until B1B–D; `executeWithRetry:826-851` wrapper stays here for B1A.
- `index.ts` dispatches on `input.stream` with **correct signature order** (`input` first, per `pipeline.ts:1523` and `orchestrator.ts:200`):

  ```typescript
  export async function executePipeline(
    input: RunInput,
    config: ResolvedConfig,
    eventBus: EventBus,
    logger: Logger,
  ): Promise<RunOutput | AsyncIterable<StreamChunk>> {
    if (input.stream) {
      // B1A interim: delegate to legacy streaming path until B1E moves it to streaming.ts
      // Option: return (await import('../pipeline.legacy.js')).executeStreamingPipeline(input, config, eventBus, logger)
      // or re-export existing executeStreamingPipeline from its current location
      return executeStreamingPipeline(input, config, eventBus, logger);
    }
    return executeNonStreamingPipeline(input, config, eventBus, logger);
  }
  ```

- Update `orchestrator.ts:22` import from `'./pipeline.js'` to `'./pipeline/index.js'` for ESM NodeNext.
- Build verification: `pnpm build` emits `dist/pipeline/index.js` transitive (pipeline directory is transitive — `tsup.config.ts` has only `src/index.ts` + `testing/mock-provider.ts` entries). Verify no leak via `grep -r "from.*pipeline" packages/core/dist` (internal, no export); `api-extractor` diff empty.
- Enforce `code-standards/SKILL.md`: barrel ≤40 lines; `generation-engine.ts` ~250 LOC and `shared.ts` ~200 LOC must be split into sub-functions (each ≤40 lines, complexity 7, nesting 3).

### Step 5: Verify (No Test Modification)

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`.
- ALL tests must pass WITHOUT modification. This is a pure refactor — no behavioral change.
- Specific checks: `lifecycle.test.ts` invalid transition suite must pass (`lifecycle.ts:VALID_TRANSITIONS` per ADR-031 `state-machine.md` authoritative — spec is source of truth).
- Verify `pnpm changeset` classification (`patch` or `none`) and `pnpm build` transitive output.

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm changeset
```

Specific assertions to verify:

- `packages/core/src/pipeline/generation-engine.ts` and `shared.ts` exist and contain the generation helpers (`shared.ts` restricted to `buildPromptRequest:67-85` + `initializePipeline:300-476` in B1A).
- `packages/core/src/pipeline/non-streaming.ts` exists; `executeToolRoundWithErrorHandling:717-776` NOT moved (still inline until B1B).
- `packages/core/src/orchestrator.ts:22` imports from `'./pipeline/index.js'` (ESM NodeNext).
- `executePipeline(input: RunInput, config: ResolvedConfig, eventBus: EventBus, logger: Logger)` has the exact same function signature as before (`pipeline.ts:1523` / `orchestrator.ts:200` — `input` first, not `config` first).
- No new exports are added to `@atisse/core` public API; `api-extractor` diff empty.
- `pnpm build` emits `dist/pipeline/index.js` transitive; `grep -r "from.*pipeline" packages/core/dist` shows no leak (internal, no export); `tsup.config.ts` entries unchanged (`src/index.ts` + `testing/mock-provider.ts`).
- `lifecycle.test.ts` invalid transition suite passes (`lifecycle.ts:VALID_TRANSITIONS` per ADR-031 `state-machine.md` authoritative).
- Changeset classification: `patch` or `none` (internal refactor, no `interfaces.ts` change).
- No behavioral change — test coverage and assertions remain identical; all tests pass without modification.

**Troubleshooting:** If a test fails because it mocks an internal function from `pipeline.ts`:

- Do NOT modify test behavioral assertions; if a test mocks `pipeline.ts` internals, add a re-export shim in `pipeline/index.ts` for one commit, not a test edit — tests must pass without modification per ADR-039 atomicity. Example shim: `export { buildPromptRequest } from './shared.js'` only if the mock imports it, removed in B1B when stable. The internal restructuring should be transparent to test assertions.

---

## 8. Risk Assessment

| Risk                                                        | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Largest refactor in v1.1.0 — highest surface for regression | Medium     | High   | B1A is 1/5 of B1 (ADR-039): atomic scope shrinks blast radius per commit. Tests pass without modification.                                                                                                                                                               |
| Imports in `orchestrator.ts` may reference the wrong path   | Low        | High   | Update `orchestrator.ts:22` from `'./pipeline.js'` to `'./pipeline/index.js'` explicitly; verify with `pnpm typecheck` and `pnpm build` (`dist/pipeline/index.js` transitive).                                                                                           |
| Internal mocking in tests references pipeline internals     | Medium     | Medium | Do NOT modify test behavioral assertions; add re-export shim in `pipeline/index.ts` for one commit if needed — tests must pass without modification per ADR-039.                                                                                                         |
| Circular dependency introduced by shared.ts                 | Low        | High   | `shared.ts` imports only L0–L1 (`interfaces`, `errors`, `types`, `lifecycle`, `policies`, `prompt-composer`); no L2 imports (`tool-controller`/`hooks`) in B1A. L3 may import L0–L3 per ADR-030 — B1A restriction is intentional, not a layer rule.                      |
| M002 extracted functions have wrong signatures for B1 reuse | Low        | Medium | Review M002 function signatures before extraction; adjust if needed (no behavioral change). Ensure `executePipeline(input, config, eventBus, logger)` order per `pipeline.ts:1523`.                                                                                      |
| Duplication persists until B15 — manual sync required       | Medium     | Medium | Duplication persists until B15 — manual sync required between `non-streaming.ts` and legacy streaming path (init/finalize duplicated in three places until B15 eliminates via `RoundExecutionStrategy`). Keep streaming and non-streaming init/finalize in sync by hand. |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow (steps 1–10), Layer Architecture diagram (ADR-030), `pipeline.ts` vs `orchestrator.ts`
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 7 (Small Core, Large Ecosystem)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines, complexity 7, nesting 3, param count ≤3 (options object)
- `.opencode/skill/interfaces/SKILL.md` — `ResolvedConfig`, `RunInput`, `RunOutput`, `EventBus` types
- `DECISION-LOG.md` — ADR-039 (B1A–B1E atomic split; B15 closure), ADR-030 (L3 may import L0–L3), ADR-031 (`state-machine.md` authoritative), ADR-042 (`ContextPolicy` S-5 `maxMessagesPerProvider:50 / maxContentLengthChars:50_000`)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1–2.2 (split rationale, target architecture)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/gemini-technical-analysis.md` — §2.1 (atomic segmentation)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior extraction of `initializePipeline()`, `executeToolRound()`, `finalizePipeline()` (correct path; `_archive/000-superseded-b1-pipeline-decomposition.md` is the superseded B1 archive)
- `packages/core/src/pipeline.ts` — Source file to decompose (`buildPromptRequest:67-85`, `initializePipeline:300-476`, `handleProviderError:656-705`, `executeGenerationRound:788-926`, `executeToolRoundWithErrorHandling:717-776`, `executeWithRetry:826-851`, `finalizePipeline:575-644` deferred)
- `packages/core/src/orchestrator.ts` — Consumer of pipeline entry point (`:22` import, `:200` call site)
- `packages/core/src/lifecycle.ts` — `VALID_TRANSITIONS` per ADR-031
- `packages/core/src/policies.ts` — L1 retry helpers (`calculateDelay`, `isRetryable`, `MaxRetriesExceededError`, `executeWithRetry`) — B1C moves to `retry-engine.ts`
- `M07-B1B-pipeline-tool-executor.md`, `M08-B1C-pipeline-retry-engine.md`, `M09-B1D-pipeline-error-mapper.md`, `M10-B1E-pipeline-streaming-engine.md` — Sibling sub-milestones (B1B–B1E) — note `streaming.ts` is the canonical name per §4.1 target, `streaming-engine.ts` is stale alias for B1E
