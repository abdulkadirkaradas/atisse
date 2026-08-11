# A6 — v1 Limitations Documentation

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

1. Add a "Known v1 Limitations" section to `docs/getting-started.md`
2. List each deferred v1 constraint with: error code (where applicable), rationale, and target version reference
3. Reference the source ADRs in `DECISION-LOG.md` and scope limits in `.opencode/skill/constraints/SKILL.md`
4. Do NOT modify any source code — documentation only

---

## 2. Context (Why This Exists)

Currently, constraints like `stream: true` + `fallbackProvider` prohibited (ADR-017), `allowParallelTools: true` forbidden, context fail-fast behavior (ADR-015), and `Tool.execute()` input/output typing being `unknown` are documented only in internal ADR docs (`DECISION-LOG.md`) or scattered across `.opencode/skill/constraints/SKILL.md` and `.opencode/skill/interfaces/SKILL.md`.

Users hitting `ConfigValidationError` at construction or `run()` entry have to dig through `.opencode/skill/` files to understand why. This violates **Principle 1 (Explicit Over Magical)** — the documentation should surface these limitations front and centre so a developer reading the getting-started guide sees them before hitting a runtime error.

The `docs/getting-started.md` file is the primary user-facing documentation entry point. It currently covers installation, configuration, streaming, profiles, and observability, but has no "known limitations" section. After the configuration reference table (line 41–56) and before the "Adding Tools" section (line 71), or at the end before "Next Steps", is the natural insertion point.

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
- Cross-reference target version info from the `stale-docs/rules/roadmap.md` archive

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

### Step 1: Compile v1 Limitations Table

Extract all documented v1 limitations from these sources:

| Source                                                                    | Items                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.opencode/skill/constraints/SKILL.md` lines 10–28 (v1 Scope Hard Limits) | Agent planning loop, autonomous decision-making, multi-agent, workflow DAG, graph execution, parallel tools, visual editor, SaaS dashboard, prompt template DSL, distributed orchestration, cost analytics, built-in RAG |
| `.opencode/skill/constraints/SKILL.md` lines 207–231 (forbidden config)   | `allowParallelTools: true`, `maxToolRounds < 1`, `stream: true` + `fallbackProvider`                                                                                                                                     |
| `DECISION-LOG.md` ADR-015                                                 | ContextProvider partial failure is fail-fast                                                                                                                                                                             |
| `DECISION-LOG.md` ADR-017                                                 | Streaming + fallback forbidden together                                                                                                                                                                                  |
| (archived: `stale-docs/rules/roadmap.md` lines 279–291)                   | `Tool.execute()` input/output is `unknown`, streaming + fallback cannot be combined, ContextProvider fail-fast                                                                                                           |
| `.opencode/skill/interfaces/SKILL.md` line 166                            | `Tool.execute()` input/output typed as `unknown`                                                                                                                                                                         |

### Step 2: Add Section to getting-started.md

- Read `docs/getting-started.md` to find the correct insertion point (end of file or before any "Next Steps" section)
- Append or insert the **"## Known v1 Limitations"** section

**Example content structure:**

```markdown
## Known v1 Limitations

The following constraints apply to v1. Each will be revisited in a future version.

| Constraint                                       | Error Code              | Rationale                                                                            | Target Version        |
| ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------ | --------------------- |
| `stream: true` + `fallbackProvider`              | `ConfigValidationError` | Mid-stream recovery impossible — consumer has partial output (ADR-017)               | v1.x.x or v2          |
| `allowParallelTools: true`                       | `ConfigValidationError` | Tool execution is serial-only in v1                                                  | v2                    |
| `maxToolRounds < 1`                              | `ConfigValidationError` | At least one round required                                                          | N/A (always enforced) |
| ContextProvider failure is fail-fast             | `CONTEXT_LOAD_FAILED`   | Explicit failure over silent partial context (ADR-015)                               | v1.x.x or v2          |
| `Tool.execute()` input/output typed as `unknown` | N/A (design limitation) | JSON Schema cannot be inferred by TypeScript; use Zod `safeParse` inside `execute()` | v2                    |
| Agent planning / autonomous decisions            | N/A (not implemented)   | Kernel, not framework (Principle 3)                                                  | v2+                   |
| Workflow DAG / graph execution                   | N/A (not implemented)   | Pipeline engine scope                                                                | v2+                   |
| Node.js ≥ 24 required                            | N/A (environment)       | Runtime target — `package.json` `engines: { "node": ">=24" }`                        | N/A (always enforced) |
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

- All commands pass without error (no code changed)
- Verify markdown renders correctly: open `docs/getting-started.md` and confirm the "Known v1 Limitations" section appears with correct table formatting
- Each constraint row links to or references the correct ADR / source document

---

## 8. Risk Assessment

| Risk                                        | Likelihood | Impact | Mitigation                                                                         |
| ------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------- |
| Table becomes stale as v1 evolves           | Medium     | Low    | Update discipline; references to ADRs and constraint docs ensure authoritativeness |
| Incorrect target version listed             | Low        | Low    | Cross-check with archived `stale-docs/rules/roadmap.md` before writing             |
| Insertion point conflicts with future edits | Low        | Low    | Insert at end of file with clear heading boundary                                  |

> **V2_EVOLUTION_PATH:** The v1 limitations table (delivered in this milestone) is manually maintained. When v2 planning begins, design a governance mechanism that syncs it with `constraints.md` and ADRs automatically. Until then, manual update discipline applies.

---

## 9. References

- `.opencode/skill/constraints/SKILL.md` — v1 Scope Hard Limits table, forbidden config patterns
- `DECISION-LOG.md` — ADR-015 (context fail-fast), ADR-017 (streaming+fallback)
- `.opencode/stale-docs/rules/roadmap.md` — Known Limitations (v1) section, v2+ Boundary table (archived)
- `.opencode/skill/interfaces/SKILL.md` — `Tool.execute()` typing (line 166)
- `.opencode/skill/principles/SKILL.md` — Principle 1: Explicit Over Magical
- `docs/getting-started.md` — Target file for the new section
