import { describe, it, expect, vi } from 'vitest';
import { resolveConfig } from '../../src/profile.js';
import { normalizeHookRegistry } from '../../src/hooks.js';
import { ConfigValidationError } from '../../src/errors.js';
import type {
  OrchestratorConfig,
  OrchestratorProfile,
  HookRegistry,
  Tool,
  RunContext,
  AfterRunContext,
  BeforeGenerateContext,
  AfterGenerateContext,
  ToolContext,
  AfterToolContext,
} from '../../src/interfaces.js';
import { MockProvider } from '../../src/testing/mock-provider.js';

describe('profile', () => {
  describe('normalizeHookRegistry', () => {
    it('returns all arrays for undefined input', () => {
      const result = normalizeHookRegistry(undefined);

      expect(result.beforeRun).toEqual([]);
      expect(result.afterRun).toEqual([]);
      expect(result.beforeGenerate).toEqual([]);
      expect(result.afterGenerate).toEqual([]);
      expect(result.beforeTool).toEqual([]);
      expect(result.afterTool).toEqual([]);
    });

    it('fills missing arrays with empty arrays', () => {
      const partial: Partial<HookRegistry> = { beforeRun: [async (ctx) => ctx] };
      const result = normalizeHookRegistry(partial);

      expect(result.beforeRun).toHaveLength(1);
      expect(result.afterRun).toEqual([]);
      expect(result.beforeGenerate).toEqual([]);
      expect(result.afterGenerate).toEqual([]);
      expect(result.beforeTool).toEqual([]);
      expect(result.afterTool).toEqual([]);
    });
  });

  describe('resolveConfig', () => {
    const baseProvider = new MockProvider('base-model');
    const profileProvider = new MockProvider('profile-model');

    const createConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
      provider: baseProvider,
      systemPrompt: 'base system prompt',
      tools: [],
      contextProviders: [],
      retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, jitter: false },
      ...overrides,
    });

    const createProfile = (
      name: string,
      overrides?: Partial<OrchestratorProfile>,
    ): OrchestratorProfile => ({
      name,
      systemPrompt: 'profile system prompt',
      ...overrides,
    });

    describe('no profile', () => {
      it('returns ResolvedConfig with base config values and defaults for unset fields', () => {
        const config = createConfig();
        const result = resolveConfig(config, undefined, new Map());

        expect(result.provider).toBe(baseProvider);
        expect(result.systemPrompt).toBe('base system prompt');
        expect(result.retry.maxAttempts).toBe(1);
        expect(result.timeout.generateTimeoutMs).toBe(30_000);
        expect(result.toolPolicy.maxToolRounds).toBe(5);
        expect(result.hooks.beforeRun).toEqual([]);
      });

      it('applies retry partial overrides to defaults', () => {
        const config = createConfig({ retry: { maxAttempts: 5 } });
        const result = resolveConfig(config, undefined, new Map());

        expect(result.retry.maxAttempts).toBe(5);
        expect(result.retry.baseDelayMs).toBe(500);
        expect(result.retry.jitter).toBe(true);
      });
    });

    describe('with profile', () => {
      it('profile provider replaces base', () => {
        const config = createConfig({
          profiles: { test: createProfile('test', { provider: profileProvider }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.provider).toBe(profileProvider);
      });

      it('profile systemPrompt replaces base', () => {
        const config = createConfig({
          profiles: { test: createProfile('test', { systemPrompt: 'replaced prompt' }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.systemPrompt).toBe('replaced prompt');
      });

      it('profile tools: [] replaces base tools', () => {
        const baseTools = new Map<string, Tool>([
          [
            'base-tool',
            {
              name: 'base-tool',
              description: 'desc',
              inputSchema: {},
              execute: async () => {},
            } as Tool,
          ],
        ]);
        const config = createConfig({
          profiles: { test: createProfile('test', { tools: [] }) },
        });
        const result = resolveConfig(config, 'test', baseTools);

        expect(result.tools.size).toBe(0);
      });

      it('profile tools: undefined preserves base tools', () => {
        const baseTools = new Map<string, Tool>([
          [
            'base-tool',
            {
              name: 'base-tool',
              description: 'desc',
              inputSchema: {},
              execute: async () => {},
            } as Tool,
          ],
        ]);
        const config = createConfig({
          profiles: { test: createProfile('test', {}) },
        });
        const result = resolveConfig(config, 'test', baseTools);

        expect(result.tools.size).toBe(1);
        expect(result.tools.has('base-tool')).toBe(true);
      });

      it('profile retry replaces base retry', () => {
        const config = createConfig({
          retry: { maxAttempts: 2, baseDelayMs: 200 },
          profiles: { test: createProfile('test', { retry: { maxAttempts: 5 } }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        // Profile maxAttempts: 5 replaces base's maxAttempts
        expect(result.retry.maxAttempts).toBe(5);
        // But baseDelayMs goes back to DEFAULT (500) because profile retry replaces entirely
        expect(result.retry.baseDelayMs).toBe(500);
        expect(result.retry.jitter).toBe(true);
      });

      it('profile hooks concatenated (base first, profile second)', () => {
        const baseHook = vi.fn((ctx: RunContext) => ctx);
        const profileHook = vi.fn((ctx: RunContext) => ctx);
        const config = createConfig({
          hooks: { beforeRun: [baseHook] },
          profiles: { test: createProfile('test', { hooks: { beforeRun: [profileHook] } }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.hooks.beforeRun).toHaveLength(2);
        expect(result.hooks.beforeRun[0]).toBe(baseHook);
        expect(result.hooks.beforeRun[1]).toBe(profileHook);
      });

      it('throws ConfigValidationError for unknown profile key', () => {
        const config = createConfig({ profiles: { test: createProfile('test') } });

        expect(() => resolveConfig(config, 'unknown', new Map())).toThrow(ConfigValidationError);
      });
    });

    describe('profile contextProviders', () => {
      it('profile contextProviders: [] replaces base', () => {
        const mockProvider = { id: 'ctx', provide: async () => [] } as any;
        const config = createConfig({
          contextProviders: [mockProvider],
          profiles: { test: createProfile('test', { contextProviders: [] }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.contextProviders).toEqual([]);
      });

      it('profile contextProviders: undefined preserves base', () => {
        const mockProvider = { id: 'ctx', provide: async () => [] } as any;
        const config = createConfig({
          contextProviders: [mockProvider],
          profiles: { test: createProfile('test', {}) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.contextProviders).toHaveLength(1);
      });
    });
  });
});
