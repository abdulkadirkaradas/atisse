# B1B — ToolExecutor (Pipeline Decomposition, Part 2 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit.

---

## 1. Task Summary

Extract the **ToolExecutor** — tool round execution — from `packages/core/src/pipeline.ts` into `packages/core/src/pipeline/tool-executor.ts`:

1. Move the M002-extracted `executeToolRound()` and its error-handling wrapper `executeToolRoundWithErrorHandling()` (Step 6) into `tool-executor.ts`.
2. Move the tool loop, round limiting (`roundCounter` vs `toolPolicy.maxToolRounds`), and `tool-controller.ts` integration into the engine.
3. Keep the `Promise.race(toolTimeoutMs)` wrapping and the `ToolExecutionError` retryable semantics unchanged.
4. Wire `non-streaming.ts` to call the ToolExecutor; the streaming path (B1E) reuses the same engine for its blocking tool execution.
5. Public API unchanged — no consumer-visible changes.

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` is 1547 lines — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). Tool execution is one of six distinct orchestration concerns embedded in that single file (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)**.

The earlier M002 consolidation (Option 1 — Minimal Consolidation) extracted `executeToolRound()` as a helper within the same file. B1B moves it into its own module. Key behavioral facts that must be preserved:

- `roundCounter` lives in `pipeline.ts` as a local variable — NOT inside `ToolController`. It increments per round and is checked against `maxToolRounds` (never resets on retry).
- Tool input validation runs against the schema (`ToolValidationError` = FATAL).
- Tool execution is wrapped in `Promise.race(toolTimeoutMs)` (`ToolExecutionError` = retryable).
- `beforeTool` / `afterTool` hooks run per tool call; `tool.called`, `tool.completed` / `tool.failed` events are emitted.
- Tool results append to messages; control returns to GENERATING.
- In streaming mode (B1E), tool execution is synchronous and blocking — never streamed. A single `ToolExecutor` reused by both paths prevents the two paths from silently diverging (B15 closure).

---

## 3. Issues/Changes

### Issue B1B-1: ToolExecutor embedded in a God Module

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                |
| Lines       | 1–1547 (entire file); tool loop spans Step 6                                                                   |
| Severity    | HIGH                                                                                                           |
| Description | Tool execution loop, round limiting, and `ToolController` integration are embedded in a single 1547-line file. |
| Fix         | Extract into `pipeline/tool-executor.ts`. Pure restructuring — no behavioral change.                           |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

- Create `packages/core/src/pipeline/tool-executor.ts` hosting the `ToolExecutor` module.
- Move `executeToolRound()` (M002-extracted), its error-handling wrapper `executeToolRoundWithErrorHandling()`, and the tool loop into `tool-executor.ts`, preserving exact function signatures.
- `roundCounter` remains a **local per-call variable** (Principle 4 — Stateless Core): incremented inside the tool loop, checked against `toolPolicy.maxToolRounds`, never stored on `this`, never resets on retry.
- The engine integrates with `tool-controller.ts` (Layer 2) for schema validation and execution — no changes to `tool-controller.ts` contract.
- Error semantics preserved:
  - Schema validation failure → `ToolValidationError` (FATAL — no retry)
  - Execution failure → `ToolExecutionError` (retryable — retry classification lives in B1C's RetryEngine)
- Hook and event behavior preserved: `beforeTool` / `afterTool` hooks (pipeline-blocking), `tool.called`, `tool.completed` / `tool.failed` events.
- Both `non-streaming.ts` (B1B) and `streaming.ts` (B1E) import and call the same `ToolExecutor` — single source of truth for tool round behavior.
- Follow function body max 40 lines (per `implementation-standards.md`). Decompose further if exceeded.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). `executePipeline()` must remain the single exported function with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, `tool-controller.ts`, or any other contract file.
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT move `roundCounter` into `ToolController` or into module state.
- Do NOT change `ToolValidationError` (FATAL) or `ToolExecutionError` (retryable) semantics.
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files.

---

## 5. Files to Modify

| File                                          | Action | Notes                                                                                                          |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/tool-executor.ts` | NEW    | `ToolExecutor` module — `executeToolRound()`, `executeToolRoundWithErrorHandling()`, tool loop, round limiting |
| `packages/core/src/pipeline/shared.ts`        | MODIFY | Remove `executeToolRound()` — moved to `tool-executor.ts` (re-export only if needed)                           |
| `packages/core/src/pipeline.ts`               | MODIFY | Remove tool slice (Step 6)                                                                                     |
| `packages/core/src/pipeline/non-streaming.ts` | MODIFY | Call `ToolExecutor` for the Step 6 tool loop                                                                   |

---

## 6. Implementation Strategy

### Step 1: Create `tool-executor.ts`

- Create `packages/core/src/pipeline/tool-executor.ts`.
- Move the M002-extracted `executeToolRound()` and its error-handling wrapper `executeToolRoundWithErrorHandling()` into it, preserving exact signatures. The wrapper must be extracted too so its error semantics are preserved: `ToolValidationError` (FATAL) fail-fast, `ToolExecutionError` (retryable).

### Step 2: Wire Non-Streaming Path

- In `non-streaming.ts`, replace the inline tool loop with calls to the `ToolExecutor`.
- Verify `roundCounter` is passed as a local per-call value and returned/updated explicitly.

### Step 3: Update Imports

- Update `shared.ts` to remove the moved `executeToolRound()` (or re-export from `tool-executor.ts` to minimize import churn).
- Ensure all import paths reference the correct `.js` modules.

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

- `packages/core/src/pipeline/tool-executor.ts` exists and hosts the tool loop.
- `roundCounter` is a local per-call variable; `maxToolRounds` limiting behavior is identical.
- `ToolValidationError` remains FATAL and `ToolExecutionError` remains retryable.
- `beforeTool` / `afterTool` hooks and `tool.called` / `tool.completed` / `tool.failed` events are emitted exactly as before.
- `executePipeline()` has the exact same function signature as before; no new public exports.
- All tests pass without modification.

---

## 8. Risk Assessment

| Risk                                                | Likelihood | Impact | Mitigation                                                                                |
| --------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| Tool loop regression during extraction              | Medium     | Medium | All tool tests pass without modification; behavior is preserved by exact-signature moves. |
| `roundCounter` accidentally hoisted to module state | Low        | High   | Keep it a local per-call variable (Principle 4); review diff for accidental hoisting.     |
| `ToolController` import mismatch after move         | Low        | Medium | Verify import paths with `pnpm typecheck`.                                                |
| Streaming path reuses a divergent tool loop         | Low        | Medium | B1E must import the same `ToolExecutor` (single source of truth; B15 closure).            |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow Step 6 (TOOL_EXECUTING), Layer Architecture diagram
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 7 (Small Core, Large Ecosystem)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `.opencode/skill/errors/SKILL.md` — `ToolValidationError` (FATAL), `ToolExecutionError` (retryable)
- `.opencode/skill/architecture/SKILL.md` — TOOL_EXECUTING transitions
- `DECISION-LOG.md` — ADR-039 (B1B atomic split; B15 closure)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1 (Tool orchestration concern)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior extraction of `executeToolRound()`
- `packages/core/src/pipeline.ts` — Source file to decompose
- `packages/core/src/tool-controller.ts` — Tool validation/execution integration point
- `M06-B1A-pipeline-generation-engine.md` — Preceding sub-milestone (B1A)
