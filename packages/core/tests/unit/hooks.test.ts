import { describe, it, expect } from 'vitest';
import { runHooks, normalizeHookRegistry } from '../../src/hooks.js';
import { HookExecutionError } from '../../src/errors.js';
import type { HookRegistry, RunContext } from '../../src/interfaces.js';

describe('hooks', () => {
  describe('runHooks()', () => {
    const createContext = (): RunContext => ({
      input: { prompt: 'test' },
      runId: '123',
    });

    it('executes hooks serially in order', async () => {
      const callOrder: number[] = [];
      const hook1 = async (ctx: RunContext) => {
        callOrder.push(1);
        return ctx;
      };
      const hook2 = async (ctx: RunContext) => {
        callOrder.push(2);
        return ctx;
      };

      await runHooks([hook1, hook2], createContext());

      expect(callOrder).toEqual([1, 2]);
    });

    it('passes hook1 output as hook2 input', async () => {
      const hook1 = async (ctx: RunContext) => {
        (ctx as any).hook1Ran = true;
        return ctx;
      };
      const hook2 = async (ctx: RunContext) => {
        expect((ctx as any).hook1Ran).toBe(true);
        return ctx;
      };

      await runHooks([hook1, hook2], { input: { prompt: 'test' }, runId: '123' });
    });

    it('propagates hook throw', async () => {
      const hook = async () => {
        throw new Error('hook failed');
      };

      await expect(runHooks([hook], createContext())).rejects.toThrow('hook failed');
    });

    it('throws when hook returns undefined', async () => {
      const hook = async () => undefined;

      await expect(runHooks([hook], createContext())).rejects.toThrow(
        'Hook returned null/undefined',
      );
    });

    it('throws when hook returns null', async () => {
      const hook = async () => null;

      await expect(runHooks([hook], createContext())).rejects.toThrow(
        'Hook returned null/undefined',
      );
    });

    it('handles sync hooks', async () => {
      const hook = (ctx: RunContext) => ctx;

      const result = runHooks([hook], createContext());

      await expect(result).resolves.toBeDefined();
    });

    it('handles empty hooks array', async () => {
      const ctx = createContext();

      const result = await runHooks([], ctx);

      expect(result).toBe(ctx);
    });

    // ── HIGH PRIORITY ─────────────────────────────────────────────

    it('returns the last hook returned context as final value', async () => {
      const hook1 = async (ctx: RunContext) => ({ ...ctx, hook1Marker: 'first' });
      const hook2 = async (ctx: RunContext) => ({ ...ctx, hook2Marker: 'second' });

      const result = await runHooks([hook1, hook2], createContext());

      expect(result).toHaveProperty('hook1Marker', 'first');
      expect(result).toHaveProperty('hook2Marker', 'second');
      expect(result.input).toEqual({ prompt: 'test' });
      expect(result.runId).toBe('123');
    });

    it('propagates OrchestratorError subtype (HookExecutionError)', async () => {
      const hook = async () => {
        throw new HookExecutionError('hook execution error');
      };

      await expect(runHooks([hook], createContext())).rejects.toThrow(HookExecutionError);
      await expect(runHooks([hook], createContext())).rejects.toThrow('hook execution error');
    });

    // ── MEDIUM PRIORITY ───────────────────────────────────────────

    it('propagates non-Error thrown string values', async () => {
      const hook = async () => {
        throw 'string error';
      };

      await expect(runHooks([hook], createContext())).rejects.toBe('string error');
    });

    it('propagates non-Error thrown number values', async () => {
      const hook = async () => {
        throw 42;
      };

      await expect(runHooks([hook], createContext())).rejects.toBe(42);
    });

    it('propagates non-Error thrown null values', async () => {
      const hook = async () => {
        throw null;
      };

      await expect(runHooks([hook], createContext())).rejects.toBeNull();
    });

    it('propagates error when a hook fails mid-chain', async () => {
      const callOrder: number[] = [];
      const hook1 = async (ctx: RunContext) => {
        callOrder.push(1);
        return { ...ctx, hook1Completed: true };
      };
      const hook2 = async () => {
        throw new Error('mid-chain failure');
      };
      const hook3 = async (ctx: RunContext) => {
        callOrder.push(3);
        return ctx;
      };

      await expect(runHooks([hook1, hook2, hook3], createContext())).rejects.toThrow(
        'mid-chain failure',
      );

      // hook1 should have executed; hook3 should not
      expect(callOrder).toEqual([1]);
    });

    it('does not mutate the input context (uses spread-return pattern)', async () => {
      const original = createContext();
      const hook1 = (ctx: RunContext) => ({ ...ctx, addedByHook1: true });
      const hook2 = (ctx: RunContext) => ({ ...ctx, addedByHook2: true });

      const result = await runHooks([hook1, hook2], original);

      // Original context should not be mutated
      expect(original).not.toHaveProperty('addedByHook1');
      expect(original).not.toHaveProperty('addedByHook2');
      expect(original.input).toEqual({ prompt: 'test' });
      expect(original.runId).toBe('123');

      // Result should be a new object with accumulated properties
      expect(result).toHaveProperty('addedByHook1', true);
      expect(result).toHaveProperty('addedByHook2', true);
      expect(result).not.toBe(original);
    });

    // ── LOW PRIORITY ──────────────────────────────────────────────

    it('does not await thenable objects via the instanceof Promise check', async () => {
      // A thenable has a .then() method but is NOT instanceof Promise
      const thenable = {
        then: (resolve: (v: string) => void) => {
          resolve('resolved-via-async-return');
        },
      };

      // Confirm the instanceof check differentiates it from a real Promise
      expect(thenable instanceof Promise).toBe(false);

      // A sync hook returning the thenable
      const hook = () => thenable as unknown as RunContext;

      // The hook returns the thenable synchronously. Inside runHooks(),
      // result instanceof Promise is false, so the thenable is NOT awaited
      // by that check. However, the async function's implicit Promise
      // resolution DOES flatten thenables when returning, so the thenable's
      // .then() is called during runHooks()'s own return procedure.
      const promise = runHooks([hook], createContext());
      const result = await promise;

      // The async function resolves the thenable, yielding its resolved value
      expect(result as unknown).toBe('resolved-via-async-return');
    });

    it('throws TypeError when null is passed as hooks array', async () => {
      // @ts-expect-error — testing runtime behaviour with invalid null input
      await expect(runHooks(null, createContext())).rejects.toThrow(TypeError);
    });

    it('throws TypeError when undefined is passed as hooks array', async () => {
      // @ts-expect-error — testing runtime behaviour with invalid undefined input
      await expect(runHooks(undefined, createContext())).rejects.toThrow(TypeError);
    });

    it('executes all hooks in a large array', async () => {
      const callOrder: number[] = [];
      const hookCount = 10;
      const hooks = Array.from({ length: hookCount }, (_, i) => async (ctx: RunContext) => {
        callOrder.push(i);
        return { ...ctx, [`ranAt${i}`]: true };
      });

      const result = await runHooks(hooks, createContext());

      expect(callOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      for (let i = 0; i < hookCount; i++) {
        expect(result).toHaveProperty(`ranAt${i}`, true);
      }
    });
  });

  describe('normalizeHookRegistry()', () => {
    it('initializes all six arrays', () => {
      const result = normalizeHookRegistry();

      expect(result.beforeRun).toEqual([]);
      expect(result.afterRun).toEqual([]);
      expect(result.beforeGenerate).toEqual([]);
      expect(result.afterGenerate).toEqual([]);
      expect(result.beforeTool).toEqual([]);
      expect(result.afterTool).toEqual([]);
    });

    it('preserves provided arrays', () => {
      const beforeRunHook = async (ctx: RunContext) => ctx;
      const partial: Partial<HookRegistry> = { beforeRun: [beforeRunHook] };

      const result = normalizeHookRegistry(partial);

      expect(result.beforeRun).toHaveLength(1);
      expect(result.beforeRun[0]).toBe(beforeRunHook);
    });
  });
});
