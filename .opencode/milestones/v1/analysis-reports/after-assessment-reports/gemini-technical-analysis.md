# Architectural Review: Implementation Plans & Analysis Reports

## Executive Summary

The planning artifacts demonstrate exceptional architectural discipline, explicit dependency mapping, and rigorous versioning awareness. The deliberate isolation between bug fixes (`PATCH`), incremental enhancements (`MINOR`), and foundational changes (`V2`) effectively mitigates roadmap contamination.

However, to ensure seamless execution, several structural ambiguities—primarily around scope inflation in foundational milestones—must be addressed before implementation begins.

---

## 1. Architectural Strengths & Strategic Alignment

### 1.1 Constraint Governance

The roadmap exhibits strong governance by deliberately deferring high-complexity, low-immediate-value features that could lead to premature optimization.

- **Deferred Scope:** Dependency Injection containers, parallel tool execution, streaming fallback recovery, and large-scale schema-first rewrites.
- **Impact:** Development remains driven by core architectural principles rather than ad-hoc feature requests.

### 1.2 Dependency Sequencing & Version Discipline

The implementation sequence correctly honors architectural prerequisites, preventing the integration of abstractions into unstable code structures.

```

[B1 Pipeline Decomposition] ──> [B2 PipelineContext] ──> [B11 ProviderErrorMapper]

```

- **Boundary Discipline:** The distinction between `v1.0.2`, `v1.1.0`, and `v2` is highly consistent. The roadmap accurately identifies that transitioning to `Tool<TInput, TOutput>` represents a public contract redesign, correctly deferring it to `v2`.

---

## 2. Critical Architectural Concerns & Risks

### 2.1 Scope Inflation in Milestone B1

- **Observation:** `B1 (Pipeline internal decomposition)` is treated as a monolithic deliverable, despite containing multiple distinct orchestration concerns (Generation, Streaming, Retry, Fallback, Tool, and Error handling).
- **Risk:** High probability of a "mega-refactor" resulting in high-friction code reviews, complex rollbacks, and obscured regression isolation.
- **Recommendation:** Segment `B1` into atomic, highly focused milestones:
  - `B1A`: `GenerationEngine` extraction
  - `B1B`: `ToolExecutor` extraction
  - `B1C`: `RetryEngine` extraction
  - `B1D`: `ErrorMapper` extraction
  - `B1E`: `StreamingEngine` extraction

### 2.2 Missing Target Architecture Specification

- **Observation:** The roadmap dictates _what_ to decompose but lacks a concrete definition of the target end-state.
- **Risk:** Architectural drift driven by disparate contributor interpretations during implementation.
- **Recommendation:** Author a formal Architecture Decision Record (**ADR-039: Pipeline Internal Architecture**) prior to implementation, enforcing the following structural hierarchy:
  ```text
  Pipeline
   ├─ GenerationEngine
   ├─ ToolExecutor
   ├─ RetryEngine
   ├─ ErrorMapper
   └─ ExecutionContext
  ```

````

### 2.3 Underestimated Provider Capability Discovery

* **Observation:** Milestone `B10` introduces `estimateTokens?()`, but formal capability negotiation remains deferred.
* **Risk:** As providers rapidly diverge (exposing unique vectors like `vision`, `structured outputs`, `reasoning`, etc.), the lack of a unified capability model will cause contract fragmentation.
* **Recommendation:** Immediately introduce an internal interface to encapsulate capability state safely without breaking public APIs:
```typescript
interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  tokenEstimation: boolean;
  structuredOutputs: boolean;
}

````

---

## 3. Missing High-Value Improvements

> ⚠️ **Strategic Gap:** The current plan treats several foundational architectural elements as isolated utilities rather than systemic layers.

### 3.1 ExecutionContext Evolution

Milestone `B2` introduces `PipelineContext` solely for parameter reduction. It should instead be designed as a future-proof execution state container to support Directed Acyclic Graph (DAG) execution topologies.

```typescript
interface ExecutionContext {
  requestId: string;
  runId: string;
  logger: Logger;
  timeoutPolicy: TimeoutPolicy;
  retryPolicy: RetryPolicy;
  metadata: Record<string, unknown>;
}
```

### 3.2 Contract & Conformance Testing

While `B3` introduces excellent conformance tests for `MemoryAdapter`, the equivalent validation layers for `AIProvider` and `ContextProvider` are missing. Interface governance should be cross-cutting:

- `runProviderConformanceTests()`
- `runContextProviderConformanceTests()`
- `runMemoryAdapterConformanceTests()`

### 3.3 Systemic Error Classification

The scope of `B11 (ProviderErrorMapper)` is overly provider-centric. Errors will inevitably originate from tools, memory buffers, context providers, and event streams.

- **Recommendation:** Elevate `B11` into a comprehensive `ErrorClassificationLayer`:

```text
errors/
 ├─ classifier.ts      # Strategy evaluation
 ├─ mapper.ts          # Concrete translation
 ├─ retryability.ts    # Policy determination
 └─ categories.ts      # Domain definitions

```

---

## 4. Quality Assurance & Testing Gaps

| Gap Area                    | Risk Vector                                                                               | Mitigation Strategy                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Mutation Testing**        | Code coverage metrics (`%`) conceal logical edge-case vulnerabilities in high-risk zones. | Integrate **Stryker** specifically to evaluate retry, timeout, policy evaluation, and fallback decision paths. |
| **Snapshot Testing**        | Accidental breaking changes to public contracts, error schemas, or event payloads.        | Implement **API Extractor** within `B14` to capture and validate stable public surfaces.                       |
| **Performance Gatekeeping** | Undetected performance regressions in context loading or serialization pipelines.         | Establish a dedicated `benchmarks/` suite integrated directly into the CI pipeline.                            |

---

## 5. Documentation & Governance Expansion

- **Architecture Evolution Map:** Supplement the roadmap with an `architecture-evolution.md` document. The engineering team must understand not just _what_ changes, but the exact mechanics of how each milestone shifts the system state from `v1.0.1` through to `v2`.
- **ADR Pipeline:** Expand the mandatory documentation registry to include:
- `ADR-039`: Pipeline Decomposition Architecture
- `ADR-041`: Cross-Cutting Error Classification Strategy
- `ADR-042`: Provider Capability Model
- `ADR-043`: ExecutionContext Design Pattern

---

## 6. High-Leverage Priorities

If resources constrain full implementation of these recommendations, prioritize the following five actions to mitigate the highest-risk vectors:

1. **Deconstruct `B1**` into explicit, atomic refactoring milestones.
2. **Ratify `ADR-039**` to cement the target pipeline architecture before a single line of code is written.
3. **Extend contract testing** to cover `AIProvider` and `ContextProvider` interfaces.
4. **Refactor `B11**` into a system-wide Error Classification Layer rather than a simple provider mapper.
5. **Deploy the internal `ProviderCapabilities` model** early to buffer against fast-moving upstream LLM features.

---

## Reference Consistency Table

This table records the current live path for every referenced entity whose location has changed since this report was written. Body text above is intentionally left untouched.

| Reference (as it appears in this file)           | Current Path                                                                                                    | Notes                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Milestone `B1` (Pipeline internal decomposition) | `.opencode/milestones/v1/v1.1.0/_archive/000-superseded-b1-pipeline-decomposition.md`                           | Superseded; split into B1A–B1E (M06–M10) |
| Proposed `B1A`–`B1E` split                       | `.opencode/milestones/v1/v1.1.0/M06-B1A-pipeline-generation-engine.md` … `M10-B1E-pipeline-streaming-engine.md` | Adopted as separate plans                |
| Milestone `B2` (PipelineContext)                 | `.opencode/milestones/v1/v1.1.0/M11-B2B11-pipeline-context-and-error-mapper.md`                                 | Combined with B11                        |
| Milestone `B3` (MemoryAdapter conformance tests) | `.opencode/milestones/v1/v1.1.0/M01-B3B4-quality-conformance-and-coverage.md`                                   | Combined with B4                         |
| Milestone `B10` (`estimateTokens?()`)            | `.opencode/milestones/v1/v1.1.0/M13-B10B13-provider-interface-extensions.md`                                    | Combined with B13                        |
| Milestone `B11` (ProviderErrorMapper)            | `.opencode/milestones/v1/v1.1.0/M11-B2B11-pipeline-context-and-error-mapper.md`                                 | Combined with B2                         |
| Milestone `B14` (CI governance / API Extractor)  | `.opencode/milestones/v1/v1.1.0/M15-B14-ci-governance.md`                                                       | —                                        |
