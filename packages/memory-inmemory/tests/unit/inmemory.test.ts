import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAdapter } from '../../src/index.js';
import type { Message } from '@atisse/core';

describe('InMemoryAdapter', () => {
  let adapter: InMemoryAdapter;

  beforeEach(() => {
    adapter = new InMemoryAdapter();
  });

  describe('load', () => {
    it('returns empty array for unknown session', async () => {
      const result = await adapter.load('unknown-session');
      expect(result).toEqual([]);
    });

    it('returns messages for known session', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      await adapter.save('session-1', messages);
      const result = await adapter.load('session-1');
      expect(result).toEqual(messages);
    });
  });

  describe('save', () => {
    it('creates new session if not exists', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Test' }];
      await adapter.save('new-session', messages);
      const result = await adapter.load('new-session');
      expect(result).toEqual(messages);
    });

    it('appends to existing session history', async () => {
      const messages1: Message[] = [{ role: 'user', content: 'First' }];
      const messages2: Message[] = [{ role: 'assistant', content: 'Second' }];
      await adapter.save('session-2', messages1);
      await adapter.save('session-2', messages2);
      const result = await adapter.load('session-2');
      expect(result).toEqual([...messages1, ...messages2]);
    });

    it('does not replace existing messages', async () => {
      const initial: Message[] = [
        { role: 'user', content: 'Initial' },
        { role: 'assistant', content: 'Response' },
      ];
      const additional: Message[] = [{ role: 'user', content: 'Follow-up' }];
      await adapter.save('session-3', initial);
      await adapter.save('session-3', additional);
      const result = await adapter.load('session-3');
      expect(result).toEqual([
        { role: 'user', content: 'Initial' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Follow-up' },
      ]);
    });
  });

  describe('clear', () => {
    it('removes session data', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Test' }];
      await adapter.save('session-to-clear', messages);
      await adapter.clear('session-to-clear');
      const result = await adapter.load('session-to-clear');
      expect(result).toEqual([]);
    });

    it('is idempotent - does not throw for unknown session', async () => {
      await expect(adapter.clear('non-existent')).resolves.not.toThrow();
    });
  });

  describe('cross-session isolation', () => {
    it('does not leak messages between sessions', async () => {
      const sessionAMessages: Message[] = [{ role: 'user', content: 'Session A message' }];
      const sessionBMessages: Message[] = [{ role: 'user', content: 'Session B message' }];
      await adapter.save('session-A', sessionAMessages);
      await adapter.save('session-B', sessionBMessages);
      const resultA = await adapter.load('session-A');
      const resultB = await adapter.load('session-B');
      expect(resultA).toEqual(sessionAMessages);
      expect(resultB).toEqual(sessionBMessages);
      expect(resultA).not.toEqual(resultB);
    });
  });
});
