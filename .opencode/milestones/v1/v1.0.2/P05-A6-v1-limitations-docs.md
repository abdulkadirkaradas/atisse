# A6 — v1 Limitations Documentation

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

> **Rev 2 (2026-08-20):** Applied SPSA NEEDS_REVISION — (1) symbolic source refs (no stale line ranges) + verify-at-implementation note; (2) removed archived `stale-docs/rules/roadmap.md` authority, retargeted to `DECISION-LOG.md:ADR-015, ADR-017` + `v1.x.x-candidates.md`; (3) added P02-A3 prerequisite (minimal throw set); (4) split extended-keyword Error Code into two behaviors + M14-B12 Phase 2 phasing (NOT gated on B1); (5) Node.js ≥24 source retagged to `package.json#engines`; (6) `contextPolicy` (P04-A5) consistency note; (7) expanded Verification + phasing clarification (M14-B12 Phase 2 target v1.1.0 — NOT gated on B1).

---

## 1. Task Summary

1. Add a "Known v1 Limitations" section to `docs/getting-started.md`
2. List each deferred v1 constraint with: error code (where applicable), rationale, and target version reference
3. Reference the source ADRs in `DECISION-LOG.md` and scope limits in `.opencode/skill/constraints/SKILL.md`
4. Do NOT modify any source code — documentation only
5. Document the v1.0.2 limitation that extended JSON Schema keywords in tool `inputSchema` are silently dropped — only the P02-A3 minimal throw set raises `ToolDefinitionError` (Prerequisite: P02-A3 merged — minimal throw set finalized P02-A3:112-138). Full keyword support lands in v1.1.0 (M14-B12 Phase 2 — converter capability, NOT gated on B1 per M14-B12:15).

---

## 2. Context (Why This Exists)

Currently, constraints like `stream: true` + `fallbackProvider` prohibited (ADR-017), `allowParallelTools: true` forbidden, context fail-fast behavior (ADR-015), and `Tool.execute()` input/output typing being `unknown` are documented only in internal ADR docs (`DECISION-LOG.md`) or scattered across `.opencode/skill/constraints/SKILL.md` and `.opencode/skill/interfaces/SKILL.md`.

Users hitting `ConfigValidationError` at construction or `run()` entry have to dig through `.opencode/skill/` files to understand why. This violates **Principle 1 (Explicit Over Magical)** — the documentation should surface these limitations front and centre so a developer reading the getting-started guide sees them before hitting a runtime error.

The `docs/getting-started.md` file is the primary user-facing documentation entry point. It currently covers installation, configuration, streaming, profiles, and observability, but has no "known limitations" section. After the configuration reference table (around lines 41–56 — verify at implementation time) and before the "Adding Tools" section (around line 71 — verify at implementation time), or at the end before "Next Steps", is the natural insertion point.

> **Note — `contextPolicy` (P04-A5) consistency:** `contextPolicy` (`CONTEXT_MAX_MESSAGES`/`CONTEXT_MAX_CHARS` configurable, defaults 50 / 50_000) is introduced by P04-A5. The `getting-started.md` Configuration Reference table will be updated separately after P04 merges. P05 does NOT modify existing `getting-started.md` content beyond appending the new "Known v1 Limitations" section — no contradiction with §4.2 "do not touch existing content".

---

## 3. Issues/Changes

### Issue A6-1: Missing documentation of v1 limitations

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `docs/getting-started.md`                                                                                                                            |
| Lines       | End of file (before any "Next Steps" section)                                                                                                        |
| Severity    | LOW                                                                                                                                                  |
| Description | The getting-started guide does not document known v1 limitations. Users hit `ConfigValidationError` without understanding why the constraint exists. |
| Fix         | Add a "Known v1 Limitations" section with a table listing each constraint, error code, rationale, and target version.                                |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

- Insert a **"Known v1 Limitations"** section as a level-2 heading (`## Known v1 Limitations`) before the "Next Steps" section (or at the end of the document if no "Next Steps" section exists)
- Present limitations as a **table** with the following columns:

  | Constraint | Error Code | Rationale | Target Version |
  | ---------- | ---------- | --------- | -------------- |

- Each row references the relevant ADR from `DECISION-LOG.md` and the corresponding `.opencode/skill/constraints/SKILL.md` entry
- Include a row documenting the v1.0.2 JSON Schema keyword limitation: extended keywords in tool `inputSchema` are silently dropped (only the P02-A3 minimal set throws `ToolDefinitionError` — dependent on P02-A3; see Prerequisite in §6); full keyword support lands in v1.1.0 (M14-B12 Phase 2 — converter capability, NOT gated on B1 per M14-B12:15)
- Cross-reference target version info from `DECISION-LOG.md:ADR-015, ADR-017` and `.opencode/milestones/v1/v1.x.x-candidates.md` as the source for target versions (verify at implementation time)

### 4.2 What NOT to Do

- Do NOT modify any `.ts` source files — this is a documentation-only change
- Do NOT modify `.opencode/skill/constraints/SKILL.md` or `DECISION-LOG.md` — they remain authoritative
- Do NOT remove or alter existing content in `docs/getting-started.md`
- Do NOT add ADR entries — this is a documentation summary, not a decision
- Do NOT add code samples or implementation guidance — that belongs in the feature's own documentation

---

## 5. Files to Modify

| File                      | Action      | Notes                                 |
| ------------------------- | ----------- | ------------------------------------- |
| `docs/getting-started.md` | ADD section | Insert "Known v1 Limitations" section |

---

## 6. Implementation Strategy

> **Prerequisite: P02-A3 merged — minimal throw set finalized (P02-A3:112-138).** All references to the v1.0.2 minimal keyword throw set below are dependent on P02-A3.

### Step 1: Compile v1 Limitations Table

Extract all documented v1 limitations from these sources (verify at implementation time — symbolic refs, not stale line ranges):

| Source                                                                                                                    | Items                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.opencode/skill/constraints/SKILL.md` — v1 Scope Hard Limits table                                                       | Agent planning loop, autonomous decision-making, multi-agent, workflow DAG, graph execution, parallel tools, visual editor, SaaS dashboard, prompt template DSL, distributed orchestration, cost analytics, built-in RAG — verify at implementation time |
| `.opencode/skill/constraints/SKILL.md` — Forbidden code patterns section                                                  | `allowParallelTools: true`, `maxToolRounds < 1`, `stream: true` + `fallbackProvider` — verify at implementation time                                                                                                                                     |
| `DECISION-LOG.md` ADR-015                                                                                                 | ContextProvider partial failure is fail-fast                                                                                                                                                                                                             |
| `DECISION-LOG.md` ADR-017                                                                                                 | Streaming + fallback forbidden together                                                                                                                                                                                                                  |
| `P02-A3-json-schema-converter-fix.md` (v1.0.2) — dependent on P02-A3                                                      | Minimal JSON Schema keyword throw set (`$ref`, `const`, `default`, `minItems`/`maxItems`, `patternProperties`, `type: array`, `additionalProperties` true/schema forms) — Prerequisite: P02-A3 merged (P02-A3:112-138)                                   |
| `M14-B12-boundary-schema-validation.md` (v1.1.0) — M14-B12 Phase 2 (converter capability, NOT gated on B1 per M14-B12:15) | Phase 2 — converter capability: full runtime support for extended keywords (`pattern`, `multipleOf`, `minProperties`/`maxProperties`, `uniqueItems`, `if`/`then`/`else`, `not`, `contains`, `propertyNames`, `prefixItems`)                              |
| `DECISION-LOG.md:ADR-015, ADR-017` + `.opencode/milestones/v1/v1.x.x-candidates.md`                                       | Target version source for streaming+fallback / context fail-fast — verify at implementation time                                                                                                                                                         |
| `.opencode/skill/interfaces/SKILL.md` — Tool interface (`execute: unknown`) / `interfaces.ts:122`                         | `Tool.execute()` input/output typed as `unknown` — verify at implementation time                                                                                                                                                                         |

> **Note — `contextPolicy` (P04-A5) consistency:** `contextPolicy` (`CONTEXT_MAX_MESSAGES`/`CONTEXT_MAX_CHARS` configurable, defaults 50 / 50_000) is introduced by P04-A5. This plan does NOT modify existing `docs/getting-started.md` content beyond adding the new "Known v1 Limitations" section. The `getting-started.md` Configuration Reference table (around lines 41–56) will be updated separately after P04 merges to document `contextPolicy`. Ensure no contradiction between "do not touch existing content" (§4.2) and the P04 dependency — P05 only appends the limitations section and may reference `contextPolicy` as a configurable limit once P04 is merged.

### Step 2: Add Section to getting-started.md

- Read `docs/getting-started.md` to find the correct insertion point (end of file or before any "Next Steps" section)
- Append or insert the **"## Known v1 Limitations"** section

**Example content structure:**

```markdown
## Known v1 Limitations

The following constraints apply to v1. Each will be revisited in a future version.

| Constraint                                                      | Error Code                                                                                                                                             | Rationale                                                                                                                                                                                                                                                                                  | Target Version                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `stream: true` + `fallbackProvider`                             | `ConfigValidationError`                                                                                                                                | Mid-stream recovery impossible — consumer has partial output (ADR-017)                                                                                                                                                                                                                     | v1.x.x or v2                                                                  |
| `allowParallelTools: true`                                      | `ConfigValidationError`                                                                                                                                | Tool execution is serial-only in v1                                                                                                                                                                                                                                                        | v2                                                                            |
| `maxToolRounds < 1`                                             | `ConfigValidationError`                                                                                                                                | At least one round required                                                                                                                                                                                                                                                                | N/A (always enforced)                                                         |
| ContextProvider failure is fail-fast                            | `CONTEXT_LOAD_FAILED`                                                                                                                                  | Explicit failure over silent partial context (ADR-015)                                                                                                                                                                                                                                     | v1.x.x or v2                                                                  |
| `Tool.execute()` input/output typed as `unknown`                | N/A (design limitation)                                                                                                                                | JSON Schema cannot be inferred by TypeScript; use Zod `safeParse` inside `execute()`                                                                                                                                                                                                       | v2                                                                            |
| Unsupported extended JSON Schema keywords in tool `inputSchema` | minimal set → `ToolDefinitionError` (`TOOL_DEFINITION_ERROR`) / extended set → silently dropped (no error, limitation — supported per M14-B12:130-142) | Only the v1.0.2 minimal keyword set (dependent on P02-A3) throws `ToolDefinitionError`; extended keywords (`pattern`, `multipleOf`, `minProperties`/`maxProperties`, `uniqueItems`, `if`/`then`/`else`, `not`, `contains`, `propertyNames`, `prefixItems`) are silently dropped (no error) | v1.1.0 M14-B12 Phase 2 (converter capability, NOT gated on B1 per M14-B12:15) |
| Agent planning / autonomous decisions                           | N/A (not implemented)                                                                                                                                  | Kernel, not framework (Principle 3)                                                                                                                                                                                                                                                        | v2+                                                                           |
| Workflow DAG / graph execution                                  | N/A (not implemented)                                                                                                                                  | Pipeline engine scope                                                                                                                                                                                                                                                                      | v2+                                                                           |
| Node.js ≥ 24 required                                           | N/A (environment — source: `package.json#engines`, originates from `claude-technical-analysis` Finding 2.4)                                            | Runtime target — `package.json` `engines: { "node": ">=24" }` — NOT sourced from `constraints/SKILL.md`                                                                                                                                                                                    | N/A (always enforced)                                                         |
```

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

> **Phasing note:** M14-B12 Phase 2 target v1.1.0 — NOT gated on B1 (per M14-B12:15).

Specific assertions to verify:

- All commands pass without error (no code changed)
- Verify markdown renders correctly: open `docs/getting-started.md` and confirm the "Known v1 Limitations" section appears with correct table formatting
- Each constraint row links to or references the correct ADR / source document (`DECISION-LOG.md:ADR-015, ADR-017` and `constraints/SKILL.md` symbolic sections; no stale line ranges)
- `stream: true` + `fallbackProvider` row shows `ConfigValidationError` with target `v1.x.x or v2` (sourced from `DECISION-LOG.md:ADR-017` + `v1.x.x-candidates.md`)
- `allowParallelTools: true` and `maxToolRounds < 1` rows show `ConfigValidationError` (sourced from `constraints/SKILL.md — Forbidden code patterns section`)
- ContextProvider fail-fast row shows `CONTEXT_LOAD_FAILED` with target `v1.x.x or v2` (ADR-015)
- `Tool.execute()` `unknown` row shows N/A (design limitation) with target `v2`
- Extended JSON Schema keywords row shows split Error Code: minimal set → `ToolDefinitionError` (`TOOL_DEFINITION_ERROR`) vs extended set → silently dropped (no error, limitation — supported per M14-B12:130-142); Target is `v1.1.0 M14-B12 Phase 2 (converter capability, NOT gated on B1 per M14-B12:15)` — Prerequisite: P02-A3 merged (P02-A3:112-138)
- Node.js ≥24 row shows `package.json#engines` source, not `constraints/SKILL.md`; note originates from `claude-technical-analysis` Finding 2.4
- `contextPolicy` note present: `CONTEXT_MAX_MESSAGES`/`CONTEXT_MAX_CHARS` configurable via P04-A5 — `getting-started.md` Configuration Reference updated separately after P04
- No archived `stale-docs/rules/roadmap.md` authority remains in the rendered section; target versions sourced from `DECISION-LOG.md` + `v1.x.x-candidates.md`

---

## 8. Risk Assessment

| Risk                                        | Likelihood | Impact | Mitigation                                                                                                                                            |
| ------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table becomes stale as v1 evolves           | Medium     | Low    | Update discipline; references to ADRs and constraint docs ensure authoritativeness                                                                    |
| Incorrect target version listed             | Low        | Low    | Cross-check with `DECISION-LOG.md:ADR-015, ADR-017` and `.opencode/milestones/v1/v1.x.x-candidates.md` before writing (verify at implementation time) |
| Insertion point conflicts with future edits | Low        | Low    | Insert at end of file with clear heading boundary                                                                                                     |

> **V2_EVOLUTION_PATH:** The v1 limitations table (delivered in this milestone) is manually maintained. When v2 planning begins, design a governance mechanism that syncs it with `constraints.md` and ADRs automatically. Until then, manual update discipline applies.

---

## 9. References

- `.opencode/skill/constraints/SKILL.md` — v1 Scope Hard Limits table, Forbidden code patterns section (verify at implementation time)
- `DECISION-LOG.md` — ADR-015 (context fail-fast), ADR-017 (streaming+fallback)
- `.opencode/milestones/v1/v1.x.x-candidates.md` — Target version source for v1.x.x candidates
- `P02-A3-json-schema-converter-fix.md` (v1.0.2) — Minimal keyword throw set; extended keywords out of scope — Prerequisite: P02-A3 merged (P02-A3:112-138)
- `M14-B12-boundary-schema-validation.md` (v1.1.0) — Phase 2 converter capability (full extended-keyword support, NOT gated on B1 per M14-B12:15) — M14-B12:130-142
- `.opencode/skill/interfaces/SKILL.md` — Tool interface (`execute: unknown`) / `interfaces.ts:122` (verify at implementation time)
- `.opencode/skill/principles/SKILL.md` — Principle 1: Explicit Over Magical
- `docs/getting-started.md` — Target file for the new section
- `package.json#engines` — Node.js ≥24 source (originates from `claude-technical-analysis` Finding 2.4)
- `P04-A5-context-policy-config.md` — `contextPolicy` (`CONTEXT_MAX_MESSAGES`/`CONTEXT_MAX_CHARS` configurable) — `getting-started.md` Configuration Reference updated separately after P04
