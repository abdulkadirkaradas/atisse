# B1D — ErrorMapper (Pipeline Decomposition, Part 4 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit.
>
> **Scope note:** B1D is the pipeline-internal error **normalization** slice of B1. It is distinct from B11's `ProviderErrorMapper` (public, adapter-facing utility in `pipeline/error-mapper.ts`). The B1D module is named `error-normalizer.ts` to avoid filename collision with B11.

---

## 1. Task Summary

Extract the **ErrorMapper** — pipeline-internal error normalization — from `packages/core/src/pipeline.ts` into `packages/core/src/pipeline/error-normalizer.ts`:

1. Move `handleOrchestratorError()` (normalizes errors, emits `run.failed`) into `error-normalizer.ts`.
2. Centralize `unknown` → `OrchestratorError` normalization; preserve retryable/fatal classification semantics.
3. Preserve `run.failed` emission before throwing, and the no-secrets guarantee (S-1).
4. Wire `non-streaming.ts` and `streaming.ts` (B1E) to use it.
5. Public API unchanged — no consumer-visible changes.

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` is 1547 lines — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). Error normalization is one of six distinct orchestration concerns embedded in that single file (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)**.

Key behavioral facts that must be preserved:

- All errors thrown by the kernel are `OrchestratorError` subtypes — plain `Error` throws are forbidden (`constraints.md`).
- `handleOrchestratorError()` normalizes any error surfaced from a pipeline step: it converts non-`OrchestratorError` values, classifies retryable/fatal, emits `run.failed`, and rethrows.
- No secrets in logs, errors, or events (`security.md` S-1).
- The streaming path (B1E) uses the same normalization — one shared `run.failed` emission contract.

---

## 3. Issues/Changes

### Issue B1D-1: ErrorMapper embedded in a God Module

| Field       | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                  |
| Lines       | 1–1547 (entire file); error normalization spans the catch path of every step                                     |
| Severity    | HIGH                                                                                                             |
| Description | Error normalization (`handleOrchestratorError()`, `run.failed` emission) is embedded in a single 1547-line file. |
| Fix         | Extract into `pipeline/error-normalizer.ts`. Pure restructuring — no behavioral change.                          |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

- Create `packages/core/src/pipeline/error-normalizer.ts` hosting the `ErrorNormalizer` module.
- Move `handleOrchestratorError()` into it, preserving the exact signature and behavior:
  - `unknown` → `OrchestratorError` normalization (never a plain `Error`).
  - Retryable/fatal classification preserved (via `errors.ts` `isRetryable()` — unchanged).
  - `run.failed` emitted **before** the normalized error is thrown.
  - No secrets in messages (S-1) — error payloads never embed API keys, tokens, or credentials.
- Re-export `handleOrchestratorError` from `shared.ts` if needed to minimize import churn across existing call sites.
- Both `non-streaming.ts` and `streaming.ts` (B1E) consume the same normalization — single `run.failed` emission contract.
- All state remains local per call (Principle 4 — Stateless Core). No module-level state.
- Follow function body max 40 lines (per `implementation-standards.md`). Decompose further if exceeded.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). `executePipeline()` must remain the single exported function with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, `errors.ts`, or any other contract file.
- Do NOT change error taxonomy, `isRetryable()` classification, or any `OrchestratorError` subtype.
- Do NOT introduce new error codes — existing codes cover all standard cases (per B11 constraint).
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files.

---

## 5. Files to Modify

| File                                             | Action | Notes                                                                         |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------- |
| `packages/core/src/pipeline/error-normalizer.ts` | NEW    | `ErrorNormalizer` module — `handleOrchestratorError()`, `run.failed` emission |
| `packages/core/src/pipeline/shared.ts`           | MODIFY | Remove or re-export `handleOrchestratorError()` from `error-normalizer.ts`    |
| `packages/core/src/pipeline.ts`                  | MODIFY | Remove error normalization slice                                              |
| `packages/core/src/pipeline/non-streaming.ts`    | MODIFY | Call `ErrorNormalizer` for the catch path                                     |

---

## 6. Implementation Strategy

### Step 1: Create `error-normalizer.ts`

- Create `packages/core/src/pipeline/error-normalizer.ts`.
- Move `handleOrchestratorError()` into it, preserving the exact signature and behavior.
- Verify `run.failed` is emitted before the normalized error is thrown.

### Step 2: Update Shared + Non-Streaming Paths

- In `shared.ts`, remove the moved function or re-export it from `error-normalizer.ts`.
- In `non-streaming.ts`, call the `ErrorNormalizer` for the catch path.

### Step 3: Verify

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

- `packages/core/src/pipeline/error-normalizer.ts` exists and hosts `handleOrchestratorError()`.
- All normalized errors are `OrchestratorError` subtypes — no plain `Error` escapes the pipeline.
- `run.failed` emitted before the throw, with identical payload shape.
- No secret material appears in error messages (S-1).
- `executePipeline()` has the exact same function signature as before; no new public exports.
- All tests pass without modification.

---

## 8. Risk Assessment

| Risk                                         | Likelihood | Impact | Mitigation                                                                                           |
| -------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------- |
| Error classification drift during extraction | Medium     | Medium | `isRetryable()` in `errors.ts` untouched; tests covering retry/fatal classification pass unchanged.  |
| `run.failed` emission order changed          | Low        | Medium | Preserve emit-before-throw order; event payload shape unchanged.                                     |
| Collision with B11 `error-mapper.ts`         | Low        | Low    | Module named `error-normalizer.ts`; B11's `ProviderErrorMapper` remains separate and adapter-facing. |
| Secret leakage regression                    | Low        | High   | S-1 review of moved code paths; error payloads never embed credentials.                              |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow (catch path of every step), Layer Architecture diagram
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical), Principle 4, Principle 7
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `.opencode/skill/errors/SKILL.md` — Error hierarchy, `isRetryable()` classification
- `.opencode/skill/security/SKILL.md` — S-1 (no secrets in logs, errors, events)
- `DECISION-LOG.md` — ADR-039 (B1D atomic split; B15 closure)
- `.opencode/milestones/v1/v1.1.0/M11-B2B11-pipeline-context-and-error-mapper.md` — B11 `ProviderErrorMapper` (distinct, public, adapter-facing)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1 (Error orchestration concern)
- `packages/core/src/pipeline.ts` — Source file to decompose
- `packages/core/src/errors.ts` — `OrchestratorError` hierarchy, `isRetryable()`
- `M06-B1A-pipeline-generation-engine.md`, `M07-B1B-pipeline-tool-executor.md`, `M08-B1C-pipeline-retry-engine.md` — Preceding sub-milestones (B1A–B1C)
