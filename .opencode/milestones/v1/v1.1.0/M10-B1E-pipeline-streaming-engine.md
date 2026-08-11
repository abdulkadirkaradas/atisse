# B1E — StreamingEngine (Pipeline Decomposition, Part 5 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit. B1E completes the `pipeline/` decomposition begun in B1A.

---

## 1. Task Summary

Extract the **StreamingEngine** — the streaming workflow — from `packages/core/src/pipeline.ts` into `packages/core/src/pipeline/`:

1. Create `streaming.ts` — `executeStreamingPipeline()` orchestration (async generator).
2. Extract streaming-specific logic into `streaming-engine.ts`: the async generator, chunk consumption, streaming tool execution (blocking — never streamed), and streaming-specific completion (Step 5–6 streaming + finalization).
3. Reuse `initializePipeline()`, `executeToolRound()` (B1B `ToolExecutor`), `finalizePipeline()`, and `handleOrchestratorError()` (B1D `ErrorNormalizer`) from `shared.ts` / the engines.
4. Complete the `index.ts` dispatch: `input.stream === true` → `executeStreamingPipeline()`.
5. Preserve the streaming dispatch guard preconditions (checked at `run()` entry): `provider.capabilities.streaming === false` → forbidden, `provider.generateStream === undefined` → forbidden, `fallbackProvider` configured → forbidden (`ConfigValidationError`).
6. Public API unchanged — no consumer-visible changes.

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` is 1547 lines — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). Streaming orchestration is one of six distinct concerns embedded in that single file (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)**.

B1E also relocates the streaming half of the **~250 lines of duplication** between streaming and non-streaming paths (shared initialization and finalization logic copy-pasted with subtle variations). Relocating is not eliminating — B15 is the terminal closure point that unifies the round-execution loop behind `RoundExecutionStrategy` (ADR-039 part 3; `claude-technical-analysis.md` Finding 1.3).

Key behavioral facts that must be preserved:

- Streaming is a mode of `run()` (ADR-006) — the streaming path reuses the same shared steps 1–4 and the same lifecycle/event/hook contracts.
- Stream chunk contract: `{ type: 'text', delta }`, `{ type: 'tool_call' }`, `{ type: 'tool_result' }`, `{ type: 'done', usage? }`, `{ type: 'error' }` — per `interfaces-core.md` `StreamChunk` discriminated union.
- Tool execution in streaming is synchronous and blocking — never streamed; `executeToolRound()` (B1B `ToolExecutor`) is reused.
- `afterGenerate` fires after the `'done'` chunk is received; the response holds accumulated text and usage from the completed stream.
- Preconditions at `run()` entry throw `ConfigValidationError` for non-streaming-capable providers, missing `generateStream`, or configured `fallbackProvider` (streaming + fallback is forbidden in v1 — ADR-017 / `constraints.md`).

---

## 3. Issues/Changes

### Issue B1E-1: StreamingEngine embedded in a God Module

| Field       | Value                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                        |
| Lines       | 1–1547 (entire file); streaming workflow spans Steps 5–6 (streaming) + completion                                      |
| Severity    | HIGH                                                                                                                   |
| Description | Streaming async generator, streaming tool execution, and streaming completion are embedded in a single 1547-line file. |
| Fix         | Extract into `pipeline/streaming.ts` + `pipeline/streaming-engine.ts`. Pure restructuring — no behavioral change.      |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

- Create `packages/core/src/pipeline/streaming.ts` hosting `executeStreamingPipeline()` — the async-generator orchestration.
- Create `packages/core/src/pipeline/streaming-engine.ts` hosting the `StreamingEngine` module: generator mechanics, chunk consumption, streaming tool execution, streaming completion.
- Reuse shared helpers and engines:
  - `initializePipeline()` (Steps 1–4) from `shared.ts` (B1A)
  - `executeToolRound()` via `ToolExecutor` (B1B) — blocking tool execution, never streamed
  - `handleOrchestratorError()` via `ErrorNormalizer` (B1D)
  - `finalizePipeline()` from `shared.ts` — after `'done'` chunk; `afterGenerate` fires with accumulated output
- Complete the `index.ts` dispatch so `input.stream === true` routes to `executeStreamingPipeline()` (B1A left a placeholder branch for this).
- Preserve the streaming dispatch guard (checked at `run()` entry, `ConfigValidationError` if violated):
  - `provider.capabilities.streaming === false` → forbidden
  - `provider.generateStream === undefined` → forbidden
  - `fallbackProvider` configured → forbidden (see `constraints.md`; ADR-017)
- All state remains local per call (Principle 4 — Stateless Core). No module-level state.
- Follow function body max 40 lines (per `implementation-standards.md`). Decompose further if exceeded.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). `executePipeline()` must remain the single exported function with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, or any other contract file — the `StreamChunk` union is frozen.
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT stream tool execution — tools remain synchronous and blocking.
- Do NOT change `afterGenerate` timing (must fire after the `'done'` chunk).
- Do NOT change the streaming + fallback dispatch guard.
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files.

---

## 5. Files to Modify

| File                                             | Action | Notes                                                                                   |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/streaming.ts`        | NEW    | `executeStreamingPipeline()` — async-generator orchestration                            |
| `packages/core/src/pipeline/streaming-engine.ts` | NEW    | `StreamingEngine` module — generator mechanics, chunk consumption, streaming completion |
| `packages/core/src/pipeline.ts`                  | MODIFY | Remove streaming slice (Steps 5–6 streaming + streaming completion)                     |
| `packages/core/src/pipeline/index.ts`            | MODIFY | Complete dispatch: `input.stream === true` → `executeStreamingPipeline()`               |

---

## 6. Implementation Strategy

### Step 1: Create `streaming-engine.ts`

- Create `packages/core/src/pipeline/streaming-engine.ts`.
- Move the streaming generator body, chunk consumption, and streaming completion logic from `pipeline.ts`, preserving exact behavior.

### Step 2: Create `streaming.ts`

- Create `packages/core/src/pipeline/streaming.ts` hosting `executeStreamingPipeline()`.
- Reuse `initializePipeline()`, `ToolExecutor` (B1B), `ErrorNormalizer` (B1D), and `finalizePipeline()`.

### Step 3: Complete the Barrel Dispatch

- In `pipeline/index.ts`, replace the B1A placeholder streaming branch with a call to `executeStreamingPipeline()`.

### Step 4: Verify

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

- `packages/core/src/pipeline/streaming.ts` and `streaming-engine.ts` exist.
- `packages/core/src/pipeline.ts` no longer exists (or is replaced by a barrel re-export only) — B1E completes the B1 removal of the original god module.
- `index.ts` dispatches `input.stream === true` to `executeStreamingPipeline()`.
- Streaming chunk order is identical: `text` → `tool_call` → (blocking tool) `tool_result` → resume → `done`; `error` chunk terminates the stream.
- Tool execution in streaming remains blocking — never streamed.
- `afterGenerate` fires after the `'done'` chunk with accumulated text and usage.
- Streaming dispatch guard unchanged (`ConfigValidationError` for the three forbidden preconditions).
- `executePipeline()` has the exact same function signature as before; no new public exports.
- All tests pass without modification.

---

## 8. Risk Assessment

| Risk                                             | Likelihood | Impact | Mitigation                                                                                         |
| ------------------------------------------------ | ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| Streaming behavior regression during extraction  | Medium     | High   | All streaming tests pass without modification; generator mechanics preserved verbatim.             |
| Chunk order or `afterGenerate` timing changed    | Low        | High   | Preserve `afterGenerate`-after-`'done'` ordering; chunk union untouched.                           |
| Dispatch guard bypassed in barrel wiring         | Low        | High   | Guard stays at `run()` entry (orchestrator.ts) — B1E only moves the streaming body, not the guard. |
| Streaming tool execution accidentally streamed   | Low        | Medium | `ToolExecutor` (B1B) reused — tools remain synchronous/blocking.                                   |
| Duplication persists (relocated, not eliminated) | High       | Medium | Expected per ADR-039: B15 is the terminal closure for the ~250-line duplication (Finding 1.2/1.3). |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Streaming Execution Flow section, Timeout Enforcement
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 7 (Small Core, Large Ecosystem)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `.opencode/skill/interfaces/SKILL.md` — `StreamChunk` discriminated union, `AIProvider.generateStream?`
- `.opencode/skill/interfaces/SKILL.md` — `ResolvedConfig`, `RunInput`, `RunOutput`, `EventBus` types
- `.opencode/skill/constraints/SKILL.md` — `stream: true` + `fallbackProvider` forbidden
- `DECISION-LOG.md` — ADR-006 (streaming is a mode of `run()`), ADR-017 (streaming + fallback), ADR-039 (B1E atomic split; B15 closure)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1–2.2 (Streaming orchestration concern)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/claude-technical-analysis.md` — Finding 1.3 (duplication relocated, B15 closure)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior extraction of `finalizePipeline()`
- `packages/core/src/pipeline.ts` — Source file to decompose
- `M06-B1A-pipeline-generation-engine.md`, `M07-B1B-pipeline-tool-executor.md`, `M08-B1C-pipeline-retry-engine.md`, `M09-B1D-pipeline-error-mapper.md` — Preceding sub-milestones (B1A–B1D)
- `M12-B15-round-execution-strategy.md` — Terminal closure (round-loop unification)
