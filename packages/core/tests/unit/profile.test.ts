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

      it('applies timeout partial overrides to defaults when no profile', () => {
        const config = createConfig({ timeout: { generateTimeoutMs: 45_000 } });
        const result = resolveConfig(config, undefined, new Map());

        expect(result.timeout.generateTimeoutMs).toBe(45_000);
        expect(result.timeout.toolTimeoutMs).toBe(10_000);
        expect(result.timeout.totalTimeoutMs).toBe(60_000);
      });

      it('applies toolPolicy partial overrides to defaults when no profile', () => {
        const config = createConfig({ toolPolicy: { maxToolRounds: 8 } });
        const result = resolveConfig(config, undefined, new Map());

        expect(result.toolPolicy.maxToolRounds).toBe(8);
        expect(result.toolPolicy.allowParallelTools).toBe(false);
      });

      it('toolPolicy.toolTimeoutMs syncs from timeout.toolTimeoutMs when no profile', () => {
        const config = createConfig({ timeout: { toolTimeoutMs: 25_000 } });
        const result = resolveConfig(config, undefined, new Map());

        expect(result.timeout.toolTimeoutMs).toBe(25_000);
        expect(result.toolPolicy.toolTimeoutMs).toBe(25_000);
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

      it('profile fallbackProvider replaces base fallbackProvider', () => {
        const baseFallback = new MockProvider('base-fallback');
        const profileFallback = new MockProvider('profile-fallback');
        const config = createConfig({
          fallbackProvider: baseFallback,
          profiles: { test: createProfile('test', { fallbackProvider: profileFallback }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.fallbackProvider).toBe(profileFallback);
      });

      it('profile timeout partial replaces default timeout values', () => {
        const config = createConfig({
          profiles: { test: createProfile('test', { timeout: { generateTimeoutMs: 60_000 } }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.timeout.generateTimeoutMs).toBe(60_000);
        expect(result.timeout.toolTimeoutMs).toBe(10_000);
        expect(result.timeout.totalTimeoutMs).toBe(60_000);
      });

      it('profile toolPolicy partial replaces default toolPolicy values', () => {
        const config = createConfig({
          profiles: { test: createProfile('test', { toolPolicy: { maxToolRounds: 10 } }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.toolPolicy.maxToolRounds).toBe(10);
        expect(result.toolPolicy.allowParallelTools).toBe(false);
      });

      it('toolPolicy.toolTimeoutMs syncs from timeout.toolTimeoutMs after profile merge', () => {
        const config = createConfig({
          profiles: { test: createProfile('test', { timeout: { toolTimeoutMs: 20_000 } }) },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.timeout.toolTimeoutMs).toBe(20_000);
        expect(result.toolPolicy.toolTimeoutMs).toBe(20_000);
      });

      it('throws ConfigValidationError for unknown profile key', () => {
        const config = createConfig({ profiles: { test: createProfile('test') } });

        expect(() => resolveConfig(config, 'unknown', new Map())).toThrow(ConfigValidationError);
      });

      it('throws ConfigValidationError when profiles is undefined', () => {
        const config = createConfig();

        expect(() => resolveConfig(config, 'test', new Map())).toThrow(ConfigValidationError);
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

    describe('toolDefinitions', () => {
      it('is defined with correct fields when tools exist', () => {
        const baseTools = new Map<string, Tool>([
          [
            'test-tool',
            {
              name: 'test-tool',
              description: 'A test tool',
              inputSchema: { type: 'object', properties: {} },
              execute: async () => 'result',
            } as Tool,
          ],
        ]);
        const config = createConfig();
        const result = resolveConfig(config, undefined, baseTools);

        expect(result.toolDefinitions).toBeDefined();
        expect(result.toolDefinitions).toHaveLength(1);
        expect(result.toolDefinitions![0]).toEqual({
          name: 'test-tool',
          description: 'A test tool',
          inputSchema: { type: 'object', properties: {} },
        });
        expect(result.toolDefinitions![0]).not.toHaveProperty('execute');
      });

      it('is undefined when tools map is empty', () => {
        const config = createConfig();
        const result = resolveConfig(config, undefined, new Map());

        expect(result.toolDefinitions).toBeUndefined();
      });

      it('reflects profile tools when profile replaces base tools', () => {
        const baseTools = new Map<string, Tool>([
          [
            'base-tool',
            {
              name: 'base-tool',
              description: 'base desc',
              inputSchema: {},
              execute: async () => {},
            } as Tool,
          ],
        ]);
        const config = createConfig({
          profiles: {
            test: createProfile('test', {
              tools: [
                {
                  name: 'profile-tool',
                  description: 'profile desc',
                  inputSchema: { type: 'object' },
                  execute: async () => 'result',
                } as Tool,
              ],
            }),
          },
        });
        const result = resolveConfig(config, 'test', baseTools);

        expect(result.toolDefinitions).toBeDefined();
        expect(result.toolDefinitions).toHaveLength(1);
        expect(result.toolDefinitions![0]).toEqual({
          name: 'profile-tool',
          description: 'profile desc',
          inputSchema: { type: 'object' },
        });
      });
    });

    describe('edge cases and passthrough', () => {
      it('memoryAdapter from base config appears in resolved result', () => {
        const memoryAdapter = {
          load: async () => [],
          save: async () => {},
          clear: async () => {},
        };
        const config = createConfig({ memoryAdapter });
        const result = resolveConfig(config, undefined, new Map());

        expect(result.memoryAdapter).toBe(memoryAdapter);
      });

      it('logger defaults to noOpLogger when not provided', () => {
        const config = createConfig();
        const result = resolveConfig(config, undefined, new Map());

        expect(result.logger.debug).toEqual(expect.any(Function));
        expect(result.logger.info).toEqual(expect.any(Function));
        expect(result.logger.warn).toEqual(expect.any(Function));
        expect(result.logger.error).toEqual(expect.any(Function));
      });

      it('all 6 hook points are concatenated (base first, profile second)', () => {
        const baseBeforeRun = vi.fn((ctx: RunContext) => ctx);
        const profileBeforeRun = vi.fn((ctx: RunContext) => ctx);
        const baseAfterRun = vi.fn((ctx: AfterRunContext) => ctx);
        const profileAfterRun = vi.fn((ctx: AfterRunContext) => ctx);
        const baseBeforeGenerate = vi.fn((ctx: BeforeGenerateContext) => ctx);
        const profileBeforeGenerate = vi.fn((ctx: BeforeGenerateContext) => ctx);
        const baseAfterGenerate = vi.fn((ctx: AfterGenerateContext) => ctx);
        const profileAfterGenerate = vi.fn((ctx: AfterGenerateContext) => ctx);
        const baseBeforeTool = vi.fn((ctx: ToolContext) => ctx);
        const profileBeforeTool = vi.fn((ctx: ToolContext) => ctx);
        const baseAfterTool = vi.fn((ctx: AfterToolContext) => ctx);
        const profileAfterTool = vi.fn((ctx: AfterToolContext) => ctx);

        const config = createConfig({
          hooks: {
            beforeRun: [baseBeforeRun],
            afterRun: [baseAfterRun],
            beforeGenerate: [baseBeforeGenerate],
            afterGenerate: [baseAfterGenerate],
            beforeTool: [baseBeforeTool],
            afterTool: [baseAfterTool],
          },
          profiles: {
            test: createProfile('test', {
              hooks: {
                beforeRun: [profileBeforeRun],
                afterRun: [profileAfterRun],
                beforeGenerate: [profileBeforeGenerate],
                afterGenerate: [profileAfterGenerate],
                beforeTool: [profileBeforeTool],
                afterTool: [profileAfterTool],
              },
            }),
          },
        });
        const result = resolveConfig(config, 'test', new Map());

        expect(result.hooks.beforeRun).toHaveLength(2);
        expect(result.hooks.beforeRun[0]).toBe(baseBeforeRun);
        expect(result.hooks.beforeRun[1]).toBe(profileBeforeRun);

        expect(result.hooks.afterRun).toHaveLength(2);
        expect(result.hooks.afterRun[0]).toBe(baseAfterRun);
        expect(result.hooks.afterRun[1]).toBe(profileAfterRun);

        expect(result.hooks.beforeGenerate).toHaveLength(2);
        expect(result.hooks.beforeGenerate[0]).toBe(baseBeforeGenerate);
        expect(result.hooks.beforeGenerate[1]).toBe(profileBeforeGenerate);

        expect(result.hooks.afterGenerate).toHaveLength(2);
        expect(result.hooks.afterGenerate[0]).toBe(baseAfterGenerate);
        expect(result.hooks.afterGenerate[1]).toBe(profileAfterGenerate);

        expect(result.hooks.beforeTool).toHaveLength(2);
        expect(result.hooks.beforeTool[0]).toBe(baseBeforeTool);
        expect(result.hooks.beforeTool[1]).toBe(profileBeforeTool);

        expect(result.hooks.afterTool).toHaveLength(2);
        expect(result.hooks.afterTool[0]).toBe(baseAfterTool);
        expect(result.hooks.afterTool[1]).toBe(profileAfterTool);
      });

      it('originalConfig equals the base config passed to resolveConfig', () => {
        const config = createConfig();
        const result = resolveConfig(config, undefined, new Map());

        expect(result.originalConfig).toBe(config);
      });

      it('contextProviders defaults to [] when base.contextProviders is undefined', () => {
        const config: OrchestratorConfig = {
          provider: baseProvider,
          systemPrompt: 'base system prompt',
          tools: [],
          retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, jitter: false },
        };
        const result = resolveConfig(config, undefined, new Map());

        expect(result.contextProviders).toEqual([]);
      });

      it('systemPrompt is absent from result when neither base nor profile defines it', () => {
        const config: OrchestratorConfig = {
          provider: baseProvider,
          tools: [],
          retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, jitter: false },
        };
        const result = resolveConfig(config, undefined, new Map());

        expect(result).not.toHaveProperty('systemPrompt');
      });

      it('fallbackProvider is absent from result when not provided', () => {
        const config = createConfig();
        const result = resolveConfig(config, undefined, new Map());

        expect(result).not.toHaveProperty('fallbackProvider');
      });

      it('memoryAdapter is absent from result when not provided', () => {
        const config = createConfig();
        const result = resolveConfig(config, undefined, new Map());

        expect(result).not.toHaveProperty('memoryAdapter');
      });
    });
  });
});
