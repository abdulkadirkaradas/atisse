import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { MockMemoryAdapter } from '../fixtures/mock-memory.js';

describe('memory (integration)', () => {
  let provider: MockProvider;
  let memory: MockMemoryAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider();
    memory = new MockMemoryAdapter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cross-session isolation', () => {
    it('Session A data does not appear in Session B load', async () => {
      provider.enqueue({ text: 'response A' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      // Run session A
      await orchestrator.run({ prompt: 'hello', sessionId: 'session-a' });
      vi.runAllTimersAsync();
      vi.runAllTimersAsync(); // Run all pending timers

      // Verify memory has session A data
      const sessionAMessages = await memory.load('session-a');
      expect(sessionAMessages).toHaveLength(2); // user + assistant

      // Verify session B is empty
      const sessionBMessages = await memory.load('session-b');
      expect(sessionBMessages).toHaveLength(0);
    });
  });

  describe('append semantics', () => {
    it('save appends messages, does not replace', async () => {
      provider.enqueue({ text: 'first' });
      provider.enqueue({ text: 'second' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      // First run
      await orchestrator.run({ prompt: 'first message', sessionId: 'session-1' });
      vi.runAllTimersAsync();

      // Second run
      provider.reset();
      provider.enqueue({ text: 'second response' });
      await orchestrator.run({ prompt: 'second message', sessionId: 'session-1' });
      vi.runAllTimersAsync();

      // Should have 4 messages (2 runs * 2 messages each)
      const messages = await memory.load('session-1');
      expect(messages).toHaveLength(4);
    });
  });

  describe('no sessionId behavior', () => {
    it('run with sessionId calls load and save', async () => {
      const loadSpy = vi.spyOn(memory, 'load');
      const saveSpy = vi.spyOn(memory, 'save');

      provider.enqueue({ text: 'response' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      await orchestrator.run({ prompt: 'test', sessionId: 'my-session' });
      vi.runAllTimersAsync();

      // load was called with provided sessionId
      expect(loadSpy).toHaveBeenCalledWith('my-session');
      // save was called
      expect(saveSpy).toHaveBeenCalled();
    });
  });

  describe('clear()', () => {
    it('clear is idempotent - no error on non-existent session', async () => {
      // Should not throw
      await expect(memory.clear('non-existent')).resolves.toBeUndefined();
    });
  });
});
