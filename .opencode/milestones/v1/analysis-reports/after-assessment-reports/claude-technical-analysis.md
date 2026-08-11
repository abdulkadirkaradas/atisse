# Atisse — v1.0.2 / v1.1.0 Implementation Plan Review

**Type:** Plan-review reference document (for AI agents)
**Reviewed inputs:**

- `.opencode/milestones/v1/analysis-reports/` (final-evaluation-and-roadmap, priority-and-implementation-order, v1.x.x-candidates)
- `.opencode/milestones/v1/v1.0.2/` (A1–A6 plans)
- `.opencode/milestones/v1/v1.1.0/` (B1–B14 plans)

**Purpose:** This document records plan-level defects found during review of the SPSA-produced roadmap and SPBED-ready implementation plans, before implementation begins. It supersedes nothing in the original `atisse-technical-analysis-report.md` — it audits the _plans written in response to it_.

---

## 1. Critical Findings (Plan-Level Defects)

### 1.1 A1 (Redis Atomic Writes) — Connection Isolation Defect

- **Plan reviewed:** `.opencode/milestones/v1/v1.0.2/05-grp-redis.md`
- **Issue:** The proposed fix calls `this.client.watch(key)` directly on the shared `RedisMemoryAdapter` client instance, then proceeds to `multi()`/`exec()`. In `node-redis` v4/v5, the default client multiplexes all commands over a single connection, and `WATCH` is connection-scoped state. If two concurrent `save()` calls share this same client (the normal runtime condition this fix is meant to address), their `WATCH` calls can interleave on the same underlying connection, corrupting the optimistic-lock guarantee the transaction depends on.
- **Evidence:** This is a documented `node-redis` pitfall (see `redis/node-redis` issues #2613, #559, and the official "Isolated Execution" guide, which explicitly recommends `client.executeIsolated()` whenever `WATCH` is combined with concurrent callers sharing one client).
- **Impact if unaddressed:** The fix may not reliably eliminate the original race condition (Finding 2.1 in the source technical-analysis-report) under real concurrent load — it could appear to pass single-threaded tests while still losing data in production under concurrency.
- **Remediation:** Replace the direct `this.client.watch(key)` call with:
  ```typescript
  await this.client.executeIsolated(async (isolatedClient) => {
    await isolatedClient.watch(key);
    const raw = await isolatedClient.get(key);
    const merged = [...(raw ? JSON.parse(raw) : []), ...messages];
    const result = await isolatedClient
      .multi()
      .setEx(key, this.ttlSeconds, JSON.stringify(merged))
      .exec();
    if (result === null) throw new WatchError('retry');
  });
  ```
  Wrap in the existing retry loop. Update plan §4.1 and §6 Step 1 accordingly before SPBED implementation.
- **Status:** Must be corrected before implementation. Return to SPSA for plan revision.

### 1.2 A3 (ToolDefinitionError) — Incomplete Keyword Coverage

- **Plan reviewed:** `.opencode/milestones/v1/v1.0.2/04-grp-validation.md`
- **Issue:** The plan only instruments the branch where `schema.type` is unrecognized (the `z.never()` fallback at `tool-controller.ts:288-292`). It does not address the more dangerous failure mode: a **recognized** type carrying an **unsupported keyword** — `const`, `default`, `minItems`/`maxItems`, `$ref`, `patternProperties`, `additionalProperties`. Source inspection confirms `jsonSchemaToZod()` never references any of these keywords anywhere in the conversion logic — they are silently dropped, not rejected.
- **Impact:** This produces silent **under-validation** rather than over-rejection: a tool schema declaring `{ type: 'string', const: 'allowed-value' }` will accept any string at runtime with no warning and no error. This is strictly worse than the `z.never()` case the plan fixes, because it is a security/correctness gap rather than a usability gap, and it currently has zero detection.
- **Remediation:** Extend A3's scope (or add a follow-up item, e.g. A3.1) to scan each schema node for the presence of any of the listed unsupported keywords regardless of whether `type` is recognized, and throw `ToolDefinitionError` naming the specific keyword found. This should reuse the same `ToolDefinitionError` class already specified in A3 §4.1 — only the detection surface needs to widen.
- **Status:** Scope gap. A3 should not be marked complete until this is included.

### 1.3 B1 (Pipeline Decomposition) — Duplication Relocated, Not Eliminated

- **Plan reviewed:** `.opencode/milestones/v1/v1.1.0/06-grp-pipeline-b1.md`
- **Issue:** The plan's own Context section (§2) explicitly states "~250 lines of duplication between streaming and non-streaming paths" and labels the fix as "pure restructuring" — i.e., the duplicated logic is moved into `streaming.ts` and `non-streaming.ts` as two separate files, not unified. B2 (PipelineContext object) addresses parameter-list ergonomics; B11 (ProviderErrorMapper) centralizes only the error-classification slice of the duplication. Neither eliminates the duplicated round-execution logic itself.
- **Impact:** The original DRY-violation finding (Finding 1.2 in the source report) will read as "resolved" once B1/B2/B11 ship, but the underlying risk — a fix applied to one path not being mirrored in the other — persists structurally, just split across two files instead of one.
- **Remediation:** Add an explicit follow-up item to the v1.1.0 Sprint 2 backlog (e.g. B15) to unify the shared round-execution loop behind a `RoundExecutionStrategy` interface (`onChunk` / `onComplete`), as originally proposed. This should be sequenced after B1 (needs the module boundaries) and can run in parallel with B11.
- **Status:** Acceptable as an interim step (B1 reduces blast radius and improves file organization), but should not be treated as the terminal fix for Finding 1.2. Track as open until B15 (or equivalent) ships.

---

## 2. Roadmap & Sequencing Assessment

The dependency graph in `priority-and-implementation-order.md` is sound and faithfully traces back to the original audit findings:

| Original finding                                        | Roadmap item(s)         | Assessment                                                                                                   |
| ------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| 2.1 Redis race condition                                | A1                      | Correct priority (Critical, first in sequence); implementation defect noted in §1.1 above                    |
| 1.6 Redis error-type mismatch                           | A2                      | Correctly sequenced after A1 (shared refactor surface)                                                       |
| 1.5 JSON Schema partial support                         | A3, B12                 | Correct two-phase split (immediate explicit error, later boundary validation); scope gap noted in §1.2 above |
| 1.4 Hardcoded context limits                            | A5                      | Correctly scoped as a config-surface foundation for B6/B7                                                    |
| 2.5 v1 limitations undocumented                         | A6                      | Correctly scoped as docs-only, zero-risk                                                                     |
| 1.1 / 1.2 / 1.3 Pipeline size, duplication, param lists | B1, B2, B11             | Correct decomposition order; duplication gap noted in §1.3 above                                             |
| 2.2 No MemoryAdapter conformance tests                  | B3                      | Correctly scoped as independent, parallelizable                                                              |
| 2.3 Coverage threshold inconsistency                    | B4                      | Correctly scoped as config-only                                                                              |
| 2.4 Node 24 requirement                                 | _(not carried forward)_ | Not present in any A/B item — see Section 3                                                                  |

**Self-identified addition not in the original report:** A4 (EventBus swallowed-listener-error logging) is a new finding the roadmap authors identified independently. This is a legitimate production-readiness gap and its inclusion is a positive sign that the SPSA review process is generating original findings, not just transcribing the input report.

---

## 3. Recommended Actions Before SPBED Implementation

1. **Block A1 implementation** until `05-grp-redis.md` §4.1 is revised to use `client.executeIsolated()` instead of direct `client.watch()` on the shared client instance.
2. **Expand A3 scope** to cover unsupported-keyword detection on recognized types, not only unrecognized `type` values, before marking the plan SPBED-ready.
3. **Add B15** (or equivalent) to the v1.1.0 Sprint 2 backlog for round-execution unification, so the DRY violation underlying Finding 1.2 has a tracked closure point rather than being implicitly closed by B1's restructuring alone.
4. **Carry forward Finding 2.4** (Node `>=24` engine requirement) into either a v1.0.2 patch item or the `v1-v2-candidates.md` deferred list — it does not currently appear in any roadmap item and risks being dropped silently.
5. Re-run this review against the revised A1 and A3 plans before SPBED begins; no other items in the current roadmap require revision.

---

## Reference Consistency Table

This table records the current live path for every referenced entity whose location has changed since this report was written. Body text above is intentionally left untouched.

| Reference (as it appears in this file)                                                       | Current Path                                                                                          | Notes                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `.opencode/milestones/v1/analysis-reports/` — `.opencode/milestones/v1/v1.x.x-candidates.md` | `.opencode/milestones/v1/v1.x.x-candidates.md`                                                        | Renamed and moved out of `milestones/v1` |
| `.opencode/milestones/v1/v1.0.2/` (A1–A6 plans)                                              | `.opencode/milestones/v1/v1.0.2/P01-A1A2-redis-atomic-writes.md` … `P05-A6-v1-limitations-docs.md`    | Renamed to `P###-` scheme                |
| `.opencode/milestones/v1/v1.1.0/` (B1–B14 plans)                                             | `.opencode/milestones/v1/v1.1.0/M01-*.md` … `M15-B14-ci-governance.md`                                | Renamed to `M###-` scheme                |
| `.opencode/milestones/v1/v1.0.2/05-grp-redis.md`                                             | `.opencode/milestones/v1/v1.0.2/P01-A1A2-redis-atomic-writes.md`                                      | Old `grp-` scheme                        |
| `.opencode/milestones/v1/v1.0.2/04-grp-validation.md`                                        | `.opencode/milestones/v1/v1.0.2/P02-A3-json-schema-converter-fix.md`                                  | Old `grp-` scheme                        |
| `.opencode/milestones/v1/v1.1.0/06-grp-pipeline-b1.md`                                       | `.opencode/milestones/v1/v1.1.0/_archive/000-superseded-b1-pipeline-decomposition.md`                 | Superseded; split into B1A–B1E           |
| `05-grp-redis.md` (bare, §3.1)                                                               | `.opencode/milestones/v1/v1.0.2/P01-A1A2-redis-atomic-writes.md`                                      | Old `grp-` scheme                        |
| `v1-v2-candidates.md` (bare, §3.4)                                                           | `.opencode/milestones/v1/v1.x.x-candidates.md`                                                        | Renamed                                  |
| Milestone `B15` (round-execution unification)                                                | `.opencode/milestones/v1/v1.1.0/M12-B15-round-execution-strategy.md`                                  | Added and implemented as M12             |
| Milestone `B2` / `B11`                                                                       | `.opencode/milestones/v1/v1.1.0/M11-B2B11-pipeline-context-and-error-mapper.md`                       | Combined                                 |
| Milestone `B3` / `B4`                                                                        | `.opencode/milestones/v1/v1.1.0/M01-B3B4-quality-conformance-and-coverage.md`                         | Combined                                 |
| Milestone `B12`                                                                              | `.opencode/milestones/v1/v1.1.0/M14-B12-boundary-schema-validation.md`                                | —                                        |
| `atisse-technical-analysis-report.md` (original)                                             | `.opencode/milestones/v1/analysis-reports/pre-assessment-reports/claude-technical-analysis-report.md` | Pre-assessment source report             |
