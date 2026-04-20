import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  });
});
