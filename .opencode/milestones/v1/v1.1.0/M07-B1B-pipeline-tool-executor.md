# B1B — ToolExecutor (Pipeline Decomposition, Part 2 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit.
>
> **Precondition (B1A dependency):** M06-B1A merged, `pipeline/` skeleton (`index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`) exists, `pnpm build` green, `pnpm typecheck` passes — B1B extracts from `pipeline/non-streaming.ts` (post-B1A shell) not from monolithic `pipeline.ts`. All `pipeline.ts:XXX` line refs below are post-B1A, re-verify after B1A commit hash `ae3c70a` (monolith was 1547 lines pre-B1A).

---

## 1. Task Summary

Extract the **ToolExecutor** — tool round execution — from `packages/core/src/pipeline/non-streaming.ts` (post-B1A shell) into `packages/core/src/pipeline/tool-executor.ts` (source ranges post-B1A, re-verify after B1A commit hash `ae3c70a`: `executeToolRound:493-559` (67 lines), `executeToolRoundWithErrorHandling:717-776` (60 lines), tool loop + `roundCounter` check at `pipeline.ts:903`/`1251` (pre-B1A refs; now in `pipeline/non-streaming.ts`)):

1. Move the M002-extracted `executeToolRound()` and its error-handling wrapper `executeToolRoundWithErrorHandling()` (Step 6) into `tool-executor.ts`, including `stateMachine.transition('TOOL_EXECUTING')` at `:732` (post-B1A, re-verify) and `VALID_TRANSITIONS TOOL_EXECUTING: ['GENERATING','RETRYING',...]` at `lifecycle.ts:14`.
2. Move the tool loop, round limiting (`roundCounter` vs `toolPolicy.maxToolRounds`), and `tool-controller.ts` integration into the engine — `roundCounter` owned by ToolExecutor per ADR-016, `toolAttempt` stays in RetryEngine (B1C).
3. Keep `withTimeout` via `ToolController` (`tool-controller.ts:123` `return withTimeout(tool.execute(input), this.policy.toolTimeoutMs)`, `policies.ts:100` `withTimeout`, `config.toolPolicy.toolTimeoutMs` mirror `TimeoutPolicy` per ADR-035 `profile.ts:resolveConfig`) — **no additional `Promise.race(toolTimeoutMs)` wrapping at pipeline layer**. `ToolExecutionError` retryable semantics unchanged.
4. Wire `non-streaming.ts` to call the ToolExecutor; the streaming path (B1E at `pipeline.ts:1266` direct `executeToolRound` vs non-streaming at `:907` via wrapper) reuses the same engine for its blocking tool execution — until B15 both call-sites must be kept manually in sync (B15 closure per ADR-039).
5. Public API unchanged — no consumer-visible changes. Classification: internal refactor, no `interfaces.ts` change → `changeset: patch` or `none` per `api-design`, ADR-039 NOT breaking (see §5b).

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` was 1547 lines pre-B1A — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). Post-B1A the monolith is split into `pipeline/` (`index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts` shell). Tool execution is one of six distinct orchestration concerns embedded in that file (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)**.

The earlier M002 consolidation (Option 1 — Minimal Consolidation) extracted `executeToolRound()` as a helper within the same file. B1B moves it into its own module. Key behavioral facts that must be preserved:

- `roundCounter` lives as a **local per-call variable** — NOT inside `ToolController`, NOT module state. It increments per round and is checked against `maxToolRounds` (never resets on retry per ADR-016 cumulative; refs `pipeline.ts:954, 980, 1427` streaming).
- `toolAttempt` (`pipeline.ts:955`, returned as `{toolAttempt+1}` at `771` for backoff via `calculateDelay` `policies.ts:76`) remains in RetryEngine (B1C) — not owned by ToolExecutor.
- Tool input validation runs against the schema (`ToolValidationError` = FATAL).
- Tool execution uses `withTimeout` inside `ToolController` (`tool-controller.ts:123`, `policies.ts:100`, `config.toolPolicy.toolTimeoutMs` per ADR-035) — no `Promise.race` wrapping at pipeline layer (`ToolExecutionError` = retryable).
- `beforeTool` / `afterTool` hooks run per tool call; `tool.called`, `tool.completed` / `tool.failed` events are emitted — parallel to `stateMachine.transition('TOOL_EXECUTING')` at `:732`.
- Tool results append to messages; control returns to GENERATING (`VALID_TRANSITIONS` `TOOL_EXECUTING: ['GENERATING','RETRYING',...]` at `lifecycle.ts:14`).
- In streaming mode (B1E), tool execution is synchronous and blocking — never streamed. A single `ToolExecutor` reused by both paths prevents the two paths from silently diverging (B15 closure). Streaming at `pipeline.ts:1266` directly calls `executeToolRound`, non-streaming at `:907` via wrapper with extra error handling — extract must unify error handling at wrapper level, and until B15 both call-sites must be kept manually in sync.

---

## 3. Issues/Changes

### Issue B1B-1: ToolExecutor embedded in a God Module

| Field       | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/non-streaming.ts` (post-B1A shell; pre-B1A `packages/core/src/pipeline.ts` 1–1547 monolith, tool loop Step 6)                                    |
| Lines       | Post-B1A, re-verify after B1A commit hash `ae3c70a`: `executeToolRound:493-559` (67 lines), `executeToolRoundWithErrorHandling:717-776` (60 lines), loop at `:903`/`:1251` |
| Severity    | HIGH                                                                                                                                                                         |
| Description | Tool execution loop, round limiting, `TOOL_EXECUTING` transition, hooks/events, and `ToolController` integration are embedded in `non-streaming.ts` shell.                   |
| Fix         | Extract into `pipeline/tool-executor.ts`. Pure restructuring — no behavioral change. Decompose helpers to meet 40-line limit.                                                |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

- **Precondition:** M06-B1A merged, `pipeline/` skeleton (`index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`) exists, `pnpm build` green, `pnpm typecheck` passes — B1B extracts from `pipeline/non-streaming.ts` not from monolithic `pipeline.ts` (post-B1A, re-verify after B1A commit hash `ae3c70a`).

- Create `packages/core/src/pipeline/tool-executor.ts` hosting the `ToolExecutor` module.
- Move `executeToolRound()` (M002-extracted, `493-559` post-B1A, re-verify) and its error-handling wrapper `executeToolRoundWithErrorHandling()` (`717-776` post-B1A, re-verify) and the tool loop (`:903`/`1251` post-B1A) into `tool-executor.ts`, preserving exact function signatures. The wrapper must be extracted too so its error semantics are preserved: `ToolValidationError` (FATAL) fail-fast, `ToolExecutionError` (retryable). Move `stateMachine.transition('TOOL_EXECUTING')` at `executeToolRoundWithErrorHandling:732` (post-B1A, re-verify) and its `VALID_TRANSITIONS TOOL_EXECUTING: ['GENERATING','RETRYING',...]` at `lifecycle.ts:14` — include hook/event parallel: `beforeTool`/`afterTool` hooks + `tool.called`/`completed`/`failed` events must be preserved alongside the transition.
- `roundCounter` (ADR-016 cumulative, `pipeline.ts:954, 980, 1427` streaming, never reset on retry) is **owned by ToolExecutor**; `toolAttempt` (`pipeline.ts:955`, returned as `{toolAttempt+1}` at `771` for backoff via `calculateDelay` `policies.ts:76`) remains in RetryEngine (B1C) — B1B passes through `toolAttempt`, increment belongs to B1C. ToolExecutor only checks `roundCounter vs maxToolRounds` at `pipeline.ts:903/1251` (post-B1A, now in `non-streaming.ts` — re-verify). No overlap with B1C.
- The engine integrates with `tool-controller.ts` (Layer 2) for schema validation and execution — no changes to `tool-controller.ts` contract. Timeout via `withTimeout` inside `ToolController` (`tool-controller.ts:123` `return withTimeout(tool.execute(input), this.policy.toolTimeoutMs)`, `policies.ts:100` `withTimeout`, `config.toolPolicy.toolTimeoutMs` mirror `TimeoutPolicy` per ADR-035 `profile.ts:resolveConfig`); **no additional wrapping at pipeline layer**.
- Error semantics preserved:
  - Schema validation failure → `ToolValidationError` (FATAL — no retry)
  - Execution failure → `ToolExecutionError` (retryable — retry classification lives in B1C's RetryEngine)
- Hook and event behavior preserved: `beforeTool` / `afterTool` hooks (pipeline-blocking), `tool.called`, `tool.completed` / `tool.failed` events — emitted in parallel with `TOOL_EXECUTING` transition.
- Both `non-streaming.ts` (B1B) and `streaming.ts` (B1E) import and call the same `ToolExecutor` — single source of truth for tool round behavior. Streaming at `pipeline.ts:1266` directly calls `executeToolRound`, non-streaming at `:907` via wrapper with extra error handling — extract must unify error handling at wrapper level, and until B15 both call-sites must be kept manually in sync (B15 closure per ADR-039).
- Follow function body max 40 lines (per `code-standards/SKILL.md` / `implementation-standards.md`). Note `pipeline.ts:493-559` (67 lines) and `717-776` (60 lines) (post-B1A, re-verify) exceed 40-line limit — **require decomposition into helpers** e.g., `runBeforeToolHooks` / `appendToolResults` / `emitToolEvents` within `tool-executor.ts` to meet limit. Module totals must be split into sub-functions (each ≤40 lines, complexity 7, nesting 3).
- Layering: direct chain `non-streaming.ts → tool-executor.ts → tool-controller.ts` (L2) per ADR-030 L3 may import L0–L3, no circular via `shared.ts`; `tool-executor.ts` does NOT go through `shared.ts`.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline/index.ts`. `executePipeline()` must remain the single exported function with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, `tool-controller.ts`, or any other contract file.
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT move `roundCounter` into `ToolController` or into module state — local per-call variable only (Principle 4 — Stateless Core, ADR-016 cumulative).
- Do NOT move `toolAttempt` increment into ToolExecutor — belongs to B1C RetryEngine.
- Do NOT change `ToolValidationError` (FATAL) or `ToolExecutionError` (retryable) semantics.
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files.
- Do NOT add `Promise.race(toolTimeoutMs)` wrapping at pipeline layer — timeout is via `ToolController` `withTimeout` per ADR-035.
- Do NOT re-export from `shared.ts`; import directly from `./tool-executor.js`.

---

## 5. Files to Modify

| File                                          | Action    | Notes                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/tool-executor.ts` | NEW       | `ToolExecutor` module — `executeToolRound()` (`493-559` post-B1A, re-verify), `executeToolRoundWithErrorHandling()` (`717-776` post-B1A, re-verify) + `roundCounter` check vs `maxToolRounds` at `:903`/`1251` + `TOOL_EXECUTING` transition at `:732` + `tool.called`/`completed`/`failed` emit + `beforeTool`/`afterTool` hooks. Decompose helpers (`runBeforeToolHooks`/`appendToolResults`/`emitToolEvents`) to meet 40-line limit. |
| `packages/core/src/pipeline/non-streaming.ts` | MODIFY    | Replace inline tool loop + `roundCounter` check (`pipeline.ts:903/1251` pre-B1A, now in `non-streaming.ts` post-B1A — re-verify) with `ToolExecutor` calls. Pass `roundCounter` as local per-call value, return/update explicitly. Import directly from `./tool-executor.js` (no re-export via `shared.ts`).                                           |
| `packages/core/src/pipeline/index.ts`         | NO CHANGE | Dispatch already created in B1A — no action in B1B.                                                                                                                                                                                                                      |
| `packages/core/src/pipeline.ts`               | —         | Legacy monolith reference — post-B1A paths are `pipeline/non-streaming.ts` shell (not stale `pipeline.ts:1547` monolith). B1B extracts from `pipeline/non-streaming.ts`.                                                                                               |
| `packages/core/src/pipeline/shared.ts`        | NO CHANGE | B1A narrowed to `buildPromptRequest:67-85` + `initializePipeline:300-476` only. Do NOT move or re-export tool code via `shared.ts` (circular risk).                                                                                                                    |
| `packages/core/src/orchestrator.ts`           | NO CHANGE | Already changed in B1A: `from './pipeline.js'` → `from './pipeline/index.js'` at `:22`. No action in B1B.                                                                                                                                                               |

### 5b. Changeset / Versioning Classification

Classification: **internal refactor, no `interfaces.ts` change** → `changeset: patch` or `none` per `api-design`, ADR-039 NOT breaking (no MAJOR). No public type or runtime export changes. Verify with `pnpm changeset` (no changeset required if `none`, or `patch` if repo policy requires one for internal refactors) and `pnpm build && api-extractor` diff empty (no public API change).

---

## 6. Implementation Strategy

### Step 1: Create `tool-executor.ts` — Precondition: M06-B1A merged, `pipeline/` skeleton (`index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`) exists, `pnpm build` green, `pnpm typecheck` passes — B1B extracts from `pipeline/non-streaming.ts` not from monolithic `pipeline.ts`

- Create `packages/core/src/pipeline/tool-executor.ts`.
- Move the M002-extracted `executeToolRound()` (`493-559` post-B1A, re-verify) and its error-handling wrapper `executeToolRoundWithErrorHandling()` (`717-776` post-B1A, re-verify) into it, preserving exact signatures. The wrapper must be extracted too so its error semantics are preserved: `ToolValidationError` (FATAL) fail-fast, `ToolExecutionError` (retryable). Include `stateMachine.transition('TOOL_EXECUTING')` at `:732` (post-B1A, re-verify) and ensure `VALID_TRANSITIONS TOOL_EXECUTING: ['GENERATING','RETRYING',...]` at `lifecycle.ts:14` is respected — hooks `beforeTool`/`afterTool` + events `tool.called`/`completed`/`failed` move with the transition.
- Decompose `493-559` (67 lines) and `717-776` (60 lines) into helpers (`runBeforeToolHooks` / `appendToolResults` / `emitToolEvents`) to meet `code-standards` 40-line / complexity 7 / nesting 3 limits (module total must be split into sub-functions).
- Source is post-B1A `pipeline/non-streaming.ts` shell — not stale `pipeline.ts:1547` monolith. Re-verify line refs after B1A commit hash `ae3c70a`.
- Verify `roundCounter` (ADR-016 cumulative, `:954, 980, 1427` streaming) ownership in ToolExecutor vs `toolAttempt` (`:955`, `{toolAttempt+1}` at `771` via `calculateDelay` `policies.ts:76`) remaining in B1C RetryEngine — B1B only checks `roundCounter vs maxToolRounds` at `:903`/`1251` (post-B1A).

### Step 2: Wire Non-Streaming Path (Tool Loop + Round Counter + State Transition)

- In `non-streaming.ts` (post-B1A shell, not stale `pipeline.ts`), replace the inline tool loop + `roundCounter` check at `:903`/`1251` (post-B1A, re-verify) with calls to the `ToolExecutor`.
- Verify `roundCounter` is passed as a local per-call value and returned/updated explicitly (ADR-016 cumulative, never reset on retry; ToolExecutor owns the check, `toolAttempt` increment belongs to B1C).
- Move `stateMachine.transition('TOOL_EXECUTING')` at `executeToolRoundWithErrorHandling:732` (post-B1A, re-verify) into `tool-executor.ts` with its `VALID_TRANSITIONS TOOL_EXECUTING: ['GENERATING','RETRYING',...]` at `lifecycle.ts:14`. Preserve hook/event parallel: `beforeTool`/`afterTool` hooks + `tool.called`/`completed`/`failed` events must be preserved alongside the transition — ensure emit points move together.
- Timeout: rely on `ToolController` `withTimeout` (`tool-controller.ts:123`, `policies.ts:100`, ADR-035 mirror) — no `Promise.race` wrapping at pipeline layer.
- Note streaming diverge: streaming at `:1266` directly calls `executeToolRound`, non-streaming at `:907` via wrapper — unify error handling at wrapper level; until B15 both call-sites must be kept manually in sync (B15 closure).

### Step 3: Update Imports — Do NOT Re-export via shared.ts

- **Do NOT re-export from `shared.ts`; import directly from `./tool-executor.js`.** Direct chain `non-streaming.ts → tool-executor.ts → tool-controller.ts` (L2) per ADR-030 L3 may import L0–L3, no circular via `shared.ts`. The "re-export from `shared.ts` option" is rejected (circular risk).
- `shared.ts` remains `NO CHANGE` (B1A narrowed scope).
- Ensure all import paths reference the correct `.js` modules (ESM NodeNext).
- Source clarification: post-B1A `pipeline/non-streaming.ts` shell — not stale `pipeline.ts:1547` monolith (re-verify after B1A commit hash `ae3c70a`).
- `roundCounter` vs `toolAttempt` split reflected: ToolExecutor checks `roundCounter vs maxToolRounds`; `toolAttempt` pass-through to B1C `RetryEngine` (`calculateDelay` `policies.ts:76` at `771`).

### Step 4: Verify (No Test Modification)

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage && pnpm build`.
- **Expanded verification (beyond generic lint/typecheck/test):**
  - `madge --circular packages/core/src/pipeline/tool-executor.ts` — no circular in `pipeline/` (layering ADR-030)
  - `pnpm build && grep -r "from.*pipeline" packages/core/dist` — no internal leak (from B1A §5b; internal, no export)
  - `api-extractor` diff empty — no public API change
  - Specific test suites (must pass without modification per ADR-039):
    - `tool-controller.test.ts` (ToolController `withTimeout` via `tool-controller.ts:123`/`policies.ts:100`/ADR-035)
    - `orchestrator.test.ts` (`maxToolRounds`, `ToolValidationError` FATAL, `ToolExecutionError` retryable per `errors.ts`)
    - `streaming.test.ts` (`tool_result` blocking — streaming never streams tool execution)
    - `tool.failed` / `tool.completed` event tests, `MaxToolRoundsExceededError` test, `tool.called` emit tests
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
madge --circular packages/core/src/pipeline/tool-executor.ts
grep -r "from.*pipeline" packages/core/dist
api-extractor diff
```

Specific assertions to verify:

- `packages/core/src/pipeline/tool-executor.ts` exists and hosts the tool loop + `roundCounter` check vs `maxToolRounds` at `pipeline.ts:903/1251` (post-B1A, now in `non-streaming.ts` — re-verify after `ae3c70a`) + `TOOL_EXECUTING` transition at `:732` (post-B1A, re-verify) with `VALID_TRANSITIONS TOOL_EXECUTING: ['GENERATING','RETRYING',...]` at `lifecycle.ts:14`.
- `roundCounter` is a local per-call variable (ADR-016 cumulative `:954, 980, 1427` streaming, never reset on retry) owned by ToolExecutor; `toolAttempt` (`:955`, `{toolAttempt+1}` at `771` via `calculateDelay` `policies.ts:76`) remains in B1C RetryEngine — split verified, no B1B/B1C overlap.
- Timeout via `ToolController` `withTimeout` (`tool-controller.ts:123` `return withTimeout(tool.execute(input), this.policy.toolTimeoutMs)`, `policies.ts:100` `withTimeout`, `config.toolPolicy.toolTimeoutMs` mirror `TimeoutPolicy` per ADR-035 `profile.ts:resolveConfig`) — no `Promise.race` wrapping at pipeline layer.
- `ToolValidationError` remains FATAL and `ToolExecutionError` remains retryable per `errors.ts`; retry classification lives in B1C.
- `beforeTool` / `afterTool` hooks and `tool.called` / `tool.completed` / `tool.failed` events are emitted exactly as before, in parallel with `TOOL_EXECUTING` transition.
- `executePipeline()` has the exact same function signature as before; no new public exports; `api-extractor` diff empty.
- `madge --circular` shows no circular in `pipeline/` (ADR-030 L3 may import L0–L3, no circular via `shared.ts`; direct import `./tool-executor.js`).
- `pnpm build` emits `dist/pipeline/index.js` transitive; `grep -r "from.*pipeline" packages/core/dist` shows no leak (internal, no export).
- Specific test suites pass without modification per ADR-039: `tool-controller.test.ts`, `orchestrator.test.ts` (`maxToolRounds`, `ToolValidationError` FATAL, `ToolExecutionError` retryable), `streaming.test.ts` (`tool_result` blocking), plus `tool.failed`/`tool.completed` event tests, `MaxToolRoundsExceededError` test.
- Code-standards 40-line limit met: `493-559` (67 lines) and `717-776` (60 lines) (post-B1A, re-verify) decomposed into helpers (`runBeforeToolHooks`/`appendToolResults`/`emitToolEvents`) within `tool-executor.ts`.
- No behavioral change — all tests pass without modification; changeset `patch` or `none`.

---

## 8. Risk Assessment

| Risk                                                | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool loop regression during extraction              | Medium     | Medium | All tool tests pass without modification; behavior is preserved by exact-signature moves; `tool.called`/`completed`/`failed` + `beforeTool`/`afterTool` + `TOOL_EXECUTING` transition moved together.                                   |
| `roundCounter` accidentally hoisted to module state | Low        | High   | Keep it a local per-call variable (Principle 4, ADR-016 cumulative); ToolExecutor owns check `roundCounter vs maxToolRounds` at `:903`/`1251` (post-B1A); review diff for accidental hoisting; `toolAttempt` stays in B1C.             |
| `ToolController` import mismatch after move         | Low        | Medium | Verify import paths with `pnpm typecheck`; direct chain `non-streaming.ts → tool-executor.ts → tool-controller.ts` (L2) per ADR-030; `madge --circular` no circular.                                                                      |
| Streaming path reuses a divergent tool loop         | Low        | Medium | B1E must import the same `ToolExecutor` (single source; B15 closure). Until B15, streaming `:1266` direct call vs non-streaming `:907` wrapper must be kept manually in sync — extract unifies error handling at wrapper level.         |
| Timeout double-wrapping                             | Low        | Medium | Timeout via `ToolController` `withTimeout` (`tool-controller.ts:123`, `policies.ts:100`, ADR-035 mirror) — no `Promise.race` at pipeline layer; verify `tool-controller.test.ts` passes.                                                  |
| 40-line violation in extracted helpers              | Medium     | Low    | `493-559` (67 lines) and `717-776` (60 lines) decomposed into `runBeforeToolHooks`/`appendToolResults`/`emitToolEvents` helpers per `code-standards`.                                                                                     |
| Circular via shared.ts re-export                    | Low        | High   | Do NOT re-export from `shared.ts`; import directly from `./tool-executor.js`; `madge --circular` verification.                                                                                                                            |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow Step 6 (TOOL_EXECUTING), Layer Architecture diagram (ADR-030 L3 may import L0–L3), `pipeline.ts` vs `orchestrator.ts`
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 7 (Small Core, Large Ecosystem)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines, complexity 7, nesting 3, param count ≤3
- `.opencode/skill/errors/SKILL.md` — `ToolValidationError` (FATAL), `ToolExecutionError` (retryable), `MaxToolRoundsExceededError`
- `.opencode/skill/architecture/SKILL.md` — TOOL_EXECUTING transitions (`lifecycle.ts:14` `VALID_TRANSITIONS`)
- `.opencode/skill/constraints/SKILL.md` — parallel tool execution forbidden (`allowParallelTools` constraint row)
- `.opencode/skill/security/SKILL.md` — S-1 secret hygiene (no secrets in `tool.failed` event payloads), S-3a tool output handling
- `DECISION-LOG.md` — ADR-039 (B1B atomic split; B15 closure), ADR-030 (L3 may import L0–L3), ADR-016 (cumulative counter `roundCounter` never reset), ADR-035 (`toolTimeoutMs` mirror `TimeoutPolicy` via `profile.ts:resolveConfig`, `tool-controller.ts:123`/`policies.ts:100` `withTimeout`)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1 (Tool orchestration concern)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior extraction of `executeToolRound()`
- `packages/core/src/pipeline.ts` — Source file to decompose (post-B1A: now `pipeline/non-streaming.ts` shell; pre-B1A 1547 lines — post-B1A, re-verify after B1A commit hash `ae3c70a`: `executeToolRound:493-559`, `executeToolRoundWithErrorHandling:717-776`, `TOOL_EXECUTING:732`, loop `:903`/`:1251`, streaming `:1266` vs `:907`, `roundCounter:954, 980, 1427` streaming, `toolAttempt:955, 771`)
- `packages/core/src/pipeline/non-streaming.ts` — Post-B1A shell (source of extraction in B1B; not stale monolith)
- `packages/core/src/pipeline/index.ts` — Dispatch already created in B1A (NO CHANGE in B1B)
- `packages/core/src/tool-controller.ts` — Tool validation/execution integration point (`:123` `withTimeout`, ADR-035 mirror)
- `packages/core/src/policies.ts` — `withTimeout:100`, `calculateDelay:76` (B1C `toolAttempt+1` at `771`)
- `packages/core/src/lifecycle.ts` — `VALID_TRANSITIONS` `TOOL_EXECUTING: ['GENERATING','RETRYING',...]` at `:14` per ADR-031 `state-machine.md` authoritative
- `packages/core/src/profile.ts` — `resolveConfig` ADR-035 `toolTimeoutMs` mirror
- `M06-B1A-pipeline-generation-engine.md` — Preceding sub-milestone (B1A) — precondition: skeleton exists, `orchestrator.ts:22` already `→ ./pipeline/index.js`
