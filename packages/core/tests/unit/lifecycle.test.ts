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
      machine.transition('CONTEXT_INJECTING');
      machine.transition('CONTEXT_INJECTED');
      machine.transition('PROMPT_COMPOSED');
      machine.transition('GENERATING');
      machine.transition('COMPLETING');
      machine.transition('COMPLETED');
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

    it('throws for COMPLETED', () => {
      const machine = new LifecycleStateMachine();
      machine.transition('CONTEXT_INJECTING');
      machine.transition('CONTEXT_INJECTED');
      machine.transition('PROMPT_COMPOSED');
      machine.transition('GENERATING');
      machine.transition('COMPLETING');
      machine.transition('COMPLETED');
      expect(() => machine.assertNotTerminal()).toThrow(InvalidStateTransitionError);
    });

    it('throws with to: "any" for terminal state', () => {
      const machine = new LifecycleStateMachine();
      machine.transition('FAILED');
      try {
        machine.assertNotTerminal();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidStateTransitionError);
        expect((error as InvalidStateTransitionError).to).toBe('any');
      }
    });
  });
});
