import type { StepTimings } from './interfaces.js';

/**
 * Union of named timing steps aligned with pipeline state transitions.
 * Each value corresponds to a specific boundary in the execution lifecycle.
 */
export type TimingStep =
  | 'start'
  | 'context_start'
  | 'context_end'
  | 'composition_start'
  | 'composition_end'
  | 'generation_start'
  | 'tool_execution_start'
  | 'finalization_start';

/**
 * Per-run timing collector.
 *
 * Records wall-clock timestamps at named step boundaries and produces
 * a StepTimings payload for emission on the run.completed event.
 *
 * Usage:
 *   const timing = new TimingCollector();
 *   timing.mark('start');
 *   // ... context loading happens ...
 *   timing.mark('context_end');
 *   // ... etc ...
 *   const timings = timing.snapshot(); // StepTimings
 *
 * File-private to pipeline.ts layer — NOT exported from @atisse/core.
 */
export class TimingCollector {
  private marks: Map<TimingStep, number> = new Map();

  /**
   * Record a wall-clock timestamp at the current step boundary.
   * The step name should align with pipeline state transitions.
   * Calling mark() twice with the same name overwrites (last-write-wins).
   */
  mark(step: TimingStep): void {
    this.marks.set(step, Date.now());
  }

  /**
   * Calculate elapsed ms from a previous mark to now.
   * Returns 0 if the mark was never recorded.
   */
  private elapsed(fromMark: TimingStep): number {
    const from = this.marks.get(fromMark);
    if (from === undefined) return 0;
    return Date.now() - from;
  }

  /**
   * Calculate elapsed ms between two marks.
   * Returns 0 if either mark was never recorded.
   */
  private between(fromMark: TimingStep, toMark: TimingStep): number {
    const from = this.marks.get(fromMark);
    const to = this.marks.get(toMark);
    if (from === undefined || to === undefined) return 0;
    return to - from;
  }

  /**
   * Produce the final StepTimings snapshot.
   * Should be called once at pipeline completion (before or after Emit).
   * Subsequent calls return the same structure (marks are not cleared).
   */
  snapshot(): StepTimings {
    const now = Date.now();
    return {
      contextLoadingMs: this.between('context_start', 'context_end'),
      compositionMs: this.between('composition_start', 'composition_end'),
      generationMs: this.elapsed('generation_start'),
      toolExecutionMs: this.elapsed('tool_execution_start'),
      finalizationMs: this.elapsed('finalization_start'),
      totalMs: now - (this.marks.get('start') ?? now),
    };
  }
}
