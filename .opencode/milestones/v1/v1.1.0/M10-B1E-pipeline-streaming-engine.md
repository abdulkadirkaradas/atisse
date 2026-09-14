# B1E — StreamingEngine (Pipeline Decomposition, Part 5 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit. B1E completes the `pipeline/` decomposition begun in B1A.

---

## 1. Task Summary

> **Precondition:** B1A+B+C+D merged, `pipeline/` exists (`index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`, `tool-executor.ts`, `retry-engine.ts`, `error-normalizer.ts`), `pnpm typecheck && pnpm build` green — All `pipeline.ts:XXX` refs are post-B1D, verified. B1E extracts from `pipeline/*` shell not monolith `pipeline.ts:1547`. Repo currently has no `pipeline/` directory (only doc commits), verify skeleton first.

Extract the **StreamingEngine** — the streaming workflow — from `packages/core/src/pipeline/*` shell (post-B1D; pre-B1A `packages/core/src/pipeline.ts:1547`) into `packages/core/src/pipeline/`:

1. Create `streaming.ts` — `executeStreamingPipeline()` orchestration (async generator).
2. Extract streaming-specific logic into `streaming-engine.ts`: the async generator, chunk consumption, streaming tool execution (blocking — never streamed), and streaming-specific completion (Step 5–6 streaming + finalization).
3. Reuse `initializePipeline()`, `executeToolRound()` (B1B `ToolExecutor`), `finalizePipeline()`, and `handleOrchestratorError()` (B1D `ErrorNormalizer`) from `shared.ts` / the engines.
4. Complete the `index.ts` dispatch: `input.stream === true` → `executeStreamingPipeline()`.
5. Preserve the streaming dispatch guard preconditions (checked at `run()` entry): `provider.capabilities.streaming === false` → forbidden, `provider.generateStream === undefined` → forbidden, `fallbackProvider` configured → forbidden (`ConfigValidationError`).
6. Public API unchanged — no consumer-visible changes. Classification: internal refactor (see §5b).

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` was 1547 lines pre-B1A — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). Post-B1D the monolith is split into `pipeline/` (`index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`, `tool-executor.ts`, `retry-engine.ts`, `error-normalizer.ts`). Streaming orchestration is one of six distinct concerns embedded in that single file (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)**.

B1E also relocates the streaming half of the **~250 lines of duplication** between streaming and non-streaming paths (shared initialization and finalization logic copy-pasted with subtle variations). Relocating is not eliminating — B15 is the terminal closure point that unifies the round-execution loop behind `RoundExecutionStrategy` (ADR-039 part 3; `claude-technical-analysis.md` Finding 1.3).

Key behavioral facts that must be preserved:

- Streaming is a mode of `run()` (ADR-006) — the streaming path reuses the same shared steps 1–4 and the same lifecycle/event/hook contracts (`lifecycle.ts:8-20` `VALID_TRANSITIONS`, `hooks.ts:11` `runHooks` afterGenerate serial per ADR-027).
- Stream chunk contract — full discriminated union `interfaces.ts:286-291`: `{ type: 'text', delta: string }`, `{ type: 'tool_call', id, name, arguments }`, `{ type: 'tool_result', toolCallId, result }`, `{ type: 'done', usage?: TokenUsage }`, `{ type: 'error', error: EventErrorPayload }` — `done` carries optional `usage?: TokenUsage` only. `finishReason` mapping `pendingToolCalls.length > 0 ? 'tool_calls' : 'stop'` at `pipeline.ts:1227` (post-B1D — re-verify) and `accumulatedUsage` mutate `1207-1209` (post-B1D — re-verify) preserved; `length` finishReason not used in streaming (existing behavior).
- Tool execution in streaming is synchronous and blocking — never streamed; `executeToolRound()` (B1B `ToolExecutor`) is reused.
- `afterGenerate` fires after the `'done'` chunk is received (`pipeline.ts:1454` per ADR-027); the response holds accumulated text and usage from the completed stream.
- Preconditions at `run()` entry throw `ConfigValidationError` for non-streaming-capable providers, missing `generateStream`, or configured `fallbackProvider` (streaming + fallback is forbidden in v1 — ADR-017 / `constraints.md`). Dispatch guard ownership: primary at `orchestrator.ts:165-182`, duplicate at `pipeline.ts:1137-1142` remains as defense-in-depth secondary (see §4.1).

---

## 3. Issues/Changes

### Issue B1E-1: StreamingEngine embedded in a God Module

| Field       | Value                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/*` shell (pre-B1A `packages/core/src/pipeline.ts:1547`; post-B1D `pipeline/shared.ts` + `pipeline/index.ts` + `pipeline/*.ts`)                                                                      |
| Lines       | B1E focus `1083-1511` (`executeStreamingGenerationRound:1092-1341` + `executeStreamingPipeline:1352-1512` + `asyncIteratorWithIdleTimeout:108-144`) within 1–1547 total (per `architecture` SKILL 22 `pipeline.ts ~1500 lines`) |
| Severity    | HIGH                                                                                                                                                                                                                            |
| Description | Streaming async generator, streaming tool execution, and streaming completion are embedded in the pipeline shell.                                                                                                               |
| Fix         | Extract into `pipeline/streaming.ts` + `pipeline/streaming-engine.ts`. Pure restructuring — no behavioral change.                                                                                                               |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

> **Precondition:** B1A+B+C+D merged, `pipeline/` exists, `pnpm typecheck && pnpm build` green — All `pipeline.ts:XXX` refs are post-B1D, verified. B1E extracts from `pipeline/*` shell not monolith `pipeline.ts:1547`.

- Create `packages/core/src/pipeline/streaming.ts` hosting `executeStreamingPipeline()` — the async-generator orchestration (L3, imports L0–L2 only).
- Create `packages/core/src/pipeline/streaming-engine.ts` hosting the `StreamingEngine` module: `executeStreamingGenerationRound()` + `asyncIteratorWithIdleTimeout` handling — generator mechanics, chunk consumption, streaming tool execution, streaming completion.

- **Naming consistency (two-file resolution):** Keep two files `streaming.ts` + `streaming-engine.ts` per `architecture/SKILL.md:46-51` target (two files). Stale M06-B1A note "use streaming.ts consistently, not streaming-engine.ts" is superseded — architecture target lists both files, B1A reference marked stale.

- **Layering / circular (ADR-030):** `streaming.ts` (L3) may import `shared.ts`, `tool-executor.ts`, `error-normalizer.ts`, `policies.ts` (L1), `lifecycle.ts` (L1). `streaming-engine.ts` (L3) may import same L0–L1 + `tool-executor`. Neither may import `generation-engine.ts`/`retry-engine.ts` bidirectionally. Verify `madge --circular packages/core/src/pipeline/streaming.ts packages/core/src/pipeline/streaming-engine.ts` — zero cycles.

- Reuse shared helpers and engines:
  - `initializePipeline()` (Steps 1–4) from `shared.ts` (B1A)
  - `executeToolRound()` via `ToolExecutor` (B1B) — blocking tool execution, never streamed
  - `handleOrchestratorError()` via `ErrorNormalizer` (B1D)
  - `finalizePipeline()` from `shared.ts` — after `'done'` chunk; `afterGenerate` fires with accumulated output (`pipeline.ts:1454` per ADR-027, `hooks.ts:11` `runHooks` serial)
- Complete the `index.ts` dispatch so `input.stream === true` routes to `executeStreamingPipeline()` (B1A left a placeholder branch for this).

- **Streaming correctness — idle timeout and totalTimeoutMs preservation:** Preserve: `asyncIteratorWithIdleTimeout(iterable, config.timeout.generateTimeoutMs, input.signal)` idle timeout per chunk; `generateStream: Promise<AsyncIterable>` pre-stream retry loop — connection error → Promise reject → retryable check → `MaxRetriesExceededError`; mid-stream error chunk → terminal yield `{type:'error'}` + `run.failed`. Streaming path intentionally NOT wrapped in `withTimeout(totalTimeoutMs)` (existing, ADR-026) — document as preserved, not missing.

- **Dispatch guard ownership:** Dispatch guard stays at `run()` entry `orchestrator.ts:165-182` `ConfigValidationError` primary; `pipeline.ts:1137-1142` duplicate guard remains as defense-in-depth secondary — not removed.

- Preserve the streaming dispatch guard (checked at `run()` entry, `ConfigValidationError` if violated):
  - `provider.capabilities.streaming === false` → forbidden
  - `provider.generateStream === undefined` → forbidden
  - `fallbackProvider` configured → forbidden (see `constraints.md`; ADR-017)
- All state remains local per call (Principle 4 — Stateless Core). No module-level state.
- Follow function body max 40 lines (per `code-standards/SKILL.md`). Decompose further if exceeded.
- **ESM / build note:** B1A `orchestrator.ts:22` `'./pipeline/index.js'` and `tsup` transitive note also required for `streaming.ts` — `tsup.config.ts` has only `src/index.ts` + `testing/mock-provider.ts` entries, pipeline directory is transitive; `pnpm build` emits `dist/pipeline/index.js` transitive.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). `executePipeline()` must remain the single exported function with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, or any other contract file — the `StreamChunk` union is frozen (`interfaces.ts:286-291`).
- Do NOT introduce new runtime dependencies (Zod only per `constraints.md` — Hard Stop).
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT stream tool execution — tools remain synchronous and blocking.
- Do NOT change `afterGenerate` timing (must fire after the `'done'` chunk at `pipeline.ts:1454` per ADR-027, `hooks.ts:11` `runHooks` serial).
- Do NOT change the streaming + fallback dispatch guard (`orchestrator.ts:165-182` primary, `pipeline.ts:1137-1142` secondary defense-in-depth).
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files (Principle 4).
- Do NOT introduce `any` types, `console.log`, or module-level state (Principle 4 per `code-standards/SKILL.md`).
- Do NOT create L3↔L3 circular: `streaming.ts`/`streaming-engine.ts` must not import `generation-engine.ts`/`retry-engine.ts` bidirectionally; verify via `madge --circular packages/core/src/pipeline/streaming.ts packages/core/src/pipeline/streaming-engine.ts` (ADR-030) — zero cycles.
- Do NOT wrap streaming path in `withTimeout(totalTimeoutMs)` (ADR-026 — existing intentional).
- Do NOT introduce runtime deps (Zod only), no `any`, no `stream:true+fallback` (ADR-017), error chunk `PipelineInternalError` must not leak secrets (S-1/S-7 via `toEventErrorPayload:55-61` `code/message/retryable` only).
- Do NOT bypass `asyncIteratorWithIdleTimeout` per-chunk idle timeout (`config.timeout.generateTimeoutMs`, `input.signal`).

---

## 5. Files to Modify

> **Precondition:** B1A+B+C+D merged, `pipeline/` exists, `pnpm typecheck && pnpm build` green — All `pipeline.ts:XXX` refs are post-B1D, verified. B1E extracts from `pipeline/*` shell not monolith `pipeline.ts:1547`.

| File                                             | Action | Notes                                                                                             |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/streaming.ts`        | NEW    | `executeStreamingPipeline()` — async-generator orchestration (L3, imports L0–L2 only)             |
| `packages/core/src/pipeline/streaming-engine.ts` | NEW    | `StreamingEngine` — `executeStreamingGenerationRound()` + `asyncIteratorWithIdleTimeout` handling |
| `packages/core/src/pipeline/index.ts`            | MODIFY | Replace B1A placeholder with `input.stream===true → executeStreamingPipeline()` dispatch          |
| `packages/core/src/pipeline/shared.ts`           | MODIFY | No change except import path if needed — `initializePipeline`/`finalizePipeline` already there    |
| `packages/core/src/pipeline.ts`                  | —      | Pre-B1A ref only; post-B1D source is `pipeline/*` shell — remove MODIFY                           |

> **Naming note:** Stale M06-B1A note "use streaming.ts consistently, not streaming-engine.ts" is superseded — architecture target lists both files, B1A reference marked stale.

### 5b. Changeset / Versioning Classification

Classification: internal refactor, no `interfaces.ts` change → changeset `patch|none`, `api-extractor` diff empty, ADR-039 NOT breaking. Verify `pnpm changeset + pnpm build && api-extractor diff`. No public type or runtime export changes.

---

## 6. Implementation Strategy

### Step 1: Create `streaming-engine.ts`

> **Precondition:** B1A+B+C+D merged, `pipeline/` exists, `pnpm typecheck && pnpm build` green — All `pipeline.ts:XXX` refs are post-B1D, verified. B1E extracts from `pipeline/*` shell not monolith `pipeline.ts:1547`.

- Create `packages/core/src/pipeline/streaming-engine.ts`.
- Move the streaming generator body, chunk consumption, and streaming completion logic from `pipeline/*` shell (`executeStreamingGenerationRound:1092-1341` + `asyncIteratorWithIdleTimeout:108-144` — post-B1D — re-verify), preserving exact behavior.
- Layering: `streaming-engine.ts` (L3) may import `shared.ts`, `tool-executor.ts`, `error-normalizer.ts`, `policies.ts` (L1), `lifecycle.ts` (L1); must not import `generation-engine.ts`/`retry-engine.ts` bidirectionally; verify `madge --circular packages/core/src/pipeline/streaming.ts packages/core/src/pipeline/streaming-engine.ts` — zero cycles.
- Preserve idle timeout: `asyncIteratorWithIdleTimeout(iterable, config.timeout.generateTimeoutMs, input.signal)` per chunk; pre-stream retry loop (`generateStream: Promise<AsyncIterable>` → connection error → `isRetryable` → `MaxRetriesExceededError`), mid-stream error chunk → terminal `error` + `run.failed`; intentionally not wrapped in `withTimeout(totalTimeoutMs)` (ADR-026).
- **Duplication note (B15):** `initializePipeline:300-476` + `finalizePipeline:575-644` duplicate is relocated in B1E, not eliminated; B15 `RoundExecutionStrategy` (ADR-039 §1) will eliminate via single loop — reviewer DRY concern is expected until B15.

### Step 2: Create `streaming.ts`

- Create `packages/core/src/pipeline/streaming.ts` hosting `executeStreamingPipeline()` (`1352-1512` — post-B1D — re-verify).
- Reuse `initializePipeline()`, `ToolExecutor` (B1B), `ErrorNormalizer` (B1D), and `finalizePipeline()`.
- Layering: `streaming.ts` (L3) may import `shared.ts`, `tool-executor.ts`, `error-normalizer.ts`, `policies.ts` (L1), `lifecycle.ts` (L1); verify `madge --circular`.
- **Duplication note (B15):** initialize/finalize duplication relocated, not eliminated — B15 will eliminate via `RoundExecutionStrategy`; reviewer DRY concern is expected until B15.

### Step 3: Complete the Barrel Dispatch

- In `pipeline/index.ts`, replace the B1A placeholder streaming branch with a call to `executeStreamingPipeline()`.
- Preserve dispatch guard ownership: primary at `orchestrator.ts:165-182` `ConfigValidationError`, duplicate at `pipeline.ts:1137-1142` remains as defense-in-depth secondary — not removed.
- Build note: `orchestrator.ts:22` `'./pipeline/index.js'` (ESM NodeNext) and `tsup` transitive — `tsup.config.ts` has only `src/index.ts` + `testing/mock-provider.ts` entries, pipeline directory is transitive; verify `pnpm build` emits `dist/pipeline/index.js` transitive.

### Step 4: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage && pnpm build && madge --circular packages/core/src/pipeline/streaming.ts && pnpm changeset`.
- ALL tests must pass WITHOUT modification. This is a pure refactor — no behavioral change.

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
madge --circular packages/core/src/pipeline/streaming.ts
pnpm changeset
```

Specific assertions to verify:

- `packages/core/src/pipeline/streaming.ts` and `streaming-engine.ts` exist per `architecture/SKILL.md:46-51` target (two files).
- `packages/core/src/pipeline.ts` no longer exists as source (post-B1D source is `pipeline/*` shell — B1E completes the B1 removal of the original god module at `pipeline/index.ts`).
- `index.ts` dispatches `input.stream === true` to `executeStreamingPipeline()`; `orchestrator.ts:22` `'./pipeline/index.js'` (ESM NodeNext) and `tsup` transitive verified.
- Streaming chunk order is identical: `text` → `tool_call` → (blocking `tool_result` via `ToolExecutor`) → resume → `done|error` (`interfaces.ts:286`); `done` `usage?: TokenUsage`, `error` `EventErrorPayload`; `finishReason` mapping `pendingToolCalls.length>0 ? 'tool_calls' : 'stop'` at `pipeline.ts:1227` and `accumulatedUsage` mutate `1207-1209` preserved; `length` finishReason not used in streaming (existing).
- Tool execution in streaming remains blocking — never streamed.
- `afterGenerate` fires after the `'done'` chunk with accumulated text and usage (`pipeline.ts:1454` per ADR-027, `hooks.ts:11` `runHooks` serial).
- Streaming dispatch guard unchanged: `stream:true+fallbackProvider` still `ConfigValidationError` at `orchestrator.ts:165` per ADR-017 (`pipeline.ts:1137-1142` duplicate remains as defense-in-depth secondary); `capabilities.streaming === false` and `generateStream === undefined` also `ConfigValidationError`.
- Idle timeout preserved: `asyncIteratorWithIdleTimeout(iterable, config.timeout.generateTimeoutMs, input.signal)` per chunk; pre-stream retry loop connection error → `MaxRetriesExceededError`; mid-stream error chunk terminal + `run.failed`; intentionally not wrapped in `withTimeout(totalTimeoutMs)` (ADR-026) — document as preserved.
- MockProvider coverage: `mock-provider.ts:32-95` `enqueueStream`/`streamQueue` and `failureOnCall` streaming retry scenarios: `ProviderRateLimitError` pre-stream retry (`1130-1180` loop), mid-stream error chunk terminal, `MaxToolRoundsExceededError:1251` streaming, `afterGenerate` throws → error chunk + `run.failed`.
- `toEventErrorPayload` S-1 sanitized (`code/message/retryable` only at `55-61`).
- `executePipeline()` has the exact same function signature as before; no new public exports; `api-extractor` diff empty; changeset `patch|none` (internal refactor, no `interfaces.ts` change; ADR-039 NOT breaking).
- `madge --circular packages/core/src/pipeline/streaming.ts packages/core/src/pipeline/streaming-engine.ts` — zero cycles (neither imports `generation-engine.ts`/`retry-engine.ts` bidirectionally; ADR-030 L3↔L3 forbidden).
- All tests pass without modification; `pnpm build` + `tsup` transitive verified.

**Testability detail (testing/SKILL.md + mock-provider.ts:32-95):** `enqueueStream`/`streamQueue` and `failureOnCall` streaming retry scenarios: `ProviderRateLimitError` pre-stream retry (`1130-1180` loop), mid-stream error chunk terminal, `MaxToolRoundsExceededError:1251` streaming, `afterGenerate` throws → error chunk + `run.failed`.

---

## 8. Risk Assessment

| Risk                                             | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming behavior regression during extraction  | Medium     | High   | All streaming tests pass without modification; generator mechanics preserved verbatim; `asyncIteratorWithIdleTimeout` idle timeout per chunk preserved.                                                                                                                                                                                                                      |
| Chunk order or `afterGenerate` timing changed    | Low        | High   | Preserve `afterGenerate`-after-`'done'` ordering at `pipeline.ts:1454` per ADR-027 (`hooks.ts:11` serial); chunk union `interfaces.ts:286-291` untouched; `finishReason` mapping `1227` and `accumulatedUsage` `1207-1209` preserved.                                                                                                                                        |
| Dispatch guard bypassed in barrel wiring         | Low        | High   | Guard stays at `run()` entry `orchestrator.ts:165-182` primary (`ConfigValidationError`); `pipeline.ts:1137-1142` duplicate remains as defense-in-depth secondary — B1E only moves the streaming body, not the guard.                                                                                                                                                        |
| Streaming tool execution accidentally streamed   | Low        | Medium | `ToolExecutor` (B1B) reused — tools remain synchronous/blocking.                                                                                                                                                                                                                                                                                                             |
| Duplication persists (relocated, not eliminated) | High       | Medium | Expected per ADR-039: B15 is the terminal closure for the ~250-line duplication (Finding 1.2/1.3). `initializePipeline:300-476` + `finalizePipeline:575-644` duplicate is relocated in B1E, not eliminated; B15 `RoundExecutionStrategy` (ADR-039 §1) will eliminate via single loop — reviewer DRY concern is expected until B15.                                           |
| Layering / circular via streaming files          | Low        | High   | `streaming.ts`/`streaming-engine.ts` (L3) may import `shared.ts`, `tool-executor.ts`, `error-normalizer.ts`, `policies.ts` (L1), `lifecycle.ts` (L1); neither may import `generation-engine.ts`/`retry-engine.ts` bidirectionally; verify `madge --circular packages/core/src/pipeline/streaming.ts packages/core/src/pipeline/streaming-engine.ts` — zero cycles (ADR-030). |
| Idle timeout / totalTimeoutMs mis-scoped         | Low        | High   | Preserve `asyncIteratorWithIdleTimeout(iterable, config.timeout.generateTimeoutMs, input.signal)` per chunk; pre-stream retry loop; intentionally NOT wrapped in `withTimeout(totalTimeoutMs)` (ADR-026) — document as preserved.                                                                                                                                            |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Streaming Execution Flow section, Timeout Enforcement (ADR-026), Layer Architecture diagram (ADR-030), `pipeline.ts` vs `orchestrator.ts`, target layout `46-51` (two files `streaming.ts` + `streaming-engine.ts`)
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 7 (Small Core, Large Ecosystem)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `.opencode/skill/interfaces/SKILL.md` — `StreamChunk` discriminated union `286-291` (`text/tool_call/tool_result/done/error`, `done: usage?: TokenUsage`), `AIProvider.generateStream?`
- `.opencode/skill/interfaces/SKILL.md` — `ResolvedConfig`, `RunInput`, `RunOutput`, `EventBus` types
- `.opencode/skill/constraints/SKILL.md` — `stream: true` + `fallbackProvider` forbidden
- `.opencode/skill/security/SKILL.md` — S-1/S-7 (`toEventErrorPayload:55-61` `code/message/retryable` only)
- `.opencode/skill/testing/SKILL.md` — `mock-provider.ts:32-95` `enqueueStream`/`streamQueue` + `failureOnCall` streaming retry
- `DECISION-LOG.md` — ADR-006 (streaming is a mode of `run()`), ADR-017 (streaming + fallback), ADR-026 (totalTimeoutMs), ADR-027 (`afterGenerate` after `done`), ADR-030 (L3 may import L0–L3), ADR-039 (B1E atomic split; B15 closure)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1–2.2 (Streaming orchestration concern)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/claude-technical-analysis.md` — Finding 1.3 (duplication relocated, B15 closure)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior extraction of `finalizePipeline()` (note B1D/B1A already moved `finalizePipeline` to `shared.ts`/`pipeline` shell, path not current)
- `packages/core/src/pipeline/*` shell — Source to decompose (post-B1D; pre-B1A `packages/core/src/pipeline.ts:1547` monolith — post-B1D verify in `pipeline/` shell)
- `packages/core/src/pipeline.ts:108-144` `asyncIteratorWithIdleTimeout`, `1092-1341` `executeStreamingGenerationRound`, `1352-1512` `executeStreamingPipeline` (post-B1D — re-verify)
- `packages/core/src/orchestrator.ts:22` `'./pipeline/index.js'` (ESM NodeNext) and `tsup` transitive (pipeline directory transitive; `tsup.config.ts` entries `src/index.ts` + `testing/mock-provider.ts`)
- `packages/core/src/lifecycle.ts:8-20` `VALID_TRANSITIONS` and `hooks.ts:11` `runHooks` afterGenerate serial (as B1D had)
- `packages/core/src/interfaces.ts:286-291` `StreamChunk` union, `50-54` `EventErrorPayload`, `55-61` `toEventErrorPayload`
- `packages/core/src/testing/mock-provider.ts:32-95` `enqueueStream`/`streamQueue` and `failureOnCall` streaming retry
- `M06-B1A-pipeline-generation-engine.md`, `M07-B1B-pipeline-tool-executor.md`, `M08-B1C-pipeline-retry-engine.md`, `M09-B1D-pipeline-error-mapper.md` — Preceding sub-milestones (B1A–B1D) — precondition: `pipeline/` skeleton exists
- `M12-B15-round-execution-strategy.md` — Terminal closure (round-loop unification)
