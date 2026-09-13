# B1D — ErrorNormalizer (Pipeline Decomposition, Part 4 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit.
>
> **Scope note:** B1D is the pipeline-internal error **normalization** slice of B1. It is distinct from B11's `ProviderErrorMapper` (public, adapter-facing utility in `pipeline/error-mapper.ts`). The B1D module is named `error-normalizer.ts` to avoid filename collision with B11.

---

## 1. Task Summary

> _*Precondition: M06-B1A + M07-B1B + M08-B1C merged, pipeline/{index.ts,shared.ts,generation-engine.ts,non-streaming.ts,tool-executor.ts,retry-engine.ts} exists, pnpm typecheck && pnpm build green. All pipeline.ts:XXX refs are post-B1C — re-verify. Repo currently has no pipeline/ directory (only doc commits up to 6d33ce0), verify skeleton first. B1D extracts from pipeline/* shell, not monolithic pipeline.ts:1547._*

Extract the **ErrorNormalizer** — pipeline-internal error normalization — from `packages/core/src/pipeline/*` shell (post-B1C; pre-B1A `packages/core/src/pipeline.ts:1547`) into `packages/core/src/pipeline/error-normalizer.ts`:

1. Move `handleOrchestratorError()` (`pipeline.ts:158-182` pre-B1A, post-B1C `pipeline/shared.ts` or `pipeline/index.ts` — re-verify) + centralized `emitRunFailed` helper (emit `run.failed` before throw + `logger.error` S-1/S-7) + `toEventErrorPayload:55-61` (moved or imported — ownership explicit) into `error-normalizer.ts`.
2. Centralize `unknown` → `OrchestratorError` normalization; preserve retryable/fatal classification semantics via `isRetryable()`.
3. Preserve `run.failed` emission before throwing, and the no-secrets guarantee (S-1/S-7).
4. Wire 7 call-sites to use `ErrorNormalizer`: `generation-engine.ts:685` (fallback in `handleProviderError`), `853`, `1037` (afterGenerate hook), `1058` (non-streaming catch), `1146` (streaming pre-stream), `1458` (streaming afterGenerate), `1490` (streaming catch) — `streaming.ts` sites deferred to B1E, keep sync manually until B15.
5. Public API unchanged — no consumer-visible changes. Classification: internal refactor (see §5b).

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` was 1547 lines pre-B1A — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). Post-B1C the monolith is split into `pipeline/` (`index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`, `tool-executor.ts`, `retry-engine.ts`). Error normalization is one of six distinct orchestration concerns embedded in that single file (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)**.

Key behavioral facts that must be preserved:

- All errors thrown by the kernel are `OrchestratorError` subtypes — plain `Error` throws are forbidden (`constraints.md`).
- `handleOrchestratorError()` (`:158-182` pre-B1A, post-B1C — re-verify) normalizes any error surfaced from a pipeline step: it converts non-`OrchestratorError` values, classifies retryable/fatal, emits `run.failed`, and rethrows.
- No secrets in logs, errors, or events (`security.md` S-1/S-7) — error payloads never embed API keys, tokens, file paths, or line numbers; only `toolName`/`sessionId`/`attempt` (errors skill S-7).
- The streaming path (B1E) uses the same normalization — one shared `run.failed` emission contract (`architecture` Step 10).
- `toEventErrorPayload:55-61` shape `interfaces.ts:50-54` (`EventErrorPayload`) must be preserved — moved into `error-normalizer.ts` or imported explicitly.

---

## 3. Issues/Changes

### Issue B1D-1: ErrorNormalizer embedded in a God Module

| Field       | Value                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/*` shell (pre-B1A `packages/core/src/pipeline.ts:1547`; post-B1C `pipeline/shared.ts` + `pipeline/index.ts` + `pipeline/*.ts`) |
| Lines       | `handleOrchestratorError():158-182`, `toEventErrorPayload:55-61` (pre-B1A refs; post-B1C — re-verify in `pipeline/` shell)                                 |
| Severity    | HIGH                                                                                                                                                       |
| Description | Error normalization (`handleOrchestratorError()`, `run.failed` emission, `toEventErrorPayload`) is embedded in the pipeline shell.                         |
| Fix         | Extract into `pipeline/error-normalizer.ts`. Pure restructuring — no behavioral change.                                                                    |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

> _*Precondition: M06-B1A + M07-B1B + M08-B1C merged, pipeline/{index.ts,shared.ts,generation-engine.ts,non-streaming.ts,tool-executor.ts,retry-engine.ts} exists, pnpm typecheck && pnpm build green. All pipeline.ts:XXX refs are post-B1C — re-verify. Repo currently has no pipeline/ directory (only doc commits up to 6d33ce0), verify skeleton first. B1D extracts from pipeline/* shell, not monolithic pipeline.ts:1547._*

- Create `packages/core/src/pipeline/error-normalizer.ts` hosting the `ErrorNormalizer` module (pure functions; no module-level state per Principle 4).

- Move `handleOrchestratorError():158-182` (post-B1C — re-verify) into it, preserving the exact signature and behavior:
  - `unknown` → `OrchestratorError` normalization (never a plain `Error`).
  - Retryable/fatal classification preserved (via `errors.ts` `isRetryable()` — unchanged).
  - `run.failed` emitted **before** the normalized error is thrown via centralized `emitRunFailed` helper + `logger.error` (S-1/S-7 compliant — no file path/line/secret, only `toolName`/`sessionId`/`attempt`).
  - No secrets in messages (S-1/S-7) — error payloads never embed API keys, tokens, or credentials; `toEventErrorPayload:55-61` shape `interfaces.ts:50-54` preserved (moved or imported — ownership explicit).
  - `errors` skill rule 3 Always pass `cause`: `PipelineInternalError(error.message, error)` cause chain preserved; `TimeoutExceededError(timeoutMs)` cause loss is existing behavior — no change. Verify S-1 and S-7 (no file path/line/secret, only `toolName`/`sessionId`/`attempt`) per errors skill.

- **Scope boundary — B1D owns vs NOT owned:** B1D owns: `handleOrchestratorError():158-182` + centralized `emitRunFailed` helper (emit `run.failed` before throw + `logger.error` S-1/S-7) + `toEventErrorPayload:55-61` (moved or imported). NOT owned: `handleProviderError:656-705` (post-B1C — re-verify; stays in `retry-engine.ts`/`generation-engine.ts`), `ContextLoadError` wrapping `:396-397` (post-B1C — re-verify), `ToolExecutionError` wrapping `:750-751` (post-B1C — re-verify), `FallbackExhaustedError:690`, `MemorySaveError:605` — these remain at call-sites and only call `ErrorNormalizer` for normalization. No L3↔L3 import; verify via `madge --circular`.

- **Call-site wiring — 7 sites (full table, see §5 and §6 Step 2):** `685` (fallback in `handleProviderError`), `853`, `1037` (afterGenerate hook), `1058` (non-streaming catch), `1146` (streaming pre-stream), `1458` (streaming afterGenerate), `1490` (streaming catch) — all post-B1C refs — re-verify. `generation-engine.ts`, `shared.ts:initializePipeline` catch, and `streaming.ts` (deferred to B1E, keep sync manually until B15) all call `ErrorNormalizer`.

- Consumers import directly from `./error-normalizer.js` (ESM NodeNext `.js`). No re-export via `shared.ts`; `pipeline/index.ts` remains sole barrel for `executePipeline()`. No re-export via `shared.ts`; graph stays clean.

- Both `non-streaming.ts` and `streaming.ts` (B1E) consume the same normalization — single `run.failed` emission contract (`architecture` Step 10).

- All state remains local per call (Principle 4 — Stateless Core). No module-level state.

- Follow function body max 40 lines (per `code-standards/SKILL.md` / `implementation-standards.md`). Decompose further if exceeded (e.g., split `emitRunFailed`, `normalizeUnknown`, `toEventErrorPayload`).

- **Layering / circular (ADR-030):** ADR-030 L3 = `pipeline/*` may import L0–L3, L3↔L3 circular forbidden. `error-normalizer.ts` L3 may only import `errors.ts`, `interfaces.ts`, `events.ts` types, `lifecycle.ts`; must not import `generation-engine.ts` / `retry-engine.ts`. Verify via `madge --circular packages/core/src/pipeline/error-normalizer.ts`.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). `executePipeline()` must remain the single exported function with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, `errors.ts`, or any other contract file.
- Do NOT change error taxonomy, `isRetryable()` classification, or any `OrchestratorError` subtype.
- Do NOT introduce new error codes — existing codes cover all standard cases (per B11 constraint).
- Do NOT move `handleProviderError:656-705` (post-B1C — re-verify) into `error-normalizer.ts` — it stays in `retry-engine.ts`/`generation-engine.ts`; B1D only normalizes via `ErrorNormalizer` calls.
- Do NOT move `ContextLoadError` wrapping `:396-397` (post-B1C — re-verify), `ToolExecutionError` wrapping `:750-751` (post-B1C — re-verify), `FallbackExhaustedError:690`, or `MemorySaveError:605` into the normalizer — these remain at call-sites.
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files.
- Do NOT re-export `handleOrchestratorError` via `shared.ts` — consumers import directly from `./error-normalizer.js` (ESM NodeNext `.js`); `pipeline/index.ts` remains sole barrel.
- Do NOT create L3↔L3 circular: `error-normalizer.ts` must not import `generation-engine.ts` / `retry-engine.ts`; verify via `madge --circular packages/core/src/pipeline/error-normalizer.ts`.
- `errors` skill rule 3 Always pass `cause`: `PipelineInternalError(error.message, error)` cause chain preserved; `TimeoutExceededError(timeoutMs)` cause loss is existing behavior — no change. Verify S-1 and S-7 (no file path/line/secret, only `toolName`/`sessionId`/`attempt`) per errors skill.

---

## 5. Files to Modify

| File                                              | Action   | Notes                                                                                                                                                                              |
| ------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/error-normalizer.ts`  | NEW      | `ErrorNormalizer` module — `handleOrchestratorError():158-182` + `emitRunFailed()` (emit `run.failed` before throw + `logger.error` S-1/S-7) + `toEventErrorPayload:55-61` (moved) |
| `packages/core/src/pipeline/shared.ts`            | MODIFY   | `initializePipeline` catch still calls `ErrorNormalizer` (no re-export via `shared.ts`; direct import from `./error-normalizer.js`)                                                |
| `packages/core/src/pipeline/non-streaming.ts`     | MODIFY   | `:1057` catch + `:853`/`:1037` (afterGenerate hook) sites call `ErrorNormalizer` (post-B1C — re-verify)                                                                            |
| `packages/core/src/pipeline/generation-engine.ts` | MODIFY   | `:685` (fallback in `handleProviderError`) / `:853` `handleProviderError` call-site calls `ErrorNormalizer` (post-B1C — re-verify)                                                 |
| `packages/core/src/pipeline/streaming.ts`         | DEFERRED | B1E wires `:1146` (streaming pre-stream) / `:1458` (streaming afterGenerate) / `:1490` (streaming catch); until B15 keep sync manually                                             |
| `packages/core/src/pipeline/index.ts`             | MODIFY   | Top-level `run.failed` handling `:1500` calls `ErrorNormalizer` (post-B1C — re-verify)                                                                                             |
| `packages/core/src/pipeline.ts`                   | —        | Legacy monolith ref only; post-B1C paths are `pipeline/*` (remove MODIFY) — `pipeline.ts:1547` pre-B1A monolith, post-B1C verify in `pipeline/` shell                              |

> **Call-site wiring — 7 sites (post-B1C — re-verify):** `685` (fallback in `handleProviderError`), `853`, `1037` (afterGenerate hook), `1058` (non-streaming catch), `1146` (streaming pre-stream), `1458` (streaming afterGenerate), `1490` (streaming catch). `generation-engine.ts`, `shared.ts:initializePipeline` catch, and `streaming.ts` (deferred to B1E, keep sync manually until B15) all call `ErrorNormalizer`.

### 5b. Changeset / Versioning Classification

Classification: internal refactor, no `interfaces.ts` change → changeset `patch|none`, `api-extractor` diff empty, ADR-039 NOT breaking. Verify with `pnpm changeset && pnpm build && api-extractor diff`. No public type or runtime export changes. Verify with `pnpm changeset` (no changeset required if `none`, or `patch` if repo policy requires one for internal refactors) and `pnpm build && api-extractor` diff empty (no public API change).

---

## 6. Implementation Strategy

### Step 1: Create `error-normalizer.ts` — Precondition: M06-B1A + M07-B1B + M08-B1C merged, pipeline/{index.ts,shared.ts,generation-engine.ts,non-streaming.ts,tool-executor.ts,retry-engine.ts} exists, pnpm typecheck && pnpm build green. All pipeline.ts:XXX refs are post-B1C — re-verify. Repo currently has no pipeline/ directory (only doc commits up to 6d33ce0), verify skeleton first. B1D extracts from pipeline/* shell, not monolithic pipeline.ts:1547.

- Create `packages/core/src/pipeline/error-normalizer.ts`.
- Move `handleOrchestratorError():158-182` (post-B1C — re-verify) + centralized `emitRunFailed` helper (emit `run.failed` before throw + `logger.error` S-1/S-7) + `toEventErrorPayload:55-61` (moved or imported — ownership explicit) into it, preserving exact behavior. Verify `run.failed` is emitted before the normalized error is thrown.
- Layering: `error-normalizer.ts` L3 may only import `errors.ts`, `interfaces.ts`, `events.ts` types, `lifecycle.ts`; must not import `generation-engine.ts` / `retry-engine.ts` (ADR-030 L3↔L3 circular forbidden). Verify via `madge --circular packages/core/src/pipeline/error-normalizer.ts`.
- Scope: NOT owned — `handleProviderError:656-705` (post-B1C — re-verify), `ContextLoadError:396-397`, `ToolExecutionError:750-751`, `FallbackExhaustedError:690`, `MemorySaveError:605` remain at call-sites.

### Step 2: Wire 7 Call-Sites (Generation + Non-Streaming + Streaming Deferred)

- In `shared.ts` (`initializePipeline` catch), `generation-engine.ts` (`:685` fallback in `handleProviderError` / `:853` — post-B1C — re-verify), `non-streaming.ts` (`:1057` catch + `:853`/`:1037` afterGenerate hook — post-B1C — re-verify), `index.ts` (`:1500` top-level `run.failed` handling — post-B1C — re-verify), and future `streaming.ts` (B1E: `:1146` streaming pre-stream / `:1458` streaming afterGenerate / `:1490` streaming catch — post-B1C — re-verify), replace inline `handleOrchestratorError` / `run.failed` emit with calls to `ErrorNormalizer` (`handleOrchestratorError()` + `emitRunFailed()` + `toEventErrorPayload`).
- Consumers import directly from `./error-normalizer.js` (ESM NodeNext `.js`). No re-export via `shared.ts`; `pipeline/index.ts` remains sole barrel for `executePipeline()`. No re-export via `shared.ts`; graph stays clean.
- Until B15 both non-streaming and streaming call-sites must be kept manually in sync — document sync obligation in PR description (streaming deferred to B1E).
- Verify `run.failed` emit-before-throw order preserved at all 7 sites.

### Step 3: Update Imports + Verify No Circular

- Update all import paths to reference the correct `.js` modules (ESM NodeNext). `error-normalizer.ts` imports only `errors.ts` (`isRetryable`, `PipelineInternalError`, `TimeoutExceededError`), `interfaces.ts` (`EventErrorPayload` shape `50-54`), `events.ts` types, `lifecycle.ts`, `observability/logger`.
- Do NOT create `error-normalizer.ts → generation-engine.ts` or `error-normalizer.ts → retry-engine.ts` import (L3↔L3 circular forbidden per ADR-030). Verify via `madge --circular packages/core/src/pipeline/error-normalizer.ts`.

### Step 4: Verify (No Test Modification)

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage && pnpm build`.
- ALL tests must pass WITHOUT modification. This is a pure refactor — no behavioral change.
- Expanded checks: `madge --circular packages/core/src/pipeline/error-normalizer.ts` no circular; `pnpm build && api-extractor` diff empty; changeset `patch|none` (see §5b).

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
madge --circular packages/core/src/pipeline/error-normalizer.ts
pnpm changeset
api-extractor diff
```

Specific assertions to verify (expanded per M08):

- `packages/core/src/pipeline/error-normalizer.ts` exists and hosts `handleOrchestratorError():158-182` + `emitRunFailed()` (emit `run.failed` before throw + `logger.error` S-1/S-7) + `toEventErrorPayload:55-61` (moved or imported — ownership explicit; shape `interfaces.ts:50-54` preserved).
- All normalized errors are `OrchestratorError` subtypes — no plain `Error` escapes the pipeline (`isRetryable` preservation verified).
- `run.failed` emitted before the throw at all 7 sites (`685`, `853`, `1037`, `1058`, `1146`, `1458`, `1490` — post-B1C — re-verify), with identical payload shape `interfaces.ts:435` (`EventErrorPayload` S-1/S-7 sanitized — no file path/line/secret, only `toolName`/`sessionId`/`attempt`).
- MockProvider error-injection scenarios:
  - `MockProvider` enqueue `{error: ProviderRateLimitError}` → `retryable=true`, `error.code` preserved, `run.failed` payload `interfaces.ts:435` shape.
  - `MockProvider` enqueue `{error: new Error('plain')}` → `PipelineInternalError` cause chained (`cause` = original `Error`), `error.code`/`retryable`/`cause` assertions.
  - Throw `'string'` (non-Error `unknown`) → `PipelineInternalError` or `TimeoutExceededError` normalization, `cause` chain per errors skill rule 3.
  - `TimeoutExceededError(timeoutMs)` cause loss is existing behavior — no change.
- No secret material appears in error messages (S-1/S-7) — `logger.error` + `run.failed` payload sanitized.
- `toEventErrorPayload:55-61` shape `interfaces.ts:50-54` preservation verified; `isRetryable` preservation verified.
- `executePipeline()` has the exact same function signature as before; no new public exports; `api-extractor` diff empty.
- `madge --circular packages/core/src/pipeline/error-normalizer.ts` — no circular in `pipeline/` (ErrorNormalizer never imports `generation-engine.ts` / `retry-engine.ts`; ADR-030 L3↔L3 forbidden).
- `pnpm build && pnpm changeset` — changeset `patch|none` (internal refactor, no `interfaces.ts` change; ADR-039 NOT breaking).
- All tests pass without modification.

---

## 8. Risk Assessment

| Risk                                         | Likelihood | Impact | Mitigation                                                                                                                                                                                           |
| -------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error classification drift during extraction | Medium     | Medium | `isRetryable()` in `errors.ts` untouched; tests covering retry/fatal classification pass unchanged; MockProvider error-injection scenarios verify `retryable`/`code`/`cause`.                        |
| `run.failed` emission order changed          | Low        | Medium | Preserve emit-before-throw order at all 7 sites (`685`, `853`, `1037`, `1058`, `1146`, `1458`, `1490` — post-B1C — re-verify); event payload shape `interfaces.ts:435` unchanged; S-1/S-7 sanitized. |
| Collision with B11 `error-mapper.ts`         | Low        | Low    | Module named `error-normalizer.ts`; B11's `ProviderErrorMapper` remains separate and adapter-facing.                                                                                                 |
| Secret leakage regression                    | Low        | High   | S-1/S-7 review of moved code paths (`logger.error` + `run.failed` payload); error payloads never embed credentials, file paths, or line numbers.                                                     |
| L3↔L3 circular via ErrorNormalizer           | Low        | High   | `error-normalizer.ts` may only import `errors.ts`, `interfaces.ts`, `events.ts` types, `lifecycle.ts`; never `generation-engine.ts` / `retry-engine.ts` (ADR-030); verify via `madge --circular`.    |
| 7-site wiring incomplete                     | Medium     | Medium | Full table in §5/§6 Step 2 covers `685`, `853`, `1037`, `1058`, `1146`, `1458`, `1490`; streaming sites deferred to B1E but keep sync manually until B15.                                            |
| `toEventErrorPayload` ownership ambiguous    | Low        | Low    | Ownership explicit: moved into `error-normalizer.ts` or imported; shape `interfaces.ts:50-54` preserved.                                                                                             |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow (catch path of every step; Step 10 `run.failed` emission), Layer Architecture diagram (ADR-030 L3 `pipeline/*` may import L0–L3 but no L3↔L3 circular)
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical), Principle 4 (Stateless Core), Principle 7 (Small Core, Large Ecosystem)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `.opencode/skill/errors/SKILL.md` — Error hierarchy, `isRetryable()` classification, rule 3 Always pass `cause` (`PipelineInternalError(error.message, error)` cause chain), S-1/S-7 sanitization
- `.opencode/skill/security/SKILL.md` — S-1 (no secrets in logs, errors, events), S-7 (no file path/line/secret, only `toolName`/`sessionId`/`attempt`)
- `DECISION-LOG.md` — ADR-039 (B1D atomic split; B15 closure), ADR-030 (L3 `pipeline/*` layering), ADR-007 (error taxonomy)
- `.opencode/milestones/v1/v1.1.0/M11-B2B11-pipeline-context-and-error-mapper.md` — B11 `ProviderErrorMapper` (distinct, public, adapter-facing)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1 (Error orchestration concern)
- `packages/core/src/pipeline/*` shell — Source to decompose (post-B1C; pre-B1A `packages/core/src/pipeline.ts:1547` monolith — post-B1C verify in `pipeline/` shell)
- `packages/core/src/errors.ts` — `OrchestratorError` hierarchy, `isRetryable()`
- `packages/core/src/interfaces.ts` — `EventErrorPayload:50-54`, `run.failed` payload shape `:435`
- `packages/core/src/policies.ts` — `RetryPolicy` (B1D references for `isRetryable` context; not owned)
- `packages/core/src/lifecycle.ts` — Lifecycle types imported by `error-normalizer.ts` (ADR-030 L3 allowed)
- `M06-B1A-pipeline-generation-engine.md`, `M07-B1B-pipeline-tool-executor.md`, `M08-B1C-pipeline-retry-engine.md` — Preceding sub-milestones (B1A–B1C) — precondition: `pipeline/` skeleton exists; `orchestrator.ts:22` already `→ ./pipeline/index.js`; repo currently has no `pipeline/` directory (only doc commits up to `6d33ce0`), verify skeleton first
