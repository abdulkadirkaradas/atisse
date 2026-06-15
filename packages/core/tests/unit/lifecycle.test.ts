import { describe, it, expect } from 'vitest';
import { LifecycleStateMachine } from '../../src/lifecycle.js';
import { InvalidStateTransitionError } from '../../src/errors.js';

describe('LifecycleStateMachine', () => {
  const states = [
    'INITIALIZED',
    'CONTEXT_INJECTING',
    'CONTEXT_INJECTED',
    'PROMPT_COMPOSED',
    'GENERATING',
    'TOOL_EXECUTING',
    'RETRYING',
    'FALLBACKING',
    'COMPLETING',
    'COMPLETED',
    'FAILED',
  ] as const;

  // ── helpers ──────────────────────────────────────────────────────────

  /** Navigate through a sequence of valid transitions from INITIALIZED. */
  function navigate(machine: LifecycleStateMachine, path: readonly (typeof states)[number][]): void {
    for (const s of path) {
      machine.transition(s);
    }
  }

  /** Catch an InvalidStateTransitionError from a thunk for assertion. */
  function catchInvalidStateError(fn: () => void): InvalidStateTransitionError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateTransitionError);
      return error as InvalidStateTransitionError;
    }
    throw new Error('Expected InvalidStateTransitionError to be thrown');
  }

  const PATH_TO_GENERATING = [
    'CONTEXT_INJECTING',
    'CONTEXT_INJECTED',
    'PROMPT_COMPOSED',
    'GENERATING',
  ] as const;

  describe('initial state', () => {
    it('is INITIALIZED', () => {
      const machine = new LifecycleStateMachine();
      expect(machine.state).toBe('INITIALIZED');
    });
  });

  describe('transition()', () => {
    it('returns previous state', () => {
      const machine = new LifecycleStateMachine();
      const previous = machine.transition('CONTEXT_INJECTING');
      expect(previous).toBe('INITIALIZED');
    });

    it('updates state on valid transition', () => {
      const machine = new LifecycleStateMachine();
      machine.transition('CONTEXT_INJECTING');
      expect(machine.state).toBe('CONTEXT_INJECTING');
    });

    it('throws InvalidStateTransitionError on invalid transition', () => {
      const machine = new LifecycleStateMachine();
      expect(() => machine.transition('COMPLETED')).toThrow(InvalidStateTransitionError);
    });

    it('does not change state when transition throws', () => {
      const machine = new LifecycleStateMachine();
      try {
        machine.transition('COMPLETED');
      } catch {
        // expected
      }
      expect(machine.state).toBe('INITIALIZED');
    });

    // ── Error property assertions (High Priority) ──────────────────────

    it('sets code to INVALID_STATE_TRANSITION when thrown', () => {
      const machine = new LifecycleStateMachine();
      const err = catchInvalidStateError(() => machine.transition('COMPLETED'));
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('sets retryable to false when thrown', () => {
      const machine = new LifecycleStateMachine();
      const err = catchInvalidStateError(() => machine.transition('COMPLETED'));
      expect(err.retryable).toBe(false);
    });

    it('sets from to the source state when thrown', () => {
      const machine = new LifecycleStateMachine();
      const err = catchInvalidStateError(() => machine.transition('COMPLETED'));
      expect(err.from).toBe('INITIALIZED');
    });

    it('sets to to the attempted target state when thrown', () => {
      const machine = new LifecycleStateMachine();
      const err = catchInvalidStateError(() => machine.transition('COMPLETED'));
      expect(err.to).toBe('COMPLETED');
    });

    it('includes from and to in error message when thrown', () => {
      const machine = new LifecycleStateMachine();
      const err = catchInvalidStateError(() => machine.transition('COMPLETED'));
      expect(err.message).toBe('Invalid state transition: INITIALIZED \u2192 COMPLETED');
    });

    // ── Terminal state immutability (High Priority) ────────────────────

    it('throws from COMPLETED terminal state on any transition', () => {
      const machine = new LifecycleStateMachine();
      navigate(machine, [...PATH_TO_GENERATING, 'COMPLETING', 'COMPLETED']);
      const err = catchInvalidStateError(() => machine.transition('INITIALIZED'));
      expect(err.from).toBe('COMPLETED');
      expect(err.to).toBe('INITIALIZED');
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('throws from FAILED terminal state on any transition', () => {
      const machine = new LifecycleStateMachine();
      machine.transition('FAILED');
      const err = catchInvalidStateError(() => machine.transition('INITIALIZED'));
      expect(err.from).toBe('FAILED');
      expect(err.to).toBe('INITIALIZED');
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
    });

    // ── Direct-to-FAILED transitions (Medium Priority) ─────────────────

    it.each([
      { from: 'CONTEXT_INJECTING', path: ['CONTEXT_INJECTING'] as const },
      { from: 'CONTEXT_INJECTED', path: ['CONTEXT_INJECTING', 'CONTEXT_INJECTED'] as const },
      { from: 'PROMPT_COMPOSED', path: ['CONTEXT_INJECTING', 'CONTEXT_INJECTED', 'PROMPT_COMPOSED'] as const },
      { from: 'GENERATING', path: PATH_TO_GENERATING },
      { from: 'TOOL_EXECUTING', path: [...PATH_TO_GENERATING, 'TOOL_EXECUTING'] as const },
      { from: 'RETRYING', path: [...PATH_TO_GENERATING, 'RETRYING'] as const },
      { from: 'FALLBACKING', path: [...PATH_TO_GENERATING, 'FALLBACKING'] as const },
      { from: 'COMPLETING', path: [...PATH_TO_GENERATING, 'COMPLETING'] as const },
    ])('transitions to FAILED from $from', ({ path }) => {
      const machine = new LifecycleStateMachine();
      navigate(machine, path);
      machine.transition('FAILED');
      expect(machine.state).toBe('FAILED');
    });

    // ── Loop-back transitions (Medium Priority) ────────────────────────

    it.each([
      { label: 'TOOL_EXECUTING -> GENERATING', path: [...PATH_TO_GENERATING, 'TOOL_EXECUTING'] as const, target: 'GENERATING' as const },
      { label: 'RETRYING -> GENERATING', path: [...PATH_TO_GENERATING, 'RETRYING'] as const, target: 'GENERATING' as const },
      { label: 'RETRYING -> CONTEXT_INJECTING', path: [...PATH_TO_GENERATING, 'RETRYING'] as const, target: 'CONTEXT_INJECTING' as const },
      { label: 'RETRYING -> FALLBACKING', path: [...PATH_TO_GENERATING, 'RETRYING'] as const, target: 'FALLBACKING' as const },
      { label: 'FALLBACKING -> GENERATING', path: [...PATH_TO_GENERATING, 'FALLBACKING'] as const, target: 'GENERATING' as const },
    ])('transitions $label (loopback)', ({ path, target }) => {
      const machine = new LifecycleStateMachine();
      navigate(machine, path);
      machine.transition(target);
      expect(machine.state).toBe(target);
    });

    // ── RETRYING self-loop (Medium Priority) ───────────────────────────

    it('transitions RETRYING -> RETRYING (self-loop)', () => {
      const machine = new LifecycleStateMachine();
      navigate(machine, [...PATH_TO_GENERATING, 'RETRYING']);
      const previous = machine.transition('RETRYING');
      expect(machine.state).toBe('RETRYING');
      expect(previous).toBe('RETRYING');
    });

    // ── Cross-state invalid transitions (Medium Priority) ──────────────

    it.each([
      { label: 'CONTEXT_INJECTING -> PROMPT_COMPOSED (skip CONTEXT_INJECTED)', path: ['CONTEXT_INJECTING'] as const, target: 'PROMPT_COMPOSED' as const, expectedFrom: 'CONTEXT_INJECTING' as const },
      { label: 'CONTEXT_INJECTED -> GENERATING (skip PROMPT_COMPOSED)', path: ['CONTEXT_INJECTING', 'CONTEXT_INJECTED'] as const, target: 'GENERATING' as const, expectedFrom: 'CONTEXT_INJECTED' as const },
      { label: 'PROMPT_COMPOSED -> COMPLETED (skip GENERATING, COMPLETING)', path: ['CONTEXT_INJECTING', 'CONTEXT_INJECTED', 'PROMPT_COMPOSED'] as const, target: 'COMPLETED' as const, expectedFrom: 'PROMPT_COMPOSED' as const },
      { label: 'GENERATING -> CONTEXT_INJECTING (backwards, invalid)', path: PATH_TO_GENERATING, target: 'CONTEXT_INJECTING' as const, expectedFrom: 'GENERATING' as const },
    ])('rejects $label', ({ path, target, expectedFrom }) => {
      const machine = new LifecycleStateMachine();
      navigate(machine, path);
      const err = catchInvalidStateError(() => machine.transition(target));
      expect(err.from).toBe(expectedFrom);
      expect(err.to).toBe(target);
    });

    // ── Transition return value (Low Priority) ─────────────────────────

    it('returns previous state on each step of a multi-step path', () => {
      const machine = new LifecycleStateMachine();
      expect(machine.transition('CONTEXT_INJECTING')).toBe('INITIALIZED');
      expect(machine.transition('CONTEXT_INJECTED')).toBe('CONTEXT_INJECTING');
      expect(machine.transition('PROMPT_COMPOSED')).toBe('CONTEXT_INJECTED');
      expect(machine.transition('GENERATING')).toBe('PROMPT_COMPOSED');
    });
  });

  describe('isTerminal()', () => {
    it('returns false for non-terminal states', () => {
      // Test valid paths to various states from INITIALIZED
      const testCases: Array<{ transitions: (typeof states)[number][] }> = [
        { transitions: ['CONTEXT_INJECTING'] },
        { transitions: ['CONTEXT_INJECTING', 'CONTEXT_INJECTED'] },
        { transitions: ['CONTEXT_INJECTING', 'CONTEXT_INJECTED', 'PROMPT_COMPOSED'] },
        { transitions: ['CONTEXT_INJECTING', 'CONTEXT_INJECTED', 'PROMPT_COMPOSED', 'GENERATING'] },
        {
          transitions: [
            'CONTEXT_INJECTING',
            'CONTEXT_INJECTED',
            'PROMPT_COMPOSED',
            'GENERATING',
            'TOOL_EXECUTING',
          ],
        },
        {
          transitions: [
            'CONTEXT_INJECTING',
            'CONTEXT_INJECTED',
            'PROMPT_COMPOSED',
            'GENERATING',
            'RETRYING',
          ],
        },
        {
          transitions: [
            'CONTEXT_INJECTING',
            'CONTEXT_INJECTED',
            'PROMPT_COMPOSED',
            'GENERATING',
            'FALLBACKING',
          ],
        },
        {
          transitions: [
            'CONTEXT_INJECTING',
            'CONTEXT_INJECTED',
            'PROMPT_COMPOSED',
            'GENERATING',
            'COMPLETING',
          ],
        },
      ];

      for (const { transitions } of testCases) {
        const machine = new LifecycleStateMachine();
        for (const state of transitions) {
          machine.transition(state);
        }
        expect(machine.isTerminal()).toBe(false);
      }
    });

    it('returns true for COMPLETED', () => {
      const machine = new LifecycleStateMachine();
      navigate(machine, [...PATH_TO_GENERATING, 'COMPLETING', 'COMPLETED']);
      expect(machine.isTerminal()).toBe(true);
    });

    it('returns true for FAILED', () => {
      const machine = new LifecycleStateMachine();
      machine.transition('FAILED');
      expect(machine.isTerminal()).toBe(true);
    });
  });

  describe('assertNotTerminal()', () => {
    it('does not throw for non-terminal state', () => {
      const machine = new LifecycleStateMachine();
      expect(() => machine.assertNotTerminal()).not.toThrow();
    });

    // ── High Priority: ASSERT_TERM_COMPLETED_INCOMPLETE ──

    it('throws with all properties when state is COMPLETED', () => {
      const machine = new LifecycleStateMachine();
      navigate(machine, [...PATH_TO_GENERATING, 'COMPLETING', 'COMPLETED']);
      const err = catchInvalidStateError(() => machine.assertNotTerminal());
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
      expect(err.retryable).toBe(false);
      expect(err.from).toBe('COMPLETED');
      expect(err.to).toBe('any');
    });

    // ── High Priority: ASSERT_TERM_FAILED_INCOMPLETE ──

    it('throws with all properties when state is FAILED', () => {
      const machine = new LifecycleStateMachine();
      machine.transition('FAILED');
      const err = catchInvalidStateError(() => machine.assertNotTerminal());
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
      expect(err.retryable).toBe(false);
      expect(err.from).toBe('FAILED');
      expect(err.to).toBe('any');
    });

    // ── Medium Priority: ASSERT_NOT_TERM_NON_INIT_MISSING ──

    it('does not throw when state is GENERATING (non-terminal)', () => {
      const machine = new LifecycleStateMachine();
      navigate(machine, PATH_TO_GENERATING);
      expect(() => machine.assertNotTerminal()).not.toThrow();
    });

    it('does not throw when state is COMPLETING (non-terminal)', () => {
      const machine = new LifecycleStateMachine();
      navigate(machine, [...PATH_TO_GENERATING, 'COMPLETING']);
      expect(() => machine.assertNotTerminal()).not.toThrow();
    });
  });
});
