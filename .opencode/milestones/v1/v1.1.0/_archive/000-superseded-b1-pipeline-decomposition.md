# B1 — Pipeline Internal Decomposition

> **SUPERSEDED — ARCHIVE ONLY (ADR-039)**
>
> This milestone has been split into five atomic sub-milestones per ADR-039.
> Do NOT implement B1 from this file — the original content is preserved below for reference only.
> Active plans:
>
> - B1A GenerationEngine → `M06-B1A-pipeline-generation-engine.md`
> - B1B ToolExecutor → `M07-B1B-pipeline-tool-executor.md`
> - B1C RetryEngine → `M08-B1C-pipeline-retry-engine.md`
> - B1D ErrorMapper → `M09-B1D-pipeline-error-mapper.md`
> - B1E StreamingEngine → `M10-B1E-pipeline-streaming-engine.md`
> - B15 RoundExecutionStrategy consolidation → `M12-B15-round-execution-strategy.md`
>
> Status of this file: superseded; retained as archive (no content removed).

**Status:** SUPERSEDED (archived — see banner above)
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Refactor `packages/core/src/pipeline.ts` (~1547 lines, the largest file in core by 3.4×) into a `pipeline/` directory with focused sub-modules:

1. Create `packages/core/src/pipeline/` directory with `index.ts`, `shared.ts`, `non-streaming.ts`, `streaming.ts`.
2. Extract common helpers (used by both streaming and non-streaming paths) into `shared.ts` — `buildPromptRequest()`, `handleOrchestratorError()`, `resolveProfiles()` (already partially extracted by M002).
3. Separate the non-streaming pipeline into `non-streaming.ts` — the retry loop, tool execution loop, and completion logic.
4. Separate the streaming pipeline into `streaming.ts` — the async generator, tool-execution-in-streaming, and streaming-specific completion.
5. Keep `executePipeline()` as the single exported entry point from `pipeline/index.ts`.
6. Public API unchanged — no consumer-visible changes.

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` is 1547 lines — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). It contains:

- Execution orchestration
- Retry handling and timeout management
- Tool execution
- Streaming workflows (async generator)
- Event emission
- Lifecycle transitions
- Fallback handling
- Error normalization
- Hook execution

...all in one file.

This violates **Principle 7 (Small Core, Large Ecosystem)** — the core itself is not small. It also causes:

- **High merge conflict frequency** — every pipeline change touches the same file.
- **Reduced maintainability** — a developer must understand the entire file to change one step.
- **Increased regression probability** — shared variables and inline state make it easy to introduce bugs.
- **~250 lines of duplication** between streaming and non-streaming paths (shared initialization and finalization logic copy-pasted with subtle variations).

The earlier M002 consolidation (Option 1 — Minimal Consolidation) extracted `initializePipeline()`, `executeToolRound()`, and `finalizePipeline()` as helpers within the same file. B1 goes further: full module decomposition into a `pipeline/` directory, building upon M002's extracted functions.

---

## 3. Issues/Changes

### Issue B1-1: Pipeline is a God Module

| Field       | Value                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                           |
| Lines       | 1–1547 (entire file)                                                                                                      |
| Severity    | HIGH                                                                                                                      |
| Description | Single file contains all execution logic. 1547 lines. ~250 lines duplication between streaming and non-streaming paths.   |
| Fix         | Refactor into `pipeline/` directory with `index.ts`, `shared.ts`, `non-streaming.ts`, `streaming.ts`. Pure restructuring. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**Directory structure:**

```
packages/core/src/pipeline/
├── index.ts          — re-exports executePipeline() and any other public symbols
├── shared.ts         — common helpers shared by streaming and non-streaming
├── non-streaming.ts  — executeNonStreamingPipeline() and its sub-functions
└── streaming.ts      — executeStreamingPipeline() and its sub-functions
```

**Module responsibilities:**

| Module             | Responsibility                                                                                   | Approx. LOC |
| ------------------ | ------------------------------------------------------------------------------------------------ | ----------- |
| `index.ts`         | Barrel export — `export { executePipeline } from './non-streaming.js'` (or streaming-router)     | ~10         |
| `shared.ts`        | `buildPromptRequest()`, `handleOrchestratorError()`, `resolveProfiles()`, `buildContextInput()`  | ~200        |
| `non-streaming.ts` | Full non-streaming pipeline: Steps 1–10, retry loop, tool loop, completion                       | ~650        |
| `streaming.ts`     | Full streaming pipeline: Steps 1–4 shared, step 5 async generator, tool-in-streaming, completion | ~650        |

**All state remains local per call (Principle 4 — Stateless Core).** No module-level state in any of the new files.

**Shared routing:** `index.ts` (or `non-streaming.ts`) determines whether to call `executeNonStreamingPipeline()` or `executeStreamingPipeline()` based on `input.stream`. The current `pipeline.ts` already has this dispatch logic — it moves to `index.ts` or remains in the entry point.

**Build upon M002 extracted helpers:** The M002 consolidation already extracted `initializePipeline()`, `executeToolRound()`, `finalizePipeline()` within the current pipeline.ts. B1 should:

1. Move these extracted functions to `shared.ts`.
2. Import and call them from both `non-streaming.ts` and `streaming.ts`.
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

| File                                          | Action | Notes                                                                                                                             |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline.ts`               | DELETE | Replace with barrel re-export from `pipeline/index.ts`                                                                            |
| `packages/core/src/pipeline/index.ts`         | NEW    | Entry point — re-exports `executePipeline`                                                                                        |
| `packages/core/src/pipeline/shared.ts`        | NEW    | Common helpers: `buildPromptRequest`, `handleOrchestratorError`, `resolveProfiles`, `buildContextInput`, M002-extracted functions |
| `packages/core/src/pipeline/non-streaming.ts` | NEW    | Non-streaming pipeline: Steps 1–10 in detail                                                                                      |
| `packages/core/src/pipeline/streaming.ts`     | NEW    | Streaming pipeline: async generator, streaming tool execution                                                                     |
| `packages/core/src/orchestrator.ts`           | MODIFY | Update import path from `./pipeline.js` to `./pipeline/index.js`                                                                  |

---

## 6. Implementation Strategy

### Step 1: Create Directory Structure

- Create `packages/core/src/pipeline/` directory.
- Create empty placeholder files: `index.ts`, `shared.ts`, `non-streaming.ts`, `streaming.ts`.

### Step 2: Extract Shared Module

- Open `packages/core/src/pipeline.ts`.
- Identify all functions/utilities used by BOTH streaming and non-streaming paths:
  - `buildPromptRequest()` — assembles `PromptRequest` from config, messages, and input
  - `handleOrchestratorError()` — normalizes errors, emits `run.failed`
  - `resolveProfiles()` — profile resolution logic (may already be in `profile.ts`)
  - `buildContextInput()` — builds the `ContextProviderInput` from `RunInput`
  - M002-extracted functions: `initializePipeline()` (Steps 1–4), `executeToolRound()` (Step 6), `finalizePipeline()` (Steps 9–10)
  - `estimateTokens()` — token estimation utility (may already be duplicated between `pipeline.ts` and `prompt-composer.ts`)
  - `enforceCharLimit()` — context length enforcement
- Move these to `shared.ts`, maintaining exact same function signatures.
- Ensure all imports are updated to reference `./shared.js` where needed.

### Step 3: Extract Non-Streaming Pipeline

- Identify the non-streaming pipeline body in `pipeline.ts` (the `executePipeline()` function).
- Move to `non-streaming.ts`.
- Import shared utilities from `./shared.js`.
- Structure `executeNonStreamingPipeline()` in a clean sequence calling shared functions:

  ```typescript
  export async function executeNonStreamingPipeline(
    config: ResolvedConfig,
    input: RunInput,
    eventBus: EventBus,
    logger: Logger,
  ): Promise<RunOutput> {
    // Step 1: INITIALIZED
    const { stateMachine, runId, contextProviderInput /* ... */ } = initializePipeline(
      config,
      input,
      eventBus,
      logger,
    );

    try {
      // Step 2-3: CONTEXT_INJECTING + CONTEXT_INJECTED
      const { contextMessages, memoryMessages, userMessage } = await loadContextAndMemory(
        config,
        contextProviderInput /* ... */,
      );

      // Step 4: PROMPT_COMPOSED
      const messages = composePrompt(config, contextMessages, memoryMessages, userMessage);

      // Step 5-8: GENERATING + retry loop + TOOL_EXECUTING + FALLBACKING
      const result = await executeGenerationLoop(
        config,
        messages,
        input,
        stateMachine,
        runId,
        eventBus,
        logger,
      );

      // Step 9-10: COMPLETING + COMPLETED
      return await finalizePipeline(config, result, stateMachine, runId, eventBus, logger);
    } catch (error) {
      return handleOrchestratorError(error, stateMachine, runId, eventBus, logger);
    }
  }
  ```

- Decompose any function exceeding 40 lines (e.g., the generation+retry+tool loop) into smaller helpers.

### Step 4: Extract Streaming Pipeline

- Identify the streaming pipeline body in `pipeline.ts` (the `executeStreamingPipeline()` function).
- Move to `streaming.ts`.
- Import shared utilities from `./shared.js`.
- Reuse `initializePipeline()`, `executeToolRound()`, and `finalizePipeline()` from `shared.ts`.
- Structure `executeStreamingPipeline()`:
  ```typescript
  export async function executeStreamingPipeline(
    config: ResolvedConfig,
    input: RunInput,
    eventBus: EventBus,
    logger: Logger,
  ): Promise<AsyncIterable<StreamChunk>> {
    // ... async generator implementation using shared helpers
  }
  ```

### Step 5: Create `index.ts` Barrel and Wire Up

- `index.ts`:

  ```typescript
  import { executeNonStreamingPipeline } from './non-streaming.js';
  import { executeStreamingPipeline } from './streaming.js';
  import type {
    ResolvedConfig,
    RunInput,
    RunOutput,
    StreamChunk,
    EventBus,
    Logger,
  } from '../interfaces.js';

  export async function executePipeline(
    config: ResolvedConfig,
    input: RunInput & { stream?: boolean },
    eventBus: EventBus,
    logger: Logger,
  ): Promise<RunOutput | AsyncIterable<StreamChunk>> {
    if (input.stream) {
      return executeStreamingPipeline(config, input, eventBus, logger);
    }
    return executeNonStreamingPipeline(config, input, eventBus, logger);
  }
  ```

- Update `orchestrator.ts` import from `'./pipeline.js'` to `'./pipeline/index.js'`.
- Delete the original `packages/core/src/pipeline.ts` only AFTER verifying the new structure works.

### Step 6: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
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

- `packages/core/src/pipeline.ts` no longer exists (or is replaced by barrel re-export only).
- `packages/core/src/orchestrator.ts` imports from `'./pipeline/index.js'`.
- All existing tests pass without any modification.
- `executePipeline()` has the exact same function signature as before.
- No new exports are added to `@atisse/core` public API.
- No behavioral change — test coverage and assertions remain identical.

**Troubleshooting:** If a test fails because it mocks an internal function from `pipeline.ts`:

- Do NOT modify the test's behavioral assertions.
- Update the test's import path to point to the new module location.
- The internal restructuring should be transparent to test assertions.

---

## 8. Risk Assessment

| Risk                                                        | Likelihood | Impact | Mitigation                                                                                  |
| ----------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| Largest refactor in v1.1.0 — highest surface for regression | Medium     | High   | All tests pass without modification; pure restructuring preserves behavior.                 |
| Imports in `orchestrator.ts` may reference the wrong path   | Low        | High   | Update import path explicitly in Step 5; verify with `pnpm typecheck`.                      |
| Internal mocking in tests references pipeline internals     | Medium     | Medium | Update test imports only — preserve all behavioral assertions.                              |
| Circular dependency introduced by shared.ts                 | Low        | High   | `shared.ts` imports only from Layer 0–1 (`interfaces.ts`, `errors.ts`, `policies.ts`).      |
| M002 extracted functions have wrong signatures for B1 reuse | Low        | Medium | Review M002 function signatures before extraction; adjust if needed (no behavioral change). |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow (steps 1–10), Layer Architecture diagram, `pipeline.ts` vs `orchestrator.ts`
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 7 (Small Core, Large Ecosystem)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `.opencode/skill/interfaces/SKILL.md` — Frozen public contracts (no interface changes)
- `.opencode/skill/interfaces/SKILL.md` — `ResolvedConfig`, `RunInput`, `RunOutput`, `EventBus` types
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior extraction of `initializePipeline()`, `executeToolRound()`, `finalizePipeline()`
- `packages/core/src/pipeline.ts` — Source file to decompose
- `packages/core/src/orchestrator.ts` — Consumer of pipeline entry point
