# Pipeline Implementation Plan M003–M012 — Draft Implementation Order & Priority

## Implementation Order (Recommended Sequence)

| Order | Plan     | Description                                                          | Priority | Dependencies                           | Rationale                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | -------- | -------------------------------------------------------------------- | -------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **M004** | Error handling: fix `handleOrchestratorError` wrapper misattribution | **P1**   | None                                   | **Highest severity (HIGH)** of any plan. Small change — one class name swap in one function + new error class. No behavioral side effects. Touches frozen interfaces (additive only — union widening). High-value, low-risk, zero-effort-to-validate.                                                                                                                               |
| 2     | **M003** | Reliability: fix shared `attempt` counter and memory save error type | **P1**   | None                                   | **Two MEDIUM-severity bugs.** Shared attempt counter causes inflated tool retry delays; `ContextLoadError` for memory save is semantically wrong. Blocks M007 (explicit prerequisite). Touches frozen interfaces (additive only). Small change — counter split in ~5 locations + new error class.                                                                                   |
| 3     | **M009** | `rejectAfter()` timer leak fix                                       | **P2**   | None                                   | **Hard prerequisite for M008 (P1).** Timer leak is a production concern under load. Small change — `withTimeout` wrapper + remove `rejectAfter` export + update 2 call sites. No interface changes. Must go first so M008 can use cleaned-up timer API.                                                                                                                             |
| 4     | **M011** | ProviderOptions `Object.assign` overwrite fix                        | **P3**   | None                                   | **Low severity, trivial effort.** Pure additive defensive code in adapter packages. No kernel changes. Can be done by any agent in minutes. High value-to-effort ratio (zero risk).                                                                                                                                                                                                 |
| 5     | **M012** | ProviderRateLimitError remapping fix                                 | **P3**   | None                                   | **Low severity, trivial effort.** Remove one misbehaving private method, fix one catch handler. Adapter-only change. Enables correct streaming rate-limit detection.                                                                                                                                                                                                                |
| 6     | **M006** | Pre-compute tool definitions array                                   | **P3**   | None                                   | **Low-severity optimization.** No behavioral change. Medium risk (missed code path). Blocks M007 (prerequisite). Small change — one computed field on `ResolvedConfig`, replace 2 inline blocks.                                                                                                                                                                                    |
| 7     | **M008** | Streaming chunk buffering fix                                        | **P1**   | **M009** (hard)                        | **HIGH severity** — current collect-then-`Promise.race` defeats streaming's purpose and creates unbounded memory growth. Cannot start until M009 provides clean timer primitives. Medium effort: add `asyncIteratorWithIdleTimeout`, restructure stream consumption. No interface changes.                                                                                          |
| 8     | **M007** | Maintainability: extract generation loop and promote `_execute`      | **P2**   | **M003**, **M006**                     | **MEDIUM severity.** Largest effort (major refactoring). After M003 and M006, the pipeline has correct counter split and pre-computed tool defs, providing stable extraction boundaries. Delayed to Phase 2 to let all bugfixes settle before restructuring. No interface changes — pure internal refactoring.                                                                      |
| 9     | **M005** | Observability: add `TimingCollector` per-step durations              | **P2**   | M007 (recommended)                     | **Moderate value feature.** Deliberately sequenced AFTER M007 to avoid rework. If done before M007, the timing marks would need to be re-placed after the generation round extraction and `_execute` promotion. After M007, timing marks land on stable extraction boundaries. Touches frozen interfaces (optional field addition only).                                            |
| 10    | **M010** | AbortController propagation                                          | **P2**   | **M008**, **M009**, M007 (recommended) | **Medium complexity feature** touching interfaces, errors, policies, and pipeline. Needs M009's `withTimeout` and M008's `asyncIteratorWithIdleTimeout` for signal integration. Best sequenced after M007 so signal propagation lands on the clean extracted function boundaries. Touches frozen interfaces (optional `signal` on `RunInput`, new error code — both additive only). |

## Execution Groups

### Phase 1 — Independent High-Value Fixes

**Phase name:** Core Bugfix Sprint
**Plans included:** M004, M003, M009, M011, M012, M006
**Rationale for grouping:** All six plans have zero interdependencies. Each touches a different concern (errors, retry counters, timer cleanup, adapter defensive coding, error remapping, performance). No two plans modify the same logical section of code in conflicting ways. Can be implemented fully in parallel.
**Estimated relative effort:** Small per-plan. Total Phase 1 effort is roughly equivalent to one medium plan (M008). Each plan is 1–3 files changed, ~20–60 lines added/modified.

### Phase 2 — Dependent Transformations

**Phase name:** Streaming & Structure
**Plans included:** M008, M007
**Rationale for grouping:** Both have hard prerequisites from Phase 1. M008 depends on M009 (clean timer for per-chunk timeout). M007 depends on M003 (counter split) and M006 (toolDefinitions field). Both are structural changes to `pipeline.ts` — M008 restructures streaming consumption, M007 refactors the non-streaming path. They touch different parts of the file (M008: `executeStreamingPipeline` only; M007: `_execute`/`executeNonStreamingPipeline` and generation loop) so they CAN be done in parallel by separate agents if desired, though sequential (M008 first) reduces merge risk.
**Estimated relative effort:** M008 = Medium, M007 = Large. Total Phase 2 is the largest effort phase.

### Phase 3 — Features on Clean Pipeline

**Phase name:** Observability & Control
**Plans included:** M005, M010
**Rationale for grouping:** Both add new capabilities on top of the stabilized pipeline. M005 (timing marks) and M010 (signal checks) both modify `pipeline.ts` by inserting calls at step boundaries. After M007's refactoring, these boundaries are clean, extracted functions with clear parameter lists — making the integration cleaner and less error-prone. They DO NOT conflict with each other (M005 adds `TimingCollector.mark()` calls, M010 adds `input.signal?.aborted` checks and `abortableSleep` calls) and can be implemented in parallel.
**Estimated relative effort:** M005 = Medium, M010 = Medium–Large.

## Parallelization Opportunities

The following plans can be assigned to separate SPBED agents simultaneously with zero or minimal merge conflict risk:

| Agent       | Plan(s) | Rationale                                                                                                                |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Agent A** | M004    | Only modifies `handleOrchestratorError` — no overlap with any other plan                                                 |
| **Agent B** | M003    | Counter split in `pipeline.ts` + new error class + interface union widening. Overlaps with M007 but M007 runs in Phase 2 |
| **Agent C** | M009    | `policies.ts` only + 2 updated imports in `pipeline.ts`. No overlap with other Phase 1 plans                             |
| **Agent D** | M011    | Adapter-only (`provider-openai` + `provider-anthropic`). No kernel changes                                               |
| **Agent E** | M012    | Adapter-only (`provider-openai`). No kernel changes                                                                      |
| **Agent F** | M006    | `types.ts` + `profile.ts` + 2 lines in `pipeline.ts`. Minimal kernel footprint                                           |

**Phase 1 total:** Up to 6 parallel agents. No merge conflicts expected (different files or non-overlapping sections of `pipeline.ts`).

**Phase 2 parallelization:**
| Agent | Plan(s) | Rationale |
|-------|---------|-----------|
| **Agent G** | M008 | `pipeline.ts` streaming path only — after M009 is merged |
| **Agent H** | M007 | `pipeline.ts` non-streaming path + extraction — after M003 and M006 are merged |

These CAN run in parallel since M008 touches `executeStreamingPipeline` (lines 690–1064) while M007 refactors `_execute`/`executeNonStreamingPipeline` (lines 414–677). The only shared code is `initializePipeline`, `executeToolRound`, and `finalizePipeline` (already extracted by M002) — neither plan modifies those. **Risk:** If both agents add lines to `pipeline.ts`, the merge could be non-trivial. Recommendation: run M008 first, then M007.

**Phase 3 parallelization:**
| Agent | Plan(s) | Rationale |
|-------|---------|-----------|
| **Agent I** | M005 | New `timing-collector.ts` + `StepTimings` in interfaces + marks in pipeline |
| **Agent J** | M010 | `RunCancelledError` + `abortableSleep` + signal checks across pipeline |

These touch different aspects of `pipeline.ts` (marks vs. signal checks). Same-function overlap is low. Safe to parallelize after M007 is merged.

## Risk-Adjusted Priority

| Plan     | Severity    | Complexity  | Regression Risk | Test Burden                                    | Touches Frozen Contracts?                 | **Final Priority** |
| -------- | ----------- | ----------- | --------------- | ---------------------------------------------- | ----------------------------------------- | ------------------ |
| **M003** | MEDIUM × 2  | Low         | Medium          | Low (3 tests updated)                          | **Yes** (union widening)                  | **P1**             |
| **M004** | HIGH        | Low         | Low             | Low (1 test updated)                           | **Yes** (union widening)                  | **P1**             |
| **M005** | MODERATE    | Medium      | Low             | Low (new test file)                            | **Yes** (optional event field)            | **P2**             |
| **M006** | LOW         | Low         | Low             | None (zero behavioral change)                  | No                                        | **P3**             |
| **M007** | MEDIUM (×3) | High        | Medium–High     | Low (no behavioral change expected)            | No                                        | **P2**             |
| **M008** | HIGH        | Medium      | Medium          | Low (streaming timeout semantics shift)        | No                                        | **P1**             |
| **M009** | MEDIUM      | Low         | Low             | Low (1 test updated)                           | No                                        | **P2**             |
| **M010** | MEDIUM      | Medium–High | Medium          | Medium (new error class, abort test scenarios) | **Yes** (optional field + union widening) | **P2**             |
| **M011** | LOW         | Very Low    | Low             | Low (new validation test scenarios)            | No                                        | **P3**             |
| **M012** | LOW         | Very Low    | Low             | Low (1 new test)                               | No                                        | **P3**             |

### Priority Definitions

| Category          | Plans                  | Criteria                                                                                                                                                                                                                                               |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1 — Critical** | M003, M004, M008       | High-severity bugs affecting correctness (error misattribution, streaming defects, incorrect retry delay, wrong error types). All have clear user-facing impact, small-to-medium implementation effort, and are backward-compatible fixes.             |
| **P2 — High**     | M005, M007, M009, M010 | Quality improvements and features. Timer leak (M009) is elevated to P2 because it blocks M008 (P1). M007 is high complexity but provides structural foundation for M005 and M010. M005 and M010 deliver new capabilities after the pipeline is stable. |
| **P3 — Medium**   | M006, M011, M012       | Low-severity optimizations and defensive fixes. Zero or trivial user-facing impact. These are "do when convenient" items — they improve code health but don't block anything except M007 (M006 is a prereq).                                           |

### Frozen Contract Impact Summary

| Plan | Change                                                                                  | Backward-Compatible?                  | Risk                                                  |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| M003 | Add `'MEMORY_SAVE_FAILED'` to `OrchestratorErrorCode` union                             | Yes (union widening)                  | Low — new code in union, catch-all branches handle it |
| M004 | Add `'PIPELINE_INTERNAL_ERROR'` to `OrchestratorErrorCode` union                        | Yes (union widening)                  | Low — same rationale as M003                          |
| M005 | Add `StepTimings` interface + `timings?: StepTimings` to `run.completed` event          | Yes (optional field)                  | Low — consumers using partial matching unaffected     |
| M010 | Add `signal?: AbortSignal` to `RunInput` + `'RUN_CANCELLED'` to `OrchestratorErrorCode` | Yes (optional field + union widening) | Low — both are backward-compatible per constraints.md |

No plan proposes a breaking change to frozen interfaces. All modifications are additive (optional fields, union widening) and are explicitly permitted by `rules/constraints.md` §Interface Modification Rules. SPSA standing approval is documented in each plan's Architectural Directives section.

### Sequencing Risk Notes

1. **M007 before M005/M010 is strongly recommended but not strictly required.** If M005 or M010 were implemented before M007, the refactoring in M007 would need to carry forward the timing marks and signal parameters into the extracted functions — adding coordination overhead. Estimated rework: 15–20% of each plan's effort.
2. **M008 before M007 avoids merge conflicts** in the streaming pipeline section. Both are structural changes but target different paths (streaming vs non-streaming). Sequential execution (M008 → M007) within Phase 2 minimizes conflicts.
3. **M006 could be deferred past M007** if the tool definitions pre-computation is done as a standalone step before the generation round extraction. Both M003 and M006 are prerequisites for M007; dropping either means M007 must retrofit the changes afterward. Both are small, low-risk plans — implement them in Phase 1.
