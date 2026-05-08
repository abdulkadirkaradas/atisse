import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AfterGenerateContext,
  AfterToolContext,
  RunContext,
  StreamChunk,
} from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { ConfigValidationError } from '../../src/errors.js';

describe('profiles (integration)', () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider();
    provider.enqueue({ text: 'response' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('resolveConfig', () => {
    it('resolves profile end-to-end', async () => {
      const profileProvider = new MockProvider('profile-model');
      profileProvider.enqueue({ text: 'profile response' });

      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          test: {
            name: 'test',
            provider: profileProvider,
            systemPrompt: 'profile prompt',
          },
        },
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.profile).toBe('test');
      expect(result.text).toBe('profile response');
    });

    it('throws ConfigValidationError for unknown profile key', async () => {
      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          test: { name: 'test', systemPrompt: 'test' },
        },
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'unknown' });
      vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow(ConfigValidationError);
    });

    it('emits profile.resolved event', async () => {
      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          test: {
            name: 'test',
            systemPrompt: 'replaced',
          },
        },
      });

      const eventListener = vi.fn();
      orchestrator.on('profile.resolved', eventListener);

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();
      await resultPromise;

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'profile.resolved',
          profileName: 'test',
        }),
      );
    });

    it('profile tools: [] replaces base tools', async () => {
      const mockTool = {
        name: 'base-tool',
        description: 'Base tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => 'base',
      };

      const orchestrator = new Orchestrator({
        provider,
        tools: [mockTool],
        profiles: {
          empty: {
            name: 'empty',
            tools: [], // Should remove base tools
          },
        },
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'empty' });
      vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBeDefined();
    });

    it('streaming run with active profile → profile provider used for stream', async () => {
      const profileProvider = new MockProvider('profile-stream-model');
      profileProvider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'Profile ' },
          { type: 'text', delta: 'stream' },
          { type: 'done', usage: { prompt: 5, completion: 10, total: 15 } },
        ],
      });

      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          streamer: {
            name: 'streamer',
            provider: profileProvider,
            systemPrompt: 'You are a streaming profile',
          },
        },
      });

      const eventListener = vi.fn();
      orchestrator.on('profile.resolved', eventListener);

      const result = (await orchestrator.run({
        prompt: 'test',
        profile: 'streamer',
        stream: true,
      })) as AsyncIterable<StreamChunk>;

      const chunks: StreamChunk[] = [];
      for await (const chunk of result) {
        chunks.push(chunk);
      }

      // Verify profile.resolved event fired
      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'profile.resolved',
          profileName: 'streamer',
          overrides: expect.objectContaining({ provider: true }),
        }),
      );

      // Verify streaming worked with profile provider
      const textChunks = chunks.filter((c) => c.type === 'text');
      expect(textChunks.map((c) => c.delta).join('')).toBe('Profile stream');
      expect(chunks.some((c) => c.type === 'done')).toBe(true);

      // Base provider was NOT called — profile provider was used
      expect(provider.wasCalledTimes(0)).toBe(true);
      expect(profileProvider.callCount()).toBe(1);
    });

    it('profile.resolved emitted before generate.started during streaming', async () => {
      const profileProvider = new MockProvider('profile-stream-model');
      profileProvider.enqueueStream({
        chunks: [
          { type: 'text', delta: ' Profile stream' },
          { type: 'done', usage: { prompt: 5, completion: 10, total: 15 } },
        ],
      });

      const eventOrder: Array<{ type: string; timestamp?: number }> = [];

      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          streamer: {
            name: 'streamer',
            provider: profileProvider,
            systemPrompt: 'You are a streaming profile',
          },
        },
      });

      orchestrator.on('profile.resolved', (e) => {
        eventOrder.push({ type: e.type, timestamp: Date.now() });
      });

      orchestrator.on('generate.started', (e) => {
        eventOrder.push({ type: e.type });
      });

      const result = (await orchestrator.run({
        prompt: 'test',
        profile: 'streamer',
        stream: true,
      })) as AsyncIterable<StreamChunk>;

      const chunks: StreamChunk[] = [];
      for await (const chunk of result) {
        chunks.push(chunk);
      }

      // Verify profile.resolved was emitted
      expect(eventOrder.length).toBeGreaterThanOrEqual(2);

      // profile.resolved should come before generate.started
      const profileResolvedIndex = eventOrder.findIndex((e) => e.type === 'profile.resolved');
      const generateStartedIndex = eventOrder.findIndex((e) => e.type === 'generate.started');

      expect(profileResolvedIndex).toBeGreaterThanOrEqual(0);
      expect(generateStartedIndex).toBeGreaterThanOrEqual(0);
      expect(profileResolvedIndex).toBeLessThan(generateStartedIndex);
    });

    it('hookCount correctly reflects concatenated profile + base hooks', async () => {
      const baseBeforeRun = vi.fn(async (ctx: RunContext) => ctx);
      const baseAfterGenerate = vi.fn(async (ctx: AfterGenerateContext) => ctx);

      const profileBeforeRun = vi.fn(async (ctx: RunContext) => ctx);
      const profileAfterTool = vi.fn(async (ctx: AfterToolContext) => ctx);

      const profileProvider = new MockProvider('profile-hooks-model');
      profileProvider.enqueue({ text: 'profile with hooks' });

      const orchestrator = new Orchestrator({
        provider,
        hooks: {
          beforeRun: [baseBeforeRun],
          afterGenerate: [baseAfterGenerate],
        },
        profiles: {
          'with-hooks': {
            name: 'with-hooks',
            provider: profileProvider,
            hooks: {
              beforeRun: [profileBeforeRun],
              afterTool: [profileAfterTool],
            },
          },
        },
      });

      const events: Array<{ type: string; hookCount?: number }> = [];

      orchestrator.on('profile.resolved', (e) => {
        events.push({ type: e.type, hookCount: e.hookCount });
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'with-hooks' });
      vi.runAllTimersAsync();
      await resultPromise;

      // Verify profile.resolved event was emitted
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe('profile.resolved');

      // hookCount should be 4: 2 base hooks (beforeRun, afterGenerate)
      // + 2 profile hooks (beforeRun, afterTool) = 4 unique hooks in merged config
      expect(events[0]!.hookCount).toBe(4);

      // Verify all hooks were actually called
      expect(baseBeforeRun).toHaveBeenCalledTimes(1);
      expect(baseAfterGenerate).toHaveBeenCalledTimes(1);
      expect(profileBeforeRun).toHaveBeenCalledTimes(1);
      expect(profileAfterTool).toHaveBeenCalledTimes(0); // No tool calls in this test
    });
  });
});
