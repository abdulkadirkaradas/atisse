/**
 * Prompt Composer — Layer 1 primitive
 *
 * Assembles the final Message[] for provider generation.
 * Stateless — no constructor dependencies.
 *
 * Assembly order (per architecture.md Step 4):
 * 1. systemPrompt (if present)
 * 2. contextMessages (never trimmed)
 * 3. memoryMessages (trimmed when maxTokens set)
 * 4. userMessage (always last, role: 'user')
 */

import type { Message, SystemMessage, MessageContent } from './interfaces.js';

/**
 * Parameters for composing messages.
 */
export interface ComposeParams {
  systemPrompt?: string;
  contextMessages: SystemMessage[];
  memoryMessages: Message[];
  userPrompt: string;
  maxTokens?: number;
}

/**
 * Composes the final message array for provider generation.
 */
export class PromptComposer {
  /**
   * Assembles messages in the fixed order defined by architecture.md.
   *
   * @param params - Composition parameters
   * @returns Ordered Message[] ready for provider
   */
  compose(params: ComposeParams): Message[] {
    const { systemPrompt, contextMessages, memoryMessages, userPrompt, maxTokens } = params;
    const messages: Message[] = [];

    // 1. systemPrompt → role: 'system' (only when present)
    if (systemPrompt !== undefined && systemPrompt !== '') {
      messages.push({
        role: 'system' as const,
        content: systemPrompt,
      });
    }

    // 2. contextMessages — never trimmed, passed through as-is
    // ContextProvider outputs are trusted (role: 'system')
    for (const msg of contextMessages) {
      messages.push(msg);
    }

    // 3. memoryMessages — trimmed via trimToTokenLimit() when maxTokens is set
    const trimmedMemory =
      maxTokens !== undefined ? this.trimToTokenLimit(memoryMessages, maxTokens) : memoryMessages;

    for (const msg of trimmedMemory) {
      messages.push(msg);
    }

    // 4. userMessage — always role: 'user', always last
    // Security: userPrompt is NEVER mapped to role: 'system'
    messages.push({
      role: 'user' as const,
      content: userPrompt,
    });

    return messages;
  }

  /**
   * Trims memory messages to fit within token limit.
   * Drops oldest messages first (reversed iteration).
   *
   * Note: contextMessages and systemPrompt are never trimmed — only memoryMessages.
   *
   * @param messages - Memory messages to trim
   * @param maxTokens - Maximum token budget
   * @returns Trimmed message array
   */
  private trimToTokenLimit(messages: Message[], maxTokens: number): Message[] {
    // Calculate total tokens in current messages
    let totalTokens = this.calculateTotalTokens(messages);

    // If under limit, return all
    if (totalTokens <= maxTokens) {
      return messages;
    }

    // Create a copy and remove oldest messages first
    const result: Message[] = [...messages];

    // Iterate from oldest (index 0) and remove until under limit
    while (totalTokens > maxTokens && result.length > 0) {
      const removed = result.shift(); // Remove from front (oldest)
      if (removed !== undefined) {
        totalTokens -= this.estimateMessageTokens(removed);
      }
    }

    return result;
  }

  /**
   * Estimates token count for a message.
   *
   * V2 candidate: Replace with proper tokenizer (e.g., tiktoken).
   * Current approximation: Math.ceil(text.length / 4)
   *
   * @param message - Message to estimate
   * @returns Estimated token count
   */
  private estimateMessageTokens(message: Message): number {
    return this.estimateTokens(message.content);
  }

  /**
   * Estimates token count for content string or array.
   *
   * V2 candidate: Replace with proper tokenizer (e.g., tiktoken).
   * Current approximation: Math.ceil(text.length / 4)
   *
   * @param content - String or MessageContent array
   * @returns Estimated token count
   */
  private estimateTokens(content: string | MessageContent[]): number {
    if (typeof content === 'string') {
      return Math.ceil(content.length / 4);
    }

    // For MessageContent[], sum text lengths
    let totalLength = 0;
    for (const item of content) {
      if (item.type === 'text') {
        totalLength += item.text.length;
      }
      // Images don't contribute to text token estimate
    }

    return Math.ceil(totalLength / 4);
  }

  /**
   * Calculates total estimated tokens for a message array.
   *
   * @param messages - Array of messages
   * @returns Total estimated tokens
   */
  private calculateTotalTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateMessageTokens(msg);
    }
    return total;
  }
}
