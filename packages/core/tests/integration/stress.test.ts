import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { MockMemoryAdapter } from '../fixtures/mock-memory.js';

describe('stress (integration)', () => {
  it('100 concurrent runs — no state leaks', async () => {
    const provider = new MockProvider();
    for (let i = 0; i < 100; i++) provider.enqueue({ text: `response-${i}` });

    const memory = new MockMemoryAdapter();

    const orchestrator = new Orchestrator({
      provider,
      memoryAdapter: memory,
    });

    if (typeof global.gc === 'function') global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        orchestrator.run({ prompt: `prompt-${i}`, sessionId: `session-${i}` }),
      ),
    );

    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;

    expect(results).toHaveLength(100);
    const runIds = new Set(results.map((r) => r.runId));
    expect(runIds.size).toBe(100);
    expect(provider.callCount()).toBe(100);
    expect(heapDeltaMB).toBeLessThan(20);

    // Verify all runs resolved with RunOutput shape
    for (const result of results) {
      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('runId');
      expect(typeof result.runId).toBe('string');
    }
  });

  it('session isolation under concurrent saves', async () => {
    const provider = new MockProvider();
    for (let i = 0; i < 100; i++) provider.enqueue({ text: `response-${i}` });

    const memory = new MockMemoryAdapter();

    const orchestrator = new Orchestrator({
      provider,
      memoryAdapter: memory,
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        orchestrator.run({ prompt: `prompt-${i}`, sessionId: `session-${i}` }),
      ),
    );

    expect(results).toHaveLength(100);

    // Session A should have exactly its own data, not session B's
    const session0Messages = await memory.load('session-0');
    expect(session0Messages).toHaveLength(2);
    expect(session0Messages[0]?.role).toBe('user');
    expect(session0Messages[1]?.role).toBe('assistant');
    // After loading session-0, verify content matches expected response
    expect(session0Messages[1]?.content).toBe('response-0');

    // Session 1 should also have exactly 2 messages — no cross-contamination
    const session1Messages = await memory.load('session-1');
    expect(session1Messages).toHaveLength(2);

    // Verify every session has exactly its own pair of messages
    for (let i = 0; i < 100; i++) {
      const messages = await memory.load(`session-${i}`);
      expect(messages).toHaveLength(2);
    }
  });
});
