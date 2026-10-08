import { describe, expect, it } from 'vitest';
import type { MemoryAdapter, Message } from '../interfaces.js';

/**
 * Shared conformance suite for MemoryAdapter implementations.
 *
 * Verifies contract compliance across all adapters (in-memory, Redis)
 * to prevent behavioral drift. Each adapter package imports and invokes
 * this function with its own factory.
 *
 * @param label - Human-readable adapter name for test block titles
 * @param adapterFactory - Returns a fresh adapter instance per test
 */
export function runMemoryAdapterConformanceTests(
  label: string,
  adapterFactory: () => MemoryAdapter,
): void {
  describe(`MemoryAdapter conformance: ${label}`, () => {
    it('load() returns [] for unknown sessionId', async () => {
      const adapter = adapterFactory();
      const result = await adapter.load('nonexistent-session');
      expect(result).toEqual([]);
    });

    it('save() + load() round-trip preserves messages', async () => {
      const adapter = adapterFactory();
      const sessionId = 'round-trip-session';
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there', toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'array content' }] },
        { role: 'tool', content: 'tool result', toolCallId: 'call-1', name: 'myTool' },
      ];
      await adapter.save(sessionId, messages);
      const loaded = await adapter.load(sessionId);
      expect(loaded).toEqual(messages);
    });

    it('save() appends to existing history', async () => {
      const adapter = adapterFactory();
      const sessionId = 'append-session';
      await adapter.save(sessionId, [{ role: 'user', content: 'First' }]);
      await adapter.save(sessionId, [{ role: 'user', content: 'Second' }]);
      const loaded = await adapter.load(sessionId);
      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({ content: 'First' });
      expect(loaded[1]).toMatchObject({ content: 'Second' });
    });

    it('clear() empties storage', async () => {
      const adapter = adapterFactory();
      const sessionId = 'clear-session';
      await adapter.save(sessionId, [{ role: 'user', content: 'Hello' }]);
      await adapter.clear(sessionId);
      const loaded = await adapter.load(sessionId);
      expect(loaded).toEqual([]);
    });

    it('clear() is idempotent for non-existent sessionId', async () => {
      const adapter = adapterFactory();
      await expect(adapter.clear('nonexistent-clear')).resolves.toBeUndefined();
    });

    it('cross-session isolation: save(A) does not affect load(B)', async () => {
      const adapter = adapterFactory();
      await adapter.save('session-A', [{ role: 'user', content: 'Hello A' }]);
      const loadedB = await adapter.load('session-B');
      expect(loadedB).toEqual([]);
      const loadedA = await adapter.load('session-A');
      expect(loadedA).toHaveLength(1);
      expect(loadedA[0]).toMatchObject({ content: 'Hello A' });
    });
  });
}
