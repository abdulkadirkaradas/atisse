# B14 — CI Governance: Dependency Audit, Bundle Size, API Surface

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Extend the existing CI workflow (`.github/workflows/ci.yml`) with two new automated checks; two items below already exist and are re-verified:

1. **Dependency audit (already present)** — `pnpm audit --audit-level=high` already runs as the final CI step (`.github/workflows/ci.yml`); it remains blocking (not warn-only) — `pnpm audit --audit-level=high` must still fail the build on high-severity findings.
2. **Bundle size validation** — Inspect tsup build output; enforce separate ESM/CJS thresholds (unminified) — see §4.1 for `ESM_LIMIT`/`CJS_LIMIT` definitions.
3. **API surface snapshot** — Use `@microsoft/api-extractor` to generate an `.api.md` report of the `@atisse/core` public API surface. Commit the report to version control. CI diffs the generated report against the committed version — any diff indicates an accidental API change.
4. **Node.js 24 CI pinning (already present)** — CI already pins Node.js 24 (`actions/setup-node` with `node-version: 24`, plus `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`); verify it stays consistent with `package.json` `engines: { node: ">=24" }`.

The two new checks are introduced as **warn-only non-blocking** steps (`continue-on-error: true` in GH Actions — see §4.2 and §6 Step 5), then switched to blocking after one minor release OR 3 consecutive green CI runs, tracked in issue #TBD. The existing audit step remains blocking.

**Note:** This plan depends on B4 (coverage threshold alignment) being complete first — it establishes the quality baseline that CI governance builds upon.

---

## 2. Context (Why This Exists)

The current CI workflow (`.github/workflows/ci.yml`; process standards in the `git-workflow` skill) runs lint, typecheck, test, coverage, TypeDoc, and `pnpm audit --audit-level=high`.

- **Accidental breaking changes**: A developer could rename a public export, change a function signature, or remove a type without any test catching it. API surface snapshot diffing detects this immediately.
- **Dependency vulnerabilities**: `pnpm audit --audit-level=high` already runs in CI — no gap here; the new governance work is bundle size and API surface. Audit remains blocking.
- **Bundle size regressions**: An unintentional import of a large library could bloat the bundle without any alert.

These gaps risk shipping regressions in production. Principle 6 (Production-Ready Defaults) demands automated enforcement.

---

## 3. Issues/Changes

### Issue B14: Missing CI Governance

| Field       | Value                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `.github/workflows/ci.yml`                                                                                                                                                                  |
| Lines       | MODIFY — extend the existing workflow; audit and Node-24 pinning already present                                                                                                            |
| Severity    | LOW                                                                                                                                                                                         |
| Description | CI pipeline has no bundle size validation or API surface snapshot checks (dependency audit already runs).                                                                                   |
| Fix         | Add two job steps: bundle size analysis (via tsup build output), API Extractor snapshot diff. Keep the existing `pnpm audit --audit-level=high` step. New checks warn-only for first cycle. |

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| File        | `packages/core/api-extractor.json` (NEW)                                                             |
| Lines       | N/A — new file                                                                                       |
| Severity    | LOW                                                                                                  |
| Description | API Extractor configuration needed for snapshot.                                                     |
| Fix         | Create standard API Extractor config for `@atisse/core` pointing at built types (`dist/index.d.ts`). |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**Dependency Audit (already present)**: `pnpm audit --audit-level=high` already runs as the final CI step. It remains blocking (not warn-only) — `pnpm audit --audit-level=high` must still fail the build on high-severity findings. Do not convert it to warn-only. This clarifies the previous ambiguous "decide" wording.

**Coverage gate preservation (M01):** `vitest.base.config.ts:7` sets `lines: 60` baseline; `packages/core/vitest.config.ts:15-18` overrides to `lines: 70, branches: 70`; M01 raises `provider-openai` and `provider-anthropic` to `lines: 70, branches: 70`. CI `pnpm test:coverage` must still `fail-on-drop` with `exit 1` when thresholds are not met (no `continue-on-error`). TypeDoc step (`pnpm run docs`) is preserved. Branch protection required check `ci` (per `git-workflow` skill:69) must remain required — new warn-only steps must not weaken it.

**Bundle Size Validation**: After `pnpm build` (tsup), inspect the output bundle. Create a small script `scripts/check-bundle-size.mjs` that uses `fs.statSync` on the built artifacts. Threshold: separate limits for each artifact (unminified build — `tsup.config.ts` has no `minify: true`):

```javascript
const ESM_LIMIT = 100 * 1024;
const CJS_LIMIT = 100 * 1024; // ESM unminified; if minify:true then 70KB
```

- Current baseline (stat 2026-06-18, unminified): `dist/index.js:61_658 bytes`, `dist/index.cjs:63_998 bytes`. These are unminified; the previous "minified" claim is removed. If a future chore adds `minify: true` to `tsup.config.ts`, use `70KB` as the minified limit.
- Script must check both artifacts separately via `fs.statSync` — `packages/core/dist/index.js` (ESM) against `ESM_LIMIT` and `packages/core/dist/index.cjs` (CJS) against `CJS_LIMIT`. It must not measure the `testing/mock-provider` chunk (`packages/core/dist/testing/mock-provider.js` / `testing/index.js` entry `tsup.config.ts:5-6`); only `dist/index.{js,cjs}` are subject to the threshold.
- `tsup` does not emit a metafile unless `metafile: true` is added to `tsup.config.ts` — do not add dead `metafile` parsing code to the script unless `metafile: true` is introduced as a separate chore. Current implementation uses `fs.statSync` only.

**API Surface Snapshot**: Use `@microsoft/api-extractor` to generate an `.api.md` report. Store the report at `packages/core/etc/atisse-core.api.md`. CI step: `pnpm --filter @atisse/core exec api-extractor run --local` then `git diff --exit-code` on the report. Any diff fails the step (warn-only via `continue-on-error: true` — see §4.2).

Create `packages/core/api-extractor.json` pointing at the **built types** (`dist/index.d.ts`), not source. The public API entry is `packages/core/src/index.ts:1` (re-exports), but API Extractor must read the built declaration `packages/core/dist/index.d.ts` (produced by `packages/core/tsup.config.ts:3-6` with `dts: true`). Prerequisite: `mkdir -p packages/core/etc` before first run (see §6 Step 2).

```json
{
  "$schema": "https://api-extractor.microsoft.com/schemas/api-extractor.schema.json",
  "mainEntryPointFilePath": "<projectFolder>/dist/index.d.ts",
  "dtsRollup": { "enabled": true, "untrimmedFilePath": "" },
  "apiReport": { "enabled": true, "reportFolder": "<projectFolder>/etc" },
  "docModel": { "enabled": false },
  "messages": { "extractorMessageReporting": { "default": { "logLevel": "warning" } } }
}
```

Resolved example: `"mainEntryPointFilePath": "<projectFolder>/dist/index.d.ts"` resolves to `packages/core/dist/index.d.ts` at build time; `"reportFolder": "<projectFolder>/etc"` resolves to `packages/core/etc`.

> **V2_EVOLUTION_PATH:** This milestone implements CI governance checks in warn-only mode (v1.1.0 delivery). The warn → blocking transition is: warn → blocking after 1 minor release OR 3 consecutive green CI runs, tracked in issue #TBD. Structure CI scripts so the transition is a single-line configuration change (remove `continue-on-error: true`).

### 4.2 What NOT to Do

- Do NOT block PRs on first introduction — warn-only period first. New steps use `continue-on-error: true` (GH Actions warn-only mechanism — see §6 Step 5 snippet). Existing `pnpm audit --audit-level=high` remains blocking (not warn-only).
- Do NOT add mutation testing (Stryker) — deferred.
- Do NOT add API Extractor as a `runtimeDependency` — it is a devDependency only (version pin `^7.50.0`, audited per S-8).
- Do NOT modify the `build` script to fail on bundle size — keep it separate in CI.
- GH Actions warn-only mechanism for the two new steps:

```yaml
- name: Bundle size check
  continue-on-error: true
  run: node scripts/check-bundle-size.mjs
- name: API surface snapshot
  continue-on-error: true
  run: |
    pnpm --filter @atisse/core exec api-extractor run --local
    git diff --exit-code packages/core/etc/atisse-core.api.md || echo "::warning::API surface drift detected (warn-only)"
```

Only the two new steps are `continue-on-error: true`; `pnpm audit --audit-level=high`, `pnpm test:coverage`, and TypeDoc remain blocking.

---

## 5. Files to Modify

| File                                   | Action | Notes                                                                                                                                                                           |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`             | MODIFY | Extend the existing workflow with size + API snapshot steps (audit and Node-24 pinning already present); new steps `continue-on-error: true`, audit remains blocking            |
| `packages/core/api-extractor.json`     | NEW    | API Extractor configuration for `@atisse/core` — `mainEntryPointFilePath: <projectFolder>/dist/index.d.ts` (built types), `reportFolder: <projectFolder>/etc`                   |
| `packages/core/etc/atisse-core.api.md` | NEW    | API surface snapshot (generated, committed) — prerequisite `mkdir -p packages/core/etc` before generation                                                                       |
| `scripts/check-bundle-size.mjs`        | NEW    | Bundle size threshold check script — `fs.statSync` on `dist/index.js` vs `ESM_LIMIT` and `dist/index.cjs` vs `CJS_LIMIT`; no metafile parsing unless `tsup metafile:true` added |

---

## 5b. Changeset / Versioning

Infra only, no `@atisse/core` version bump → changeset: none (or `chore(ci): add bundle-size + api-extractor governance (warn-only) with changeset none`). Same as M06-M12 §5b pattern. `packages/core/src/interfaces.ts:1-458` unchanged, `packages/core/src/index.ts:1` public re-exports unchanged, `api-design` MAJOR none. No runtime code change, no public API change, no adapter change.

---

## 6. Implementation Strategy

### Step 1: Add `@microsoft/api-extractor` as a devDependency

Add `@microsoft/api-extractor` to `devDependencies` in `packages/core/package.json` — the API Extractor config (`packages/core/api-extractor.json`), entry point (`src/index.ts`), and report (`etc/atisse-core.api.md`) all live in `packages/core/`, the package whose public API is snapshotted. Install: `pnpm --filter @atisse/core add -D @microsoft/api-extractor@^7.50.0`. Version pin `^7.50.0` per S-8; run `pnpm audit --audit-level=high` after install to verify no high-severity advisories. Root `package.json` does not need it. Build/CI-only tool — never a runtime dependency (per §4.2).

### Step 2: Create API Extractor config

Create `packages/core/api-extractor.json` pointing at the built declaration `"<projectFolder>/dist/index.d.ts"` (not `src/index.ts`). Use `@atisse/core` as the package name. Prerequisite: `mkdir -p packages/core/etc` before first `api-extractor run` (report folder must exist). Full config:

```json
{
  "$schema": "https://api-extractor.microsoft.com/schemas/api-extractor.schema.json",
  "mainEntryPointFilePath": "<projectFolder>/dist/index.d.ts",
  "dtsRollup": { "enabled": true, "untrimmedFilePath": "" },
  "apiReport": { "enabled": true, "reportFolder": "<projectFolder>/etc" },
  "docModel": { "enabled": false },
  "messages": { "extractorMessageReporting": { "default": { "logLevel": "warning" } } }
}
```

References: `packages/core/src/index.ts:1` is the public re-export entry; `packages/core/dist/index.d.ts` is the build output read by API Extractor; `packages/core/tsup.config.ts:3-6` has `dts: true` which produces `dist/index.d.ts`.

### Step 3: Generate baseline API report

Run `mkdir -p packages/core/etc && pnpm --filter @atisse/core exec api-extractor run --local` once to generate the baseline `.api.md` report. Commit this file as `packages/core/etc/atisse-core.api.md`.

### Step 4: Create bundle size check script

Create `scripts/check-bundle-size.mjs` that reads tsup outputs at `packages/core/dist/index.js` (ESM) and `packages/core/dist/index.cjs` (CJS) and exits non-zero if either exceeds its threshold. It must not check `testing/mock-provider` chunks.

```javascript
import fs from 'node:fs';

const ESM_LIMIT = 100 * 1024;
const CJS_LIMIT = 100 * 1024; // ESM unminified; if minify:true then 70KB

function check(file, limit, label) {
  const { size } = fs.statSync(file);
  if (size > limit) {
    console.error(`${label} bundle size ${size} exceeds ${limit} (${file})`);
    return false;
  }
  console.log(`${label} bundle size ${size} OK (limit ${limit})`);
  return true;
}

// Note: tsup metafile not emitted unless tsup.config.ts has metafile:true — do not parse metafile here.
// Only check dist/index.{js,cjs}; testing/mock-provider chunk is excluded.
// Baseline 2026-06-18 unminified: dist/index.js 61_658 bytes, dist/index.cjs 63_998 bytes.

const esmOk = check('packages/core/dist/index.js', ESM_LIMIT, 'ESM');
const cjsOk = check('packages/core/dist/index.cjs', CJS_LIMIT, 'CJS');
process.exit(esmOk && cjsOk ? 0 : 1);
```

Notes:

- Uses `fs.statSync` only — no metafile unless `tsup` `metafile: true` is added as a separate chore (dead code otherwise).
- `tsup` output `packages/core/dist/index.js` is correct; `testing/mock-provider` entry (`tsup.config.ts` entry `testing/mock-provider`) produces `dist/testing/mock-provider.js` which is excluded from the size check.
- If a future chore adds `minify: true` to `tsup.config.ts`, lower limit to `70KB`.

### Step 5: Extend the CI workflow

Edit the existing `.github/workflows/ci.yml`: keep the current steps (build, lint, typecheck, test, coverage, TypeDoc, `pnpm audit --audit-level=high`) and add the bundle-size check and API surface snapshot steps as warn-only (`continue-on-error: true`). `pnpm audit --audit-level=high` remains blocking (no `continue-on-error`).

```yaml
- name: Bundle size check
  continue-on-error: true
  run: node scripts/check-bundle-size.mjs
- name: API surface snapshot
  continue-on-error: true
  run: |
    pnpm --filter @atisse/core exec api-extractor run --local
    git diff --exit-code packages/core/etc/atisse-core.api.md || echo "::warning::API surface drift detected (warn-only)"
```

The warn → blocking transition after 1 minor release OR 3 consecutive green CI runs (tracked in issue #TBD) is a single-line change: remove `continue-on-error: true` from each step. Audit step is not part of this transition — it remains blocking.

### Step 6: Verify Node.js 24 pinning

The existing workflow already pins Node 24 (`actions/setup-node` with `node-version: 24`, plus `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`). Verify it remains consistent with `package.json` `engines: { "node": ">=24" }` (root and `packages/core/package.json`).

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm build && ls packages/core/etc/atisse-core.api.md packages/core/dist/index.{js,cjs}
pnpm --filter @atisse/core exec api-extractor run --local && git diff --exit-code -- packages/core/etc/
pnpm test:coverage # must still exit 1 if <70/70 (M01 gate)
node scripts/check-bundle-size.mjs; echo $? # 0 pass, 1 fail; CI continue-on-error true -> warning
pnpm audit --audit-level=high # must still block
```

Full check:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify:

1. CI workflow YAML is valid.
2. `pnpm audit --audit-level=high` runs and remains blocking (exits non-zero on high-severity) — not warn-only.
3. Bundle size script correctly identifies oversized bundles: `node scripts/check-bundle-size.mjs; echo $?` returns `0` when both `dist/index.js` ≤ `ESM_LIMIT` and `dist/index.cjs` ≤ `CJS_LIMIT`, `1` otherwise; CI step is `continue-on-error: true` so it surfaces as warning not failure.
4. API Extractor generates a valid `.api.md` report at `packages/core/etc/atisse-core.api.md` via `mainEntryPointFilePath: <projectFolder>/dist/index.d.ts` (built types); `pnpm --filter @atisse/core exec api-extractor run --local && git diff --exit-code -- packages/core/etc/` detects drift; CI step is `continue-on-error: true`.
5. All existing tests pass.
6. CI workflow Node.js 24 pinning is verified (`actions/setup-node` with `node-version: 24`, plus `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`) and remains consistent with `package.json` `engines: { "node": ">=24" }` (root and `packages/core/package.json`).
7. Coverage gate still enforced: `vitest.base.config.ts:7 lines:60` baseline and `packages/core/vitest.config.ts:15-18 lines:70 branches:70` plus M01 `provider-openai`/`provider-anthropic` `lines:70 branches:70` still `fail-on-drop` with `exit 1`; TypeDoc step preserved; branch protection required check `ci` (per `git-workflow:69`) still required.
8. Prerequisite `mkdir -p packages/core/etc` exists before `api-extractor run`; `tsup` output is `packages/core/dist/index.js` (ESM) and `packages/core/dist/index.cjs` (CJS) — size check excludes `testing/mock-provider` chunk.
9. Note mismatch check: `ci.yml:45` runs `pnpm lint:all` while `package.json:10-11` defines both `lint` (`eslint .`) and `lint:all` (`pnpm --recursive lint`) — CI uses `lint:all` intentionally (recursive); verify no drift.

---

## 8. Risk Assessment

| Risk                               | Likelihood | Impact | Mitigation                                                                                                                                                                |
| ---------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Extractor adds CI runtime      | LOW        | LOW    | DevDependency `^7.50.0`, audited per S-8, runs only in CI. `--local` avoids token requirement.                                                                            |
| Warn-only steps get ignored        | MEDIUM     | LOW    | Acceptable for first cycle. Blocking after 1 minor release OR 3 consecutive green CI runs, tracked in issue #TBD.                                                         |
| Bundle size threshold is too tight | LOW        | LOW    | Unminified baseline 61_658/63_998 bytes well under 100KB; adjust threshold after first run if needed; separate `ESM_LIMIT`/`CJS_LIMIT`; if `minify:true` added then 70KB. |

---

## 9. References

- `.opencode/skill/git-workflow/SKILL.md` — CI/CD Pipeline section, branch protection required check `ci` (:69)
- `.opencode/skill/testing/SKILL.md` — Quality gate expectations, `fail-on-drop` coverage
- `.opencode/skill/security/SKILL.md` — S-8 Dependency Security requirements
- `.opencode/skill/principles/SKILL.md` — Principle 6 (Production-Ready Defaults)
- `packages/core/src/index.ts:1` — Public API entry point (re-exports)
- `packages/core/dist/index.d.ts` — Build output (tsup `dts:true`) — API Extractor `mainEntryPointFilePath`
- `packages/core/tsup.config.ts:3-6` — `dts: true` build config
- `vitest.base.config.ts:7` — Base `lines:60`
- `packages/core/vitest.config.ts:15-18` — Core `lines:70 branches:70`
- `.opencode/milestones/v1/v1.1.0/M01-B3B4-quality-conformance-and-coverage.md` — Coverage gates M01 (provider 70/70)
- `.opencode/milestones/v1/v1.1.0/M12-B15-round-execution-strategy.md:185` — B14 guards B15 internal-only (API snapshot protects `RoundExecutionStrategy` non-export)
- `.github/workflows/ci.yml:45` — `pnpm lint:all` (vs `package.json:10-11` `lint`/`lint:all`)
- `package.json:10-11` — `lint` vs `lint:all` scripts
