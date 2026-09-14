# Review of Implementation Plans and Analysis Reports

## Overall Assessment

The planning artifacts are significantly above average in terms of:

- Architectural discipline
- Scope control
- Explicit dependency mapping
- Versioning awareness
- Backward compatibility analysis

The strongest aspect is the deliberate separation between:

```text
PATCH  -> correctness
MINOR  -> additive improvements
V2     -> architectural evolution
```

This prevents roadmap contamination and reduces the likelihood of accidental scope expansion.

However, several areas can be strengthened before implementation begins.

---

# 1. Planning Strengths

## 1.1 Strong Constraint Governance

The roadmap consistently rejects attractive but premature changes:

Examples:

- Dependency Injection container
- Parallel tool execution
- Streaming + fallback recovery
- Large-scale schema-first rewrites

This indicates the project is being governed by architectural principles rather than feature requests.

This is a major positive.

---

## 1.2 Good Dependency Sequencing

The implementation order correctly identifies architectural prerequisites.

Example:

```text
B1 Pipeline Decomposition
    ↓
B2 PipelineContext
    ↓
B11 ProviderErrorMapper
```

This sequence prevents introducing abstractions into unstable structures.

Many projects attempt B11 before B1 and end up rewriting everything twice.

---

## 1.3 Good Version Boundary Discipline

The distinction between:

```text
v1.0.2
v1.1.0
v2
```

is generally consistent.

The roadmap correctly recognizes that:

```text
Tool<TInput, TOutput>
```

is not a minor feature.

It is a public contract redesign.

Classification as v2 is correct.

---

# 2. Architectural Concerns

---

## 2.1 B1 Is Still Too Large

### Observation

B1 is currently described as:

```text
Pipeline internal decomposition
```

However the planning documents treat it as a single deliverable.

In reality it contains multiple architectural concerns:

```text
Generation orchestration
Streaming orchestration
Retry orchestration
Fallback orchestration
Tool orchestration
Error orchestration
```

### Risk

B1 becomes a "mega-refactor".

This introduces:

- difficult reviews
- difficult rollbacks
- difficult regression isolation

### Recommendation

Split B1 into explicit milestones:

```text
B1A GenerationEngine extraction
B1B ToolExecutor extraction
B1C RetryEngine extraction
B1D ErrorMapper extraction
B1E StreamingEngine extraction
```

This creates atomic architectural commits.

---

## 2.2 Missing Explicit Internal Architecture Target

### Observation

The roadmap says:

```text
Pipeline decomposition
```

but never defines the desired end-state.

### Risk

Different contributors may decompose the pipeline differently.

Architecture drift begins immediately.

### Recommendation

Create an ADR before B1 implementation.

Example:

```text
ADR-039 Pipeline Internal Architecture
```

Containing:

```text
Pipeline
 ├─ GenerationEngine
 ├─ ToolExecutor
 ├─ RetryEngine
 ├─ ErrorMapper
 └─ ExecutionContext
```

The target structure should exist before code changes begin.

---

## 2.3 Provider Capability Discovery Is Underestimated

### Observation

B10 introduces:

```ts
estimateTokens?()
```

but capability negotiation remains deferred.

### Risk

Provider divergence will continue.

Current providers will eventually expose:

```text
vision
structured outputs
tools
reasoning
json mode
streaming
token estimation
```

without a unified capability model.

### Recommendation

Introduce immediately:

```ts
interface ProviderCapabilities
```

even if initially internal.

Example:

```ts
{
    tools: true,
    streaming: true,
    tokenEstimation: true
}
```

This can evolve without breaking public APIs.

---

# 3. Missing High-Value Improvements

---

## 3.1 ExecutionContext Should Be Planned Now

### Observation

B2 introduces:

```text
PipelineContext
```

for parameter reduction.

### Concern

The roadmap treats it as a utility object.

### Recommendation

Design it as a future execution state container.

Example:

```ts
interface ExecutionContext {
  requestId: string;
  runId: string;
  logger: Logger;
  timeoutPolicy: TimeoutPolicy;
  retryPolicy: RetryPolicy;
  metadata: Record<string, unknown>;
}
```

This becomes the foundation for future DAG execution.

---

## 3.2 No Formal Internal Boundary Testing

### Observation

B3 adds:

```text
MemoryAdapter conformance tests
```

which is excellent.

### Missing

No equivalent exists for:

```text
AIProvider
ContextProvider
```

### Recommendation

Create:

```text
runProviderConformanceTests()
runContextProviderConformanceTests()
runMemoryAdapterConformanceTests()
```

This creates complete interface governance.

---

## 3.3 Error Normalization Should Be Broader Than B11

### Observation

B11 introduces:

```text
ProviderErrorMapper
```

### Concern

The scope is provider-centric.

Future errors originate from:

```text
Provider
Tool
Memory
Context
Event
```

### Recommendation

Promote B11 into:

```text
ErrorClassificationLayer
```

Structure:

```text
errors/
 ├─ classifier.ts
 ├─ mapper.ts
 ├─ retryability.ts
 └─ categories.ts
```

This avoids a future second refactor.

---

# 4. Testing Strategy Gaps

---

## 4.1 Mutation Testing Missing

Current planning focuses on:

```text
Coverage %
```

Coverage alone is insufficient.

### Recommendation

Introduce:

```text
Stryker
```

for:

- retry logic
- timeout logic
- policy evaluation
- fallback decisions

These are high-risk areas.

---

## 4.2 Snapshot Testing Missing

Several public contracts appear stable enough for snapshot protection.

Examples:

```text
Public API surface
Error codes
Event payloads
```

### Recommendation

Add:

```text
API Extractor
```

and snapshot validation into B14.

---

## 4.3 Performance Regression Protection Missing

The roadmap contains no benchmark governance.

### Recommendation

Create:

```text
benchmarks/
```

for:

- pipeline execution
- tool execution
- context loading
- retry calculations

Run benchmark comparisons in CI.

---

# 5. Documentation Improvements

---

## 5.1 Missing Architecture Evolution Map

Current roadmap explains:

```text
What
```

and

```text
When
```

but not:

```text
Why this sequence produces the final architecture
```

### Recommendation

Add:

```text
architecture-evolution.md
```

showing:

```text
v1.0.1
    ↓
v1.0.2
    ↓
v1.1.0
    ↓
v2
```

and how each milestone changes the system.

---

## 5.2 ADR Coverage Should Expand

Several roadmap items are large enough to deserve ADRs before implementation.

Recommended additions:

```text
ADR-039 Pipeline Decomposition
ADR-041 Error Classification Strategy
ADR-042 Provider Capability Model
ADR-043 ExecutionContext Design
```

---

# Highest-Leverage Additions

If only five improvements are adopted, prioritize:

1. Split B1 into multiple atomic refactors.
2. Create ADR-039 defining the target pipeline architecture.
3. Introduce provider and context-provider contract test suites alongside memory contracts.
4. Expand B11 into a system-wide error classification layer.
5. Introduce an internal `ProviderCapabilities` model before provider divergence grows.

The roadmap is already well-structured and internally consistent. The primary remaining risk is that several architectural initiatives (especially B1 and B11) are still defined as implementation tasks rather than fully specified architectural outcomes. Converting those into explicit architecture targets before development begins will substantially reduce rework and design drift.

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
| `Tool<TInput, TOutput>` (v2)                     | `.opencode/milestones/v1/v1.x.x-candidates.md` §1.2                                                             | Classified as v2 candidate               |
