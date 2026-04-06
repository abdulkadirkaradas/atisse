import type { MemoryAdapter, Message } from '@atisse/core';

export class InMemoryAdapter implements MemoryAdapter {
  // Not implemented — M2 deliverable
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async load(_sessionId: string): Promise<Message[]> {
    throw new Error('Not implemented — M2 deliverable');
  }
  // Not implemented — M2 deliverable
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async save(_sessionId: string, _messages: Message[]): Promise<void> {
    throw new Error('Not implemented — M2 deliverable');
  }
  // Not implemented — M2 deliverable
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async clear(_sessionId: string): Promise<void> {
    throw new Error('Not implemented — M2 deliverable');
  }
}
