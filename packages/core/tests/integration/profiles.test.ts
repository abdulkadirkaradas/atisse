import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AfterGenerateContext,
  AfterToolContext,
  RunContext,
  StreamChunk,
  ContextProvider,
} from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import {
  ConfigValidationError,
  MaxRetriesExceededError,
  MaxToolRoundsExceededError,
  TimeoutExceededError,
} from '../../src/errors.js';
import { buildTool } from '../fixtures/builders.js';

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

  describe('profile resolution', () => {
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
      const mockTool = buildTool({
        name: 'base-tool',
        description: 'Base tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => 'base',
      });

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

      await expect(resultPromise).resolves.toMatchObject({ text: 'response' });
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

    // ── High Priority: Streaming Validation Gaps ────────────────────────

    it('throws ConfigValidationError for stream:true with profile-level fallbackProvider', async () => {
      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          test: {
            name: 'test',
            fallbackProvider: new MockProvider('fallback'),
          },
        },
      });

      await expect(
        orchestrator.run({ prompt: 'test', profile: 'test', stream: true }),
      ).rejects.toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when profile provider has streaming=false but stream:true', async () => {
      const nonStreamingProvider = new MockProvider('non-streaming');
      nonStreamingProvider.capabilities.streaming = false;

      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          test: {
            name: 'test',
            provider: nonStreamingProvider,
          },
        },
      });

      await expect(
        orchestrator.run({ prompt: 'test', profile: 'test', stream: true }),
      ).rejects.toThrow(ConfigValidationError);
    });

    // ── Medium Priority: Profile Merge Field Assertions & Event Overrides ──

    it('applies profile retry override end-to-end', async () => {
      const failingProvider = new MockProvider('fail');
      // Empty queue → ProviderUnavailableError (retryable)

      const orchestrator = new Orchestrator({
        provider: failingProvider,
        profiles: {
          test: {
            name: 'test',
            retry: { maxAttempts: 1 }, // Default is 3
          },
        },
      });

      const retryEvents: Array<{ attempt: number }> = [];
      orchestrator.on('retry.attempt', (e) => {
        retryEvents.push({ attempt: e.attempt });
      });

      const runPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();

      await expect(runPromise).rejects.toThrow(MaxRetriesExceededError);
      // maxAttempts=1 means no retries: initial call fails → MaxRetriesExceededError immediately
      expect(retryEvents.length).toBe(0);
      expect(failingProvider.callCount()).toBe(1);
    });

    it('applies profile timeout override end-to-end', async () => {
      vi.useRealTimers(); // Override beforeEach fake timers — need real wall-clock timeout

      // Provider that never resolves (hangs)
      const hangProvider: MockProvider = new MockProvider('hang');
      hangProvider.generate = async () => new Promise<never>(() => {});

      const orchestrator = new Orchestrator({
        provider: hangProvider,
        profiles: {
          test: {
            name: 'test',
            timeout: { totalTimeoutMs: 20 },
          },
        },
      });

      const runPromise = orchestrator.run({ prompt: 'test', profile: 'test' });

      await expect(runPromise).rejects.toThrow(TimeoutExceededError);
    });

    it('applies profile toolPolicy override end-to-end', async () => {
      const tool = buildTool({
        name: 'some-tool',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => 'done',
      });

      const profileProvider = new MockProvider('profile-tool-policy');
      // Two rounds of tool_calls — second round triggers maxToolRounds check
      profileProvider.enqueue({ text: '', toolCalls: [{ id: '1', name: 'some-tool', input: {} }] });
      profileProvider.enqueue({ text: '', toolCalls: [{ id: '2', name: 'some-tool', input: {} }] });

      const orchestrator = new Orchestrator({
        provider,
        tools: [tool],
        profiles: {
          test: {
            name: 'test',
            provider: profileProvider,
            toolPolicy: { maxToolRounds: 1 }, // Default is 5
          },
        },
      });

      const runPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();

      // Round 0: returns tool_calls → 0 >= 1? No → tool executes → continue
      // Round 1: returns tool_calls → 1 >= 1? Yes → MaxToolRoundsExceededError
      await expect(runPromise).rejects.toThrow(MaxToolRoundsExceededError);
    });

    it('resolves profile fallbackProvider on provider failure', async () => {
      const primaryProvider = new MockProvider('primary');
      // Empty queue → ProviderUnavailableError

      const fallbackProvider = new MockProvider('fallback');
      fallbackProvider.enqueue({ text: 'fallback response' });

      const orchestrator = new Orchestrator({
        provider: primaryProvider,
        profiles: {
          test: {
            name: 'test',
            fallbackProvider,
            retry: { maxAttempts: 1 }, // Fail fast to trigger fallback
          },
        },
      });

      const runPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();
      const result = await runPromise;

      expect(result.text).toBe('fallback response');
      expect(primaryProvider.callCount()).toBe(1);
      expect(fallbackProvider.callCount()).toBe(1);
    });

    it('profile tools: non-empty replaces base tools', async () => {
      const baseTool = buildTool({
        name: 'base-tool',
        description: 'Base tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => 'base',
      });

      const profileTool = buildTool({
        name: 'profile-tool',
        description: 'Profile tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => 'profile-result',
      });

      const profileProvider = new MockProvider('profile-tool-model');
      profileProvider.enqueue({
        text: '',
        toolCalls: [{ id: 't1', name: 'profile-tool', input: {} }],
      });
      profileProvider.enqueue({ text: 'profile tool response' });

      const orchestrator = new Orchestrator({
        provider,
        tools: [baseTool],
        profiles: {
          test: {
            name: 'test',
            provider: profileProvider,
            tools: [profileTool], // Non-empty replace — base-tool should NOT be available
          },
        },
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();
      const result = await resultPromise;

      // profile-tool was available and executed; run completed successfully
      expect(result.text).toBe('profile tool response');
    });

    it('profile contextProviders replaces base contextProviders', async () => {
      const baseProvide = vi.fn(async () => [{ role: 'system' as const, content: 'base context' }]);
      const profileProvide = vi.fn(async () => [
        { role: 'system' as const, content: 'profile context' },
      ]);

      const baseCtxProvider: ContextProvider = {
        id: 'base-ctx',
        provide: baseProvide,
      };

      const profileCtxProvider: ContextProvider = {
        id: 'profile-ctx',
        provide: profileProvide,
      };

      const profileProvider = new MockProvider('profile-ctx-model');
      profileProvider.enqueue({ text: 'profile context response' });

      const orchestrator = new Orchestrator({
        provider,
        contextProviders: [baseCtxProvider],
        profiles: {
          test: {
            name: 'test',
            provider: profileProvider,
            contextProviders: [profileCtxProvider],
          },
        },
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.text).toBe('profile context response');
      // Base context provider should NOT have been called
      expect(baseProvide).not.toHaveBeenCalled();
      // Profile context provider SHOULD have been called
      expect(profileProvide).toHaveBeenCalledTimes(1);

      // The profile context was injected — verify via the provider's last request
      const lastRequest = profileProvider.lastRequest();
      expect(lastRequest).toBeDefined();
      const systemMessages = lastRequest!.messages.filter((m) => m.role === 'system');
      expect(systemMessages.some((m) => m.content === 'profile context')).toBe(true);
    });

    it('uses base systemPrompt when profile omits systemPrompt', async () => {
      const profileProvider = new MockProvider('profile-no-prompt');
      profileProvider.enqueue({ text: 'response with base prompt' });

      const orchestrator = new Orchestrator({
        provider,
        systemPrompt: 'You are the base assistant',
        profiles: {
          test: {
            name: 'test',
            provider: profileProvider,
            // No systemPrompt — should fall back to base
          },
        },
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();
      await resultPromise;

      const lastRequest = profileProvider.lastRequest();
      expect(lastRequest).toBeDefined();
      const systemMessages = lastRequest!.messages.filter((m) => m.role === 'system');
      expect(systemMessages.some((m) => m.content === 'You are the base assistant')).toBe(true);
    });

    it('profile systemPrompt replaces base systemPrompt when both are specified', async () => {
      const profileProvider = new MockProvider('profile-replace-prompt');
      profileProvider.enqueue({ text: 'replaced prompt response' });

      const orchestrator = new Orchestrator({
        provider,
        systemPrompt: 'You are the base assistant',
        profiles: {
          test: {
            name: 'test',
            provider: profileProvider,
            systemPrompt: 'You are the profile assistant',
          },
        },
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'test' });
      vi.runAllTimersAsync();
      await resultPromise;

      const lastRequest = profileProvider.lastRequest();
      expect(lastRequest).toBeDefined();
      const systemMessages = lastRequest!.messages.filter((m) => m.role === 'system');
      // Profile value replaced base — only profile prompt should be present
      expect(systemMessages.length).toBeGreaterThanOrEqual(1);
      expect(systemMessages.every((m) => m.content === 'You are the profile assistant')).toBe(true);
      // Base prompt must NOT appear
      expect(systemMessages.every((m) => m.content !== 'You are the base assistant')).toBe(true);
    });

    it('profile.resolved event overrides includes all overridable fields', async () => {
      const profileProvider = new MockProvider('profile-overrides');
      profileProvider.enqueue({ text: 'override test' });

      const ctxProvider: ContextProvider = {
        id: 'test-ctx',
        provide: async () => [],
      };

      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          test: {
            name: 'test',
            provider: profileProvider,
            systemPrompt: 'override prompt',
            tools: [],
            contextProviders: [ctxProvider],
            retry: { maxAttempts: 1 },
            toolPolicy: { maxToolRounds: 1 },
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
          overrides: {
            provider: true,
            tools: true,
            contextProviders: true,
            systemPrompt: true,
            retry: true,
            toolPolicy: true,
          },
        }),
      );
    });

    // ── Low Priority: Edge Cases ──────────────────────────────────────────

    it('synchronizes toolPolicy.toolTimeoutMs from timeout.toolTimeoutMs after profile merge', async () => {
      const profileProvider = new MockProvider('sync-provider');
      profileProvider.enqueue({
        text: '',
        toolCalls: [{ id: 'tc1', name: 'slow-tool', input: {} }],
      });
      profileProvider.enqueue({ text: 'after tool timeout' });

      const slowTool = buildTool({
        name: 'slow-tool',
        description: 'Slow tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return 'done';
        },
      });

      const failedEvents: Array<{ toolName: string }> = [];
      const orchestrator = new Orchestrator({
        provider,
        tools: [slowTool],
        profiles: {
          test: {
            name: 'test',
            provider: profileProvider,
            timeout: { toolTimeoutMs: 10 }, // Should sync to toolPolicy.toolTimeoutMs
          },
        },
      });

      orchestrator.on('tool.failed', (e) => {
        failedEvents.push({ toolName: e.toolName });
      });

      const runPromise = orchestrator.run({ prompt: 'test', profile: 'test' });

      // Advance time to trigger the 10ms tool timeout (tool's 500ms timer hasn't fired yet)
      await vi.advanceTimersByTimeAsync(20);
      // Advance remaining timers for retry delay and pipeline completion
      await vi.runAllTimersAsync();

      await runPromise;

      // Tool should have timed out due to synced toolTimeoutMs=10
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0]!.toolName).toBe('slow-tool');
    });

    it('throws ConfigValidationError when config.profiles have name !== key', () => {
      expect(() => {
        new Orchestrator({
          provider,
          profiles: {
            myKey: {
              name: 'wrongName', // Mismatch: key='myKey', name='wrongName'
            },
          },
        });
      }).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when input.profile set but config.profiles is undefined', async () => {
      const orchestrator = new Orchestrator({
        provider,
        // No profiles defined at all
      });

      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'nonexistent' });
      vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow(ConfigValidationError);
    });
  });
});
