import { describe, it, expect } from 'vitest';
import { runHooks, normalizeHookRegistry } from '../../src/hooks.js';
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

    it('handles sync hooks', () => {
      const hook = (ctx: RunContext) => ctx;

      const result = runHooks([hook], createContext());

      expect(result).resolves.toBeDefined();
    });

    it('handles empty hooks array', async () => {
      const ctx = createContext();

      const result = await runHooks([], ctx);

      expect(result).toBe(ctx);
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
