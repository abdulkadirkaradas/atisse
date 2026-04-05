import type { MemoryAdapter, Message } from '../../src/interfaces.js';
import type { OrchestratorError } from '../../src/errors.js';

export class MockMemoryAdapter implements MemoryAdapter {
  private store = new Map<string, Message[]>();
  public loadError?: OrchestratorError;
  public saveError?: OrchestratorError;

  async load(sessionId: string): Promise<Message[]> {
    if (this.loadError) throw this.loadError;
    return this.store.get(sessionId) ?? [];
  }

  async save(sessionId: string, messages: Message[]): Promise<void> {
    if (this.saveError) throw this.saveError;
    const existing = this.store.get(sessionId) ?? [];
    this.store.set(sessionId, [...existing, ...messages]);
  }

  async clear(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
}
