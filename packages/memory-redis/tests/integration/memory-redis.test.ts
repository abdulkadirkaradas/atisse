import {
    beforeEach,
    describe,
    expect,
    it,
    vi
    } from 'vitest';
import { MemorySaveError, Orchestrator } from '@atisse/core';
import { MockProvider } from '@atisse/core/testing';
import { RedisMemoryAdapter } from '@atisse/memory-redis';


const mockClient = {
  get: vi.fn(),
  setEx: vi.fn(),
  del: vi.fn(),
  isOpen: false,
  connect: vi.fn(),
};

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockClient),
}));

function createMockProvider(): MockProvider {
  const provider = new MockProvider('test-provider');
  return provider;
}

describe('RedisMemoryAdapter + Orchestrator (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.isOpen = false;
  });

  it('should call load() before generation and save() at COMPLETING when sessionId present', async () => {
    mockClient.get.mockResolvedValue(null);
    mockClient.setEx.mockResolvedValue('OK');

    const provider = createMockProvider();
    provider.enqueue({ text: 'Hello!' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });

    expect(mockClient.get).toHaveBeenCalledWith('atisse:session:session-1');
    expect(mockClient.setEx).toHaveBeenCalled();
  });

  it('should accumulate history across sequential runs with same sessionId', async () => {
    // save() internally calls load() which calls get().
    // First run: orchestrator.load + save's internal load both return null (empty)
    // Second run: orchestrator.load returns saved history, save's internal load returns same
    mockClient.get
      .mockResolvedValueOnce(null) // orchestrator.load (run 1)
      .mockResolvedValueOnce(null) // save's internal load (run 1)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ]),
      ) // orchestrator.load (run 2)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ]),
      ); // save's internal load (run 2)

    mockClient.setEx.mockResolvedValue('OK');

    const provider = createMockProvider();
    provider.enqueue({ text: 'Hello!' }).enqueue({ text: 'You said: test' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    // First run
    await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });

    expect(mockClient.setEx).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.any(String),
    );

    // Second run
    mockClient.setEx.mockClear();
    mockClient.get.mockClear();

    // Re-setup mocks for second run
    mockClient.get
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ]),
      ) // orchestrator.load (run 2)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ]),
      ); // save's internal load (run 2)

    await orchestrator.run({ prompt: 'test', sessionId: 'session-1' });

    expect(mockClient.setEx).toHaveBeenCalledTimes(1);
    const [, , data] = mockClient.setEx.mock.calls[0]!;
    const secondMessages = JSON.parse(data as string);
    expect(secondMessages).toHaveLength(4);
    expect(secondMessages[0]?.content).toBe('Hi');
    expect(secondMessages[2]?.content).toBe('test');
  });

  it('should transition to FAILED when save fails', async () => {
    mockClient.get.mockResolvedValue(null);
    mockClient.setEx.mockRejectedValue(new Error('Redis write failure'));

    const provider = createMockProvider();
    provider.enqueue({ text: 'Response' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    await expect(orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' })).rejects.toThrow(
      MemorySaveError,
    );
  });

  it('should NOT call memory methods when sessionId is absent', async () => {
    const provider = createMockProvider();
    provider.enqueue({ text: 'Response' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    await orchestrator.run({ prompt: 'Hi' });

    expect(mockClient.get).not.toHaveBeenCalled();
    expect(mockClient.setEx).not.toHaveBeenCalled();
  });

  it('should produce correct append semantics: [run1_user, run1_asst, run2_user, run2_asst]', async () => {
    mockClient.get
      .mockResolvedValueOnce(null) // orchestrator.load (run 1)
      .mockResolvedValueOnce(null) // save's internal load (run 1)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'resp1' },
        ]),
      ) // orchestrator.load (run 2)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'resp1' },
        ]),
      ); // save's internal load (run 2)

    mockClient.setEx.mockResolvedValue('OK');

    const provider = createMockProvider();
    provider.enqueue({ text: 'resp1' }).enqueue({ text: 'resp2' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    // Run 1
    await orchestrator.run({ prompt: 'first', sessionId: 'sess-1' });
    expect(mockClient.setEx).toHaveBeenCalledTimes(1);
    const [, , data] = mockClient.setEx.mock.calls[0]!;
    const save1 = JSON.parse(data as string);
    expect(save1).toHaveLength(2);
    expect(save1[0]?.content).toBe('first');
    expect(save1[1]?.content).toBe('resp1');

    mockClient.setEx.mockClear();
    mockClient.get.mockClear();

    // Run 2: re-setup mocks
    mockClient.get
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'resp1' },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'resp1' },
        ]),
      );

    await orchestrator.run({ prompt: 'second', sessionId: 'sess-1' });
    expect(mockClient.setEx).toHaveBeenCalledTimes(1);
    const [, , data2] = mockClient.setEx.mock.calls[0]!;
    const save2 = JSON.parse(data2 as string);
    expect(save2).toHaveLength(4);
    expect(save2[0]?.content).toBe('first');
    expect(save2[1]?.content).toBe('resp1');
    expect(save2[2]?.content).toBe('second');
    expect(save2[3]?.content).toBe('resp2');
  });

  describe('custom keyPrefix', () => {
    it('should use custom keyPrefix in integration with Orchestrator', async () => {
      mockClient.get.mockResolvedValue(null);
      mockClient.setEx.mockResolvedValue('OK');
      const provider = createMockProvider();
      provider.enqueue({ text: 'Hello!' });
      const memory = new RedisMemoryAdapter({ client: mockClient as never, keyPrefix: 'myapp:' });
      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });
      await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });
      expect(mockClient.get).toHaveBeenCalledWith('myapp:session-1');
    });

    it('should use custom keyPrefix in URL mode with Orchestrator', async () => {
      mockClient.get.mockResolvedValue(null);
      mockClient.setEx.mockResolvedValue('OK');
      mockClient.connect.mockResolvedValue(undefined);
      const provider = createMockProvider();
      provider.enqueue({ text: 'Hello!' });
      const memory = new RedisMemoryAdapter({ url: 'redis://localhost:6379', keyPrefix: 'appns:' });
      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });
      await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });
      expect(mockClient.get).toHaveBeenCalledWith('appns:session-1');
    });
  });
});
