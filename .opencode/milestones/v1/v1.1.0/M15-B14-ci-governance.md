# B14 — CI Governance: Dependency Audit, Bundle Size, API Surface

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Extend the existing CI workflow (`.github/workflows/ci.yml`) with two new automated checks; two items below already exist and are re-verified:

1. **Dependency audit (already present)** — `pnpm audit --audit-level=high` already runs as the final CI step (`.github/workflows/ci.yml`); keep it and decide whether it stays blocking (current behavior) or becomes warn-only with the new checks.
2. **Bundle size validation** — Inspect tsup build output; enforce a size threshold (e.g., `@atisse/core` ESM bundle ≤ 100KB minified).
3. **API surface snapshot** — Use `@microsoft/api-extractor` to generate an `.api.md` report of the `@atisse/core` public API surface. Commit the report to version control. CI diffs the generated report against the committed version — any diff indicates an accidental API change.
4. **Node.js 24 CI pinning (already present)** — CI already pins Node.js 24 (`actions/setup-node` with `node-version: 24`, plus `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`); verify it stays consistent with `package.json` `engines: { node: ">=24" }`.

The two new checks are introduced as **warn-only non-blocking** steps for the first release cycle, then switched to blocking after one release cycle. The existing audit step remains blocking unless deliberately changed.

**Note:** This plan depends on B4 (coverage threshold alignment) being complete first — it establishes the quality baseline that CI governance builds upon.

---

## 2. Context (Why This Exists)

The current CI workflow (`.github/workflows/ci.yml`; process standards in the `git-workflow` skill) runs lint, typecheck, test, coverage, TypeDoc, and `pnpm audit --audit-level=high`.

- **Accidental breaking changes**: A developer could rename a public export, change a function signature, or remove a type without any test catching it. API surface snapshot diffing detects this immediately.
- **Dependency vulnerabilities**: `pnpm audit --audit-level=high` already runs in CI — no gap here; the new governance work is bundle size and API surface.
- **Bundle size regressions**: An unintentional import of a large library could bloat the bundle without any alert.

These gaps risk shipping regressions in production. Principle 6 (Production-Ready Defaults) demands automated enforcement.

---

## 3. Issues/Changes

### Issue B14: Missing CI Governance

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `.github/workflows/ci.yml`                                                                                                                                                                          |
| Lines       | MODIFY — extend the existing workflow; audit and Node-24 pinning already present                                                                                                                    |
| Severity    | LOW                                                                                                                                                                                                 |
| Description | CI pipeline has no bundle size validation or API surface snapshot checks (dependency audit already runs).                                                                                           |
| Fix         | Add two job steps: bundle size analysis (via tsup build output), API Extractor snapshot diff. Keep the existing `pnpm audit --audit-level=high` step. New checks warn-only for first release cycle. |

| Field       | Value                                                    |
| ----------- | -------------------------------------------------------- |
| File        | `packages/core/api-extractor.json` (NEW)                 |
| Lines       | N/A — new file                                           |
| Severity    | LOW                                                      |
| Description | API Extractor configuration needed for snapshot.         |
| Fix         | Create standard API Extractor config for `@atisse/core`. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**Dependency Audit (already present)**: `pnpm audit --audit-level=high` already runs as the final CI step. Keep it; if the warn-only philosophy is to apply, decide deliberately — it currently fails the build on high-severity findings (blocking).

**Bundle Size Validation**: After `pnpm build` (tsup), inspect the output bundle. Create a small script `scripts/check-bundle-size.mjs` that parses the tsup metafile or uses `fs.statSync` on the output ESM file. Threshold: `@atisse/core` ESM bundle must not exceed 100KB minified.

**API Surface Snapshot**: Use `@microsoft/api-extractor` to generate an `.api.md` report. Store the report at `packages/core/etc/atisse-core.api.md`. CI step: `pnpm --filter @atisse/core exec api-extractor run --local` then `git diff --exit-code` on the report. Any diff fails the step.

> **V2_EVOLUTION_PATH:** This milestone implements CI governance checks in warn-only mode (v1.1.0 delivery). The warn→blocking transition condition (suggested: 3 consecutive clean-green releases) and ownership must be defined at v2 planning. Structure CI scripts so the transition is a single-line configuration change.

### 4.2 What NOT to Do

- Do NOT block PRs on first introduction — warn-only period first.
- Do NOT add mutation testing (Stryker) — deferred.
- Do NOT add API Extractor as a `runtimeDependency` — it is a devDependency only.
- Do NOT modify the `build` script to fail on bundle size — keep it separate in CI.

---

## 5. Files to Modify

| File                                   | Action | Notes                                                                                                   |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`             | MODIFY | Extend the existing workflow with size + API snapshot steps (audit and Node-24 pinning already present) |
| `packages/core/api-extractor.json`     | NEW    | API Extractor configuration for `@atisse/core`                                                          |
| `packages/core/etc/atisse-core.api.md` | NEW    | API surface snapshot (generated, committed)                                                             |
| `scripts/check-bundle-size.mjs`        | NEW    | Bundle size threshold check script                                                                      |

---

## 6. Implementation Strategy

### Step 1: Add `@microsoft/api-extractor` as a devDependency

Add `@microsoft/api-extractor` to `devDependencies` in `packages/core/package.json` — the API Extractor config (`packages/core/api-extractor.json`), entry point (`src/index.ts`), and report (`etc/atisse-core.api.md`) all live in `packages/core/`, the package whose public API is snapshotted. Install: `pnpm --filter @atisse/core add -D @microsoft/api-extractor`. Root `package.json` does not need it. Build/CI-only tool — never a runtime dependency (per §4.2).

### Step 2: Create API Extractor config

Create `packages/core/api-extractor.json` pointing at `src/index.ts` as the main entry point. Use `@atisse/core` as the package name.

### Step 3: Generate baseline API report

Run `pnpm --filter @atisse/core exec api-extractor run --local` once to generate the baseline `.api.md` report. Commit this file.

### Step 4: Create bundle size check script

Create `scripts/check-bundle-size.mjs` that reads the tsup output at `packages/core/dist/index.js` and exits non-zero if the file size exceeds 100KB.

### Step 5: Extend the CI workflow

Edit the existing `.github/workflows/ci.yml`: keep the current steps (build, lint, typecheck, test, coverage, TypeDoc, `pnpm audit --audit-level=high`) and add the bundle-size check and API surface snapshot steps.

### Step 6: Verify Node.js 24 pinning

The existing workflow already pins Node 24 (`actions/setup-node` with `node-version: 24`, plus `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`). Verify it remains consistent with `package.json` `engines: { "node": ">=24" }` (root and `packages/core/package.json`).

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

1. CI workflow YAML is valid.
2. `pnpm audit --audit-level=high` runs without unhandled errors (warn-only pattern works).
3. Bundle size script correctly identifies oversized bundles.
4. API Extractor generates a valid `.api.md` report.
5. All existing tests pass.
6. CI workflow Node.js 24 pinning is verified (`actions/setup-node` with `node-version: 24`, plus `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`) and remains consistent with `package.json` `engines: { "node": ">=24" }` (root and `packages/core/package.json`).

---

## 8. Risk Assessment

| Risk                               | Likelihood | Impact | Mitigation                                                                  |
| ---------------------------------- | ---------- | ------ | --------------------------------------------------------------------------- |
| API Extractor adds CI runtime      | LOW        | LOW    | DevDependency, runs only in CI. `--local` avoids token requirement.         |
| Warn-only steps get ignored        | MEDIUM     | LOW    | Acceptable for first cycle. Blocking will be added after one release cycle. |
| Bundle size threshold is too tight | LOW        | LOW    | Adjust threshold after first run with actual bundle size.                   |

---

## 9. References

- `.opencode/skill/git-workflow/SKILL.md` — CI/CD Pipeline section
- `.opencode/skill/testing/SKILL.md` — Quality gate expectations
- `.opencode/skill/security/SKILL.md` — S-8 Dependency Security requirements
- `.opencode/skill/principles/SKILL.md` — Principle 6 (Production-Ready Defaults)
- `packages/core/src/index.ts` — Public API entry point
