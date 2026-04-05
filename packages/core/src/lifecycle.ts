import type { LifecycleState } from './interfaces.js';
import { InvalidStateTransitionError } from './errors.js';

/**
 * Valid state transitions for the lifecycle state machine.
 * NOT exported - internal constant only.
 */
const VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  INITIALIZED: ['CONTEXT_INJECTING', 'FAILED'],
  CONTEXT_INJECTING: ['CONTEXT_INJECTED', 'RETRYING', 'FAILED'],
  CONTEXT_INJECTED: ['PROMPT_COMPOSED', 'FAILED'],
  PROMPT_COMPOSED: ['GENERATING', 'FAILED'],
  GENERATING: ['TOOL_EXECUTING', 'RETRYING', 'FALLBACKING', 'COMPLETING', 'FAILED'],
  TOOL_EXECUTING: ['GENERATING', 'RETRYING', 'FAILED'],
  RETRYING: ['GENERATING', 'CONTEXT_INJECTING', 'FALLBACKING', 'FAILED'],
  FALLBACKING: ['GENERATING', 'FAILED'],
  COMPLETING: ['COMPLETED'],
  COMPLETED: [],
  FAILED: [],
};

/**
 * Manages lifecycle state transitions for a single run() call.
 * Each instance is created fresh per run() and never stored on Orchestrator.
 */
export class LifecycleStateMachine {
  private current: LifecycleState = 'INITIALIZED';

  /**
   * Transitions to the target state. Returns the previous state for logging.
   * Throws InvalidStateTransitionError if the transition is not valid.
   */
  transition(to: LifecycleState): LifecycleState {
    const allowed = VALID_TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new InvalidStateTransitionError(this.current, to);
    }
    const previous = this.current;
    this.current = to;
    return previous;
  }

  /** Returns the current lifecycle state. */
  get state(): LifecycleState {
    return this.current;
  }

  /** Checks if the current state is terminal (COMPLETED or FAILED). */
  isTerminal(): boolean {
    return this.current === 'COMPLETED' || this.current === 'FAILED';
  }

  /** Throws if current state is terminal. */
  assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidStateTransitionError(this.current, 'any');
    }
  }
}
