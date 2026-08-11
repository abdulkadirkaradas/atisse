# Final Evaluation and Roadmap

**Source documents cross-examined:**

- `pre-assessment-reports/chatgpt-technical-analysis-report.md`
- `pre-assessment-reports/claude-technical-analysis-report.md`
- `pre-assessment-reports/gemini-technical-analysis-report.md`
- `v1-v2-candidates.md`

**Governing references:** `philosophy.md`, `architecture.md`, `constraints.md`

---

## Cross-Report Reconciliation

### Conflict Resolution

| Conflict                           | Reports                                                              | Resolution                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenTelemetry priority**         | ChatGPT (P1) + Gemini (recommended) vs. project scope (no mandate)   | Downgraded to MINOR for the two concrete Logger improvements (5.1, 5.2). Full OTEL deferred to v2.                                        |
| **Contract testing urgency**       | ChatGPT (P1) vs. Claude (Medium)                                     | Accepted as MINOR addition. Aligned with existing M5 Quality Gate spirit, not an urgent P1 gap.                                           |
| **Runtime validation scope**       | ChatGPT (full Zod-at-boundaries) vs. Claude (specific converter gap) | Accepted Claude's specific `jsonSchemaToZod` fix (PATCH) + boundary validation pattern (MINOR). Full schema-first rewrite is scope creep. |
| **DI Container**                   | Gemini (tsyringe/inversify)                                          | **Rejected.** Violates Principle 5 (Config Over Code) — policies are plain objects, not strategy class hierarchies.                       |
| **Coverage thresholds**            | ChatGPT (90% lines) vs. Claude (70% alignment)                       | Accepted Claude's 70% alignment between packages. ChatGPT's 90% is aspirational but contradicts current M5 exit criteria.                 |
| **Parallel tool execution target** | v1-v2 doc (v1.x.x) vs. constraints.md (FORBIDDEN in v1)              | **Overruled by constraints.md.** Parallel tool execution is v2-only. constraints.md is non-negotiable.                                    |
| **Streaming + fallback target**    | v1-v2 doc (v1.x.x) vs. constraints.md (FORBIDDEN)                    | **Overruled by constraints.md.** ADR-017 remains v2 territory.                                                                            |
| **Redis race condition priority**  | v1-v2 doc (deferred, v1.x.x) vs. Claude (Critical)                   | **Upgraded to PATCH (immediate).** Data loss risk violates Principle 4 (Stateless Core) and ADR-004 concurrent-safety guarantee.          |

### Consensus Items (All Three Reports Agree)

| Item                                                 | Alignment                                 |
| ---------------------------------------------------- | ----------------------------------------- |
| Pipeline is over-concentrated and must be decomposed | ChatGPT 1.1 / Claude 1.1-1.3 / Gemini 1.1 |
| Error handling is fragmented across adapters         | ChatGPT 1.3 / Claude 1.6 / Gemini 1.4     |
| Observability needs improvement                      | ChatGPT 2.3 / Claude 5.1 / Gemini 3       |
| Provider capabilities should be discoverable         | ChatGPT 2.4 / Gemini 3                    |

---

## Feature Evaluation Against Architecture & Philosophy

Each candidate is evaluated against the 7 principles (priority order from philosophy.md).

### Approved for Implementation

| ID      | Feature                                                       | Assessment | Rationale                                                                                                                                           |
| ------- | ------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1**  | Redis atomic writes (WATCH/MULTI/EXEC)                        | **PATCH**  | Fixes data loss. Violation of P2 (Interface-First — adapter must honor MemoryAdapter contract) and P4 (Stateless Core). No interface change needed. |
| **A2**  | Redis error type semantic mismatch                            | **PATCH**  | `save()` throwing `ContextLoadError` is a bug. Fixing to `MemorySaveError` restores correct `isRetryable()` classification.                         |
| **A3**  | JSON Schema → Zod converter -> explicit `ToolDefinitionError` | **PATCH**  | Silent `z.never()` rejection violates P1 (Explicit Over Magical). Converting to a thrown error at config time makes failure visible.                |
| **A4**  | Logger injection into EventBus                                | **PATCH**  | Swallowed listener errors violate P6 (Production-Ready Defaults). Internal change, no interface impact.                                             |
| **A5**  | Hardcoded context limits → ResolvedConfig                     | **PATCH**  | `CONTEXT_MAX_MESSAGES = 50` as a constant violates P5 (Config Over Code). Move to `contextPolicy` config field.                                     |
| **A6**  | v1 limitations documentation                                  | **PATCH**  | Missing docs violate P1 (Explicit Over Magical). Users should not need to read ADR documents to understand constraints.                             |
| **B1**  | Pipeline internal decomposition                               | **MINOR**  | Violates P7 (Small Core, Large Ecosystem) — 1547-line file is the opposite of "small core." Internal refactor; public API unchanged.                |
| **B2**  | PipelineContext object for parameter lists                    | **MINOR**  | Part of B1. 12-15 positional parameters violate P1 (Explicit Over Magical) by being error-prone.                                                    |
| **B3**  | MemoryAdapter conformance tests                               | **MINOR**  | Supports P2 (Interface-First) which is priority #1. Shared `runMemoryAdapterConformanceTests()` ensures behavioral contract compliance.             |
| **B4**  | Coverage threshold alignment (70% across all packages)        | **MINOR**  | Supports P6 (Production-Ready Defaults). Brings provider packages to same standard as core.                                                         |
| **B5**  | Structured `ToolValidationError.validationErrors`             | **MINOR**  | Additive change. Replacing `string[]` with structured `ValidationError[]` improves debuggability. Backward-compatible.                              |
| **B6**  | Best-effort context loading (`skip` mode)                     | **MINOR**  | Implements ADR-015 deferred scope. Additive config option, no breaking change.                                                                      |
| **B7**  | `contextTimeoutMs` in TimeoutPolicy                           | **MINOR**  | Optional additive field. Fine-grained control per context loading phase.                                                                            |
| **B8**  | `jitterFactor` in RetryPolicy                                 | **MINOR**  | Additive `jitterFactor?: number` alongside existing `jitter: boolean`. Preferred over union type to avoid breaking strict consumers.                |
| **B9**  | Built-in structured logger (`JsonLogger`, `PrettyLogger`)     | **MINOR**  | Addresses v1 no-op logger gap. Must respect `Logger` interface and avoid Node.js-specific APIs (`lib: ["ES2022"]`).                                 |
| **B10** | `AIProvider.estimateTokens?()` optional method                | **MINOR**  | Additive to `AIProvider` interface as optional field. Core falls back to `length/4` when absent.                                                    |
| **B11** | ProviderErrorMapper for adapter error normalization           | **MINOR**  | Centralizes the distributed error classification that all three reports flagged. Reduces adapter implementation burden.                             |
| **B12** | Runtime schema validation at external boundaries              | **MINOR**  | Applies Zod validation at adapter boundaries (tool input, provider config). Core already has Zod; this extends its use.                             |
| **B13** | Provider capability declarations (structuredOutput, vision)   | **MINOR**  | Extends existing `provider.capabilities` with additional fields. Enables orchestrator to negotiate features.                                        |
| **B14** | CI governance: dependency audit, bundle size, API snapshots   | **MINOR**  | Supports P6 (Production-Ready Defaults). API Extractor for surface snapshot prevents accidental breaking changes.                                   |

### Approved for v2 (MAJOR)

| ID     | Feature                                         | Rationale                                                                                                                  |
| ------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **C1** | Parallel tool execution                         | Blocked by constraints.md in v1. Requires `ToolController.executeRound()` contract revision and partial-failure semantics. |
| **C2** | Typed tool generics (`Tool<TInput, TOutput>`)   | Breaking interface change to `Tool`. Requires JSON Schema → TypeScript inference solution.                                 |
| **C3** | Streaming + fallback combination                | Requires new recovery contract design (ADR-017). Fundamental partial-output problem must be resolved first.                |
| **C4** | Full OpenTelemetry integration                  | Significant engineering investment. Tracing spans, metrics, and standardized observability.                                |
| **C5** | WASM / Rust core                                | Performance optimization track. Requires benchmark justification before implementation begins.                             |
| **C6** | Execution graph model (DAG-based orchestration) | Architectural shift from linear pipeline. Enables future advanced flows but requires MAJOR version.                        |

### Rejected (Out of Scope)

| Feature                           | Reports                     | Rejection Reason                                                            |
| --------------------------------- | --------------------------- | --------------------------------------------------------------------------- |
| DI Container (tsyringe/inversify) | Gemini                      | Violates Principle 5 (Config Over Code) — manual composition is intentional |
| Agent planning loop               | ChatGPT (strategic mention) | Violates Principle 3 (Kernel, Not Framework) + constraints.md               |
| Multi-agent communication         | —                           | Explicitly out-of-scope per constraints.md and philosophy.md                |
| Workflow DAG / step chaining      | ChatGPT (strategic), Gemini | Pipeline engine scope — different product per constraints.md                |
| Visual editor / no-code UI        | —                           | Not a UI project per constraints.md                                         |
| SaaS dashboard / cost analytics   | —                           | Not a SaaS per constraints.md                                               |
| Distributed orchestration         | —                           | Infrastructure concern outside kernel scope per constraints.md              |

---

## SemVer Release Roadmap

### v1.0.2 (PATCH)

Target: **Bug fixes and non-breaking improvements only.**

| Ref | Item                                                                            | Effort | Dependencies                                           |
| --- | ------------------------------------------------------------------------------- | ------ | ------------------------------------------------------ |
| A1  | Redis adapter atomic writes (WATCH/MULTI/EXEC)                                  | Medium | Redis client v5                                        |
| A2  | Redis error type semantic mismatch fix                                          | Low    | —                                                      |
| A3  | JSON Schema converter -> explicit `ToolDefinitionError` on unsupported keywords | Low    | —                                                      |
| A4  | Logger injection into EventBus                                                  | Low    | —                                                      |
| A5  | Move hardcoded context limits into `contextPolicy` config                       | Low    | Requires new field in config type (optional, additive) |
| A6  | Add "Known v1 Limitations" section to getting-started.md                        | Low    | —                                                      |

**Entry criteria:** All A1-A6 items have SPBED implementation plans approved.
**Exit criteria:** All items implemented, lint + typecheck + test CI green, `memory-redis` concurrent-save stress test passing.

---

### v1.1.0 (MINOR)

Target: **Backward-compatible additions and internal improvements.**

| Ref | Item                                                                  | Effort | Dependencies                |
| --- | --------------------------------------------------------------------- | ------ | --------------------------- |
| B1  | Pipeline internal decomposition (shared/, streaming/, non-streaming/) | High   | —                           |
| B2  | PipelineContext object for parameter reduction                        | Medium | B1 (partial)                |
| B3  | MemoryAdapter conformance test suite in core/testing/                 | Low    | —                           |
| B4  | Coverage threshold alignment to 70% across all packages               | Low    | —                           |
| B5  | Structured `ToolValidationError.validationErrors`                     | Low    | —                           |
| B6  | Best-effort context loading (`contextPolicy.onProviderFailure`)       | Low    | ADR-015                     |
| B7  | `contextTimeoutMs` in TimeoutPolicy                                   | Low    | —                           |
| B8  | `jitterFactor` in RetryPolicy                                         | Low    | —                           |
| B9  | Built-in logger (`JsonLogger`, `PrettyLogger`)                        | Medium | —                           |
| B10 | `AIProvider.estimateTokens?()` optional method                        | Medium | —                           |
| B11 | ProviderErrorMapper for adapter error normalization                   | Medium | B1 (architecture alignment) |
| B12 | Runtime schema validation at external boundaries                      | Medium | —                           |
| B13 | Provider capability extensions                                        | Low    | —                           |
| B14 | CI governance improvements                                            | Medium | —                           |

**Entry criteria:** v1.0.2 released. All items have SPSA-reviewed implementation plans.
**Exit criteria:** All items implemented, public API unchanged verified by API Extractor, coverage ≥ 70%, CI green.

---

### v2.0.0 (MAJOR)

Target: **Breaking changes and architectural shifts.**

| Ref | Item                          | Effort    | Breaking Surface                                                 |
| --- | ----------------------------- | --------- | ---------------------------------------------------------------- |
| C1  | Parallel tool execution       | Medium    | `ToolController.executeRound()` contract revision                |
| C2  | Typed tool generics           | High      | `Tool<TInput, TOutput>` — all existing tool adapters must update |
| C3  | Streaming + fallback contract | High      | New `StreamChunk` terminal type, consumer contract               |
| C4  | OpenTelemetry integration     | High      | New dependency, span context propagation                         |
| C5  | WASM / Rust core              | Very High | Build toolchain, native module loading                           |
| C6  | Execution graph model         | Very High | Pipeline replacement, migration path                             |

**Entry criteria:** All v1.1.0 items released and stable. SPSA formal architecture review for each C-item completed.
**Exit criteria:** All items passing, migration guide published for C2 (tool generics), v1→v2 codemod available.

---

## Dependency Graph

```
v1.0.2 (PATCH)
  │
  ├── A1 (Redis atomic) ── no dependencies
  ├── A2 (Error types) ─── no dependencies
  ├── A3 (JSON Schema) ─── no dependencies
  ├── A4 (Logger + EventBus) ── no dependencies
  ├── A5 (Context limits) ── new config field
  └── A6 (Docs) ────────── no dependencies
  │
  ▼
v1.1.0 (MINOR)
  │
  ├── B1 (Pipeline split) ── foundational for B11
  ├── B2 (Context object) ── partial dep on B1
  ├── B3 (Conformance tests)
  ├── B4 (Coverage)
  ├── B5 (Structured validation)
  ├── B6 (Best-effort context)
  ├── B7 (contextTimeoutMs)
  ├── B8 (jitterFactor)
  ├── B9 (Built-in logger)
  ├── B10 (Token estimator)
  ├── B11 (Error mapper) ─── depends on B1
  ├── B12 (Schema validation)
  ├── B13 (Capability extensions)
  └── B14 (CI governance)
  │
  ▼
v2.0.0 (MAJOR)
  │
  ├── C1 (Parallel tools) ── independent
  ├── C2 (Typed generics) ── independent
  ├── C3 (Streaming+fallback) ── ADR-017 design
  ├── C4 (OpenTelemetry) ─── independent
  ├── C5 (WASM core) ─────── independent
  └── C6 (Graph model) ───── replaces pipeline (B1)
```

---

## Items Explicitly Not Scheduled

| Item                                        | Reason                                                                                                                                                        | Source      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Architecture Decision Records (`docs/adr/`) | Already has decision_log.md. Formal ADRs would duplicate existing process.                                                                                    | ChatGPT 3.4 |
| Mutation testing (Stryker)                  | Premature. Coverage is not yet at target; mutation adds process overhead before baseline is stable.                                                           | ChatGPT 3.3 |
| Reduce Node.js minimum from 24              | Investigated by Claude 2.4 but no concrete API dependency on Node 24 was identified that forces the constraint. Deferred — revisit when adoption data exists. | Claude 2.4  |
| Package thinness restructuring              | Cosmetic. Structure before substance — add functionality first, then reorganize when justified by complexity.                                                 | ChatGPT 1.4 |

---

## Evaluation Summary

| Source           | Total Findings | Approved                                         | Rejected / Deferred                                                                                                                                                 |
| ---------------- | -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT Report   | 16             | 9 (A3, A5, B1, B11, B12, B13, B14, C4, C6)       | 7 (OTEL full scope downgraded, ADRs deferred, mutation testing deferred, package thinness deferred, execution graph to v2, memory evolution to v2, event bus to v2) |
| Claude Report    | 12             | 11 (A1, A2, A3, A4, A5, A6, B2, B3, B4, A6, B1)  | 1 (Node 24 investigation deferred)                                                                                                                                  |
| Gemini Report    | 8              | 5 (B1, B11, B13, C4, C6)                         | 3 (DI Container rejected, tool execution engine merged into B1, advanced testing partially covered by B3/B4)                                                        |
| v1-v2 Candidates | 12             | 11 (A1, B5, B6, B7, B8, B9, B10, C1, C2, C3, C5) | 1 (Parallel tools moved from v1.x.x to v2 per constraints.md)                                                                                                       |

**Total approved: 6 PATCH + 14 MINOR + 6 MAJOR = 26 items** across the SemVer roadmap.

---

## Sign-off

This evaluation was produced by cross-examining all four source reports against:

- `philosophy.md` — 7 principles (priority order enforced)
- `architecture.md` — layer rules, execution flow, internal structure
- `constraints.md` — v1 scope hard limits, forbidden patterns
- `interfaces-core.md` + `interfaces-runtime.md` — frozen contract rules
- `security.md` — trust boundaries
- `decision-log.md` — ADR references for deferred features

All approved items respect the frozen contract boundaries. No approved item introduces a runtime dependency to `@atisse/core`. No approved item violates the Kernel-Not-Framework boundary.

---

## Reference Consistency Table

This table records the current live path for every referenced entity whose location has changed since this report was written. Body text above is intentionally left untouched.

| Reference (as it appears in this file)                        | Current Path                                                                                           | Notes                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `pre-assessment-reports/chatgpt-technical-analysis-report.md` | `.opencode/milestones/v1/analysis-reports/pre-assessment-reports/chatgpt-technical-analysis-report.md` | Still current — no change                                |
| `pre-assessment-reports/claude-technical-analysis-report.md`  | `.opencode/milestones/v1/analysis-reports/pre-assessment-reports/claude-technical-analysis-report.md`  | Still current — no change                                |
| `pre-assessment-reports/gemini-technical-analysis-report.md`  | `.opencode/milestones/v1/analysis-reports/pre-assessment-reports/gemini-technical-analysis-report.md`  | Still current — no change                                |
| `v1-v2-candidates.md`                                         | `.opencode/milestones/v1/v1.x.x-candidates.md`                                                         | Renamed and moved out to `milestones/v1`                 |
| `philosophy.md`                                               | `.opencode/skill/principles/SKILL.md`                                                                  | Rules folder migrated to skills                          |
| `architecture.md`                                             | `.opencode/skill/architecture/SKILL.md`                                                                | Rules folder migrated to skills                          |
| `constraints.md`                                              | `.opencode/skill/constraints/SKILL.md`                                                                 | Rules folder migrated to skills                          |
| `interfaces-core.md` + `interfaces-runtime.md`                | `.opencode/skill/interfaces/SKILL.md`                                                                  | Both merged into the interfaces skill                    |
| `security.md`                                                 | `.opencode/skill/security/SKILL.md`                                                                    | Rules folder migrated to skills                          |
| `decision-log.md` / `decision_log.md`                         | `DECISION-LOG.md`                                                                                      | Decision log at repo root                                |
| `getting-started.md`                                          | `docs/getting-started.md`                                                                              | —                                                        |
| Milestone `A1`–`A6`                                           | `.opencode/milestones/v1/v1.0.2/P01-A1A2-redis-atomic-writes.md` … `P05-A6-v1-limitations-docs.md`     | Renamed to `P###-` scheme                                |
| Milestone `B1`–`B14`                                          | `.opencode/milestones/v1/v1.1.0/M01-*.md` … `M15-B14-ci-governance.md`                                 | Renamed to `M###-` scheme; B1 archived under `_archive/` |
