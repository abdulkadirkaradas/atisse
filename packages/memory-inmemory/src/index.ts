import type { MemoryAdapter, Message } from '@atisse/core';

/**
 * In-memory storage adapter for message history.
 *
 * Reference implementation only — not for production use.
 * Uses per-session storage keys to ensure cross-session isolation.
 */
export class InMemoryAdapter implements MemoryAdapter {
  private readonly store = new Map<string, Message[]>();

  /**
   * Loads all messages for a given session.
   *
   * @param sessionId - The unique session identifier
   * @returns Array of messages for the session, or empty array if session not found
   */
  async load(sessionId: string): Promise<Message[]> {
    return Promise.resolve(this.store.get(sessionId) ?? []);
  }

  /**
   * Appends messages to an existing session's history.
   *
   * If the session does not exist, it is created with the provided messages.
   * This implements append semantics as required by MemoryAdapter contract.
   *
   * @param sessionId - The unique session identifier
   * @param messages - Messages to append to the session history
   */
  async save(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.store.get(sessionId) ?? [];
    this.store.set(sessionId, [...existing, ...messages]);
    return Promise.resolve();
  }

  /**
   * Clears all messages for a given session.
   *
   * Idempotent operation - silently succeeds even if the session does not exist.
   *
   * @param sessionId - The unique session identifier
   */
  async clear(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
    return Promise.resolve();
  }
}
