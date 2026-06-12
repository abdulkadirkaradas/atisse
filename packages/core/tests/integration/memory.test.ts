import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { MockMemoryAdapter } from '../fixtures/mock-memory.js';
import { MemorySaveError, ProviderUnavailableError } from '../../src/errors.js';
import { echoTool } from '../fixtures/mock-tools.js';
import type { StreamChunk } from '../../src/interfaces.js';

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

  // ── Gap 1: memory_load_error_path_unguarded (HIGH) ────────────────────
  describe('memory load error handling', () => {
    it('propagates memory load errors as run failures', async () => {
      memory.loadError = new ProviderUnavailableError('simulated load failure');
      provider.enqueue({ text: 'response' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      await expect(orchestrator.run({ prompt: 'test', sessionId: 'session-1' })).rejects.toThrow(
        ProviderUnavailableError,
      );
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();
    });
  });

  // ── Gap 2: memory_save_error_path_untested (HIGH) ────────────────────
  describe('memory save error handling', () => {
    it('throws MemorySaveError when save fails during finalization', async () => {
      memory.saveError = new MemorySaveError('simulated save failure');
      provider.enqueue({ text: 'response' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      let caughtError: unknown;
      try {
        await orchestrator.run({ prompt: 'test', sessionId: 'session-1' });
      } catch (error: unknown) {
        caughtError = error;
      }
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      expect(caughtError).toBeInstanceOf(MemorySaveError);
      if (caughtError instanceof MemorySaveError) {
        expect(caughtError.code).toBe('MEMORY_SAVE_FAILED');
        expect(caughtError.retryable).toBe(false);
      }
    });
  });

  // ── Gap 3: sessionId_gating_unverified (MEDIUM) ──────────────────────
  describe('sessionId gating', () => {
    it('skips load and save when sessionId is omitted', async () => {
      const loadSpy = vi.spyOn(memory, 'load');
      const saveSpy = vi.spyOn(memory, 'save');
      provider.enqueue({ text: 'response' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      await orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      expect(loadSpy).not.toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
    });
  });

  // ── Gap 4: streaming_plus_memory_untested (MEDIUM) ───────────────────
  describe('streaming with memory', () => {
    it('saves memory after streaming run completes', async () => {
      provider.enqueue({ text: 'streaming response' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      const stream = await orchestrator.run({
        prompt: 'hello',
        sessionId: 'session-1',
        stream: true,
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      // Verify memory was saved with user + assistant messages
      const messages = await memory.load('session-1');
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe('user');
      expect(messages[1]?.role).toBe('assistant');

      // Verify we got the text chunks plus a 'done' chunk
      const textChunks = chunks.filter(
        (c): c is StreamChunk & { type: 'text' } => c.type === 'text',
      );
      expect(textChunks.map((c) => c.delta).join('')).toBe('streaming response');
      expect(chunks.some((c) => c.type === 'done')).toBe(true);
    });
  });

  // ── Gap 5: empty_session_load_unasserted (MEDIUM) ────────────────────
  describe('empty session load', () => {
    it('returns empty array for unknown sessionId', async () => {
      provider.enqueue({ text: 'response' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      await orchestrator.run({ prompt: 'hello', sessionId: 'session-a' });
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      // Load a session that was never saved to — contract says returns [].
      const unknownSessionMessages = await memory.load('session-unknown');
      expect(unknownSessionMessages).toEqual([]);
    });
  });

  // ── Gap 6: tool_msg_persistence_undocumented (LOW) ───────────────────
  describe('tool message persistence', () => {
    it('saves only user and assistant messages, not tool messages', async () => {
      const saveSpy = vi.spyOn(memory, 'save');
      provider.enqueue({
        text: '',
        toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
        finishReason: 'tool_calls',
      });
      provider.enqueue({ text: 'final answer' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
        tools: [echoTool],
      });

      await orchestrator.run({ prompt: 'use a tool', sessionId: 'session-1' });
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      // save should have been called exactly once with only user + assistant messages
      expect(saveSpy).toHaveBeenCalledTimes(1);
      const savedMessages = saveSpy.mock.calls[0]?.[1] as { role: string }[];
      expect(savedMessages).toHaveLength(2);
      expect(savedMessages[0]?.role).toBe('user');
      expect(savedMessages[1]?.role).toBe('assistant');
      // No tool messages should be persisted
      expect(savedMessages.every((m) => m.role !== 'tool')).toBe(true);
    });
  });

  // ── Gap 7: cross_session_isolation_incomplete (LOW) ──────────────────
  describe('cross-session isolation (extended)', () => {
    it('Session B data does not appear in Session A load', async () => {
      provider.enqueue({ text: 'session b response' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      await orchestrator.run({ prompt: 'hello from B', sessionId: 'session-b' });
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      // Session A should have no data
      const sessionAMessages = await memory.load('session-a');
      expect(sessionAMessages).toHaveLength(0);
    });

    it('interleaved sessions remain isolated', async () => {
      provider.enqueue({ text: 'response A1' });
      provider.enqueue({ text: 'response B1' });
      provider.enqueue({ text: 'response A2' });

      const orchestrator = new Orchestrator({
        provider,
        memoryAdapter: memory,
      });

      // Run A, then B, then A again
      await orchestrator.run({ prompt: 'msg A1', sessionId: 'session-a' });
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      await orchestrator.run({ prompt: 'msg B1', sessionId: 'session-b' });
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      await orchestrator.run({ prompt: 'msg A2', sessionId: 'session-a' });
      vi.runAllTimersAsync();
      vi.runAllTimersAsync();

      // Session A: should have 4 messages (2 runs × 2 messages each)
      const sessionA = await memory.load('session-a');
      expect(sessionA).toHaveLength(4);
      expect(sessionA.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);

      // Session B: should have exactly 2 messages
      const sessionB = await memory.load('session-b');
      expect(sessionB).toHaveLength(2);
      expect(sessionB[0]?.role).toBe('user');
      expect(sessionB[1]?.role).toBe('assistant');
    });
  });
});
