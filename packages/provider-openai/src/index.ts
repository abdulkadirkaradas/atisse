import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletion,
  ChatCompletionContentPartText,
  ChatCompletionContentPartImage,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';
import type { Stream } from 'openai/core/streaming';

import { randomUUID } from 'crypto';

import type {
  AIProvider,
  ProviderCapabilities,
  PromptRequest,
  PromptResponse,
  Message,
  MessageContent,
  ToolCall,
  ToolDefinition,
  TokenUsage,
  StreamChunk,
} from '@atisse/core';

import {
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderAuthError,
  ProviderMalformedResponse,
  OrchestratorError,
} from '@atisse/core';

/**
 * Typed interface for OpenAI API error responses.
 */
interface OpenAIErrorResponse {
  status?: number;
  message?: string;
  cause?: unknown;
  response?: {
    headers?: {
      get?: (key: string) => string | null;
    };
  };
}

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

/**
 * Extracted message from a completion choice.
 */
interface ExtractedMessage {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/**
 * Extracted usage from a completion.
 */
interface ExtractedUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export class OpenAIProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly model: string;

  private readonly client: OpenAI;

  constructor(config: OpenAIProviderConfig) {
    this.model = config.model ?? 'gpt-4o';
    this.id = `openai-${this.model}`;

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: true,
      maxContextTokens: 128_000,
    };

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async generate(request: PromptRequest): Promise<PromptResponse> {
    try {
      const messages = this.mapMessages(request.messages);

      const createParams: Record<string, unknown> = {
        model: this.model,
        messages,
        stream: false,
      };

      if (request.maxTokens !== undefined) {
        createParams.max_tokens = request.maxTokens;
      }
      if (request.temperature !== undefined) {
        createParams.temperature = request.temperature;
      }
      if (request.tools) {
        createParams.tools = this.mapTools(request.tools);
      }

      // Merge provider options last
      if (request.providerOptions) {
        Object.assign(createParams, request.providerOptions);
      }

      const completion = await this.client.chat.completions.create(
        createParams as unknown as ChatCompletionCreateParamsNonStreaming,
        request.signal ? { signal: request.signal } : undefined,
      );

      const choice = this.extractChoice(completion);
      if (!choice) {
        throw new ProviderMalformedResponse('No completion choice returned');
      }

      const finishReason = this.mapFinishReason(choice.finish_reason);

      // Type-narrow the tool_calls from the response
      const rawMessage = this.extractMessage(choice);
      const toolCalls = this.extractToolCalls(rawMessage);

      const text = rawMessage.content ?? '';

      const usage = this.extractUsage(completion);

      const tokenUsage: TokenUsage = {
        prompt: usage?.prompt_tokens ?? 0,
        completion: usage?.completion_tokens ?? 0,
        total: usage?.total_tokens ?? 0,
      };

      return {
        text,
        toolCalls: toolCalls ?? [],
        usage: tokenUsage,
        finishReason,
      };
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.mapError(error);
    }
  }

  async generateStream(request: PromptRequest): Promise<AsyncIterable<StreamChunk>> {
    try {
      const messages = this.mapMessages(request.messages);

      const createParams: Record<string, unknown> = {
        model: this.model,
        messages,
        stream: true,
      };

      if (request.maxTokens !== undefined) {
        createParams.max_tokens = request.maxTokens;
      }
      if (request.temperature !== undefined) {
        createParams.temperature = request.temperature;
      }
      if (request.tools) {
        createParams.tools = this.mapTools(request.tools);
      }

      // Merge provider options last
      if (request.providerOptions) {
        Object.assign(createParams, request.providerOptions);
      }

      const response = await this.client.chat.completions.create(
        createParams as unknown as ChatCompletionCreateParamsStreaming,
        request.signal ? { signal: request.signal } : undefined,
      );

      // Cast to stream type - the SDK returns different types for streaming vs non-streaming
      const stream = response as unknown as Stream<ChatCompletionChunk>;

      return this.assembleStreamingChunks(stream);
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.mapError(error);
    }
  }

  private async *assembleStreamingChunks(
    stream: Stream<ChatCompletionChunk>,
  ): AsyncIterable<StreamChunk> {
    const accumulatedToolCalls = new Map<string, { id: string; name: string; arguments: string }>();
    let finalUsage: TokenUsage | undefined;

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          yield { type: 'text', delta: delta.content };
        }

        if (delta?.tool_calls) {
          for (const toolCallDelta of delta.tool_calls) {
            const id = toolCallDelta.id ?? 'pending';
            const functionData = toolCallDelta.function;

            if (!functionData) continue;

            let existing = accumulatedToolCalls.get(id);
            if (!existing) {
              existing = {
                id: id,
                name: functionData.name ?? '',
                arguments: '',
              };
              accumulatedToolCalls.set(id, existing);
            }

            if (functionData.name) {
              existing.name = functionData.name;
            }
            if (functionData.arguments) {
              existing.arguments += functionData.arguments;
            }
          }
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          if (chunk.usage) {
            finalUsage = {
              prompt: chunk.usage.prompt_tokens ?? 0,
              completion: chunk.usage.completion_tokens ?? 0,
              total: chunk.usage.total_tokens ?? 0,
            };
          }
        }
      }

      for (const [, tc] of accumulatedToolCalls) {
        const toolCall: ToolCall = {
          id: tc.id === 'pending' ? randomUUID() : tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments),
        };
        yield { type: 'tool_call', toolCall };
      }

      yield {
        type: 'done',
        usage: finalUsage ?? { prompt: 0, completion: 0, total: 0 },
      };
    } catch (error: unknown) {
      const mappedError = this.mapErrorToOrchestratorError(error);
      yield { type: 'error', error: mappedError };
      return;
    }
  }

  private mapErrorToOrchestratorError(error: unknown): ProviderUnavailableError {
    if (error instanceof ProviderRateLimitError) {
      return new ProviderUnavailableError('Rate limit exceeded', error);
    }
    if (error instanceof ProviderAuthError) {
      return new ProviderUnavailableError('Authentication failed', error);
    }
    if (error instanceof ProviderTimeoutError) {
      return new ProviderUnavailableError('Request timed out', error);
    }
    if (error instanceof ProviderUnavailableError) {
      return error;
    }
    if (error instanceof ProviderMalformedResponse) {
      return new ProviderUnavailableError('Provider returned malformed response', error);
    }

    return new ProviderUnavailableError('Provider unavailable', error);
  }

  private mapError(error: unknown): never {
    if (error instanceof OrchestratorError) {
      throw error;
    }

    const err = error as OpenAIErrorResponse;

    if (err.status !== undefined) {
      const status = err.status;
      const cause = err.cause;

      if (status === 429) {
        const retryAfter = error as OpenAIErrorResponse;
        const headers = retryAfter.response?.headers;
        let retryAfterMs: number | undefined = undefined;
        if (headers) {
          const getFn = headers.get;
          if (getFn) {
            const retryAfterHeader = getFn('Retry-After');
            if (retryAfterHeader) {
              retryAfterMs = Number(retryAfterHeader) * 1000 || undefined;
            }
          }
        }
        // S-7: Sanitize error message - return generic category description
        throw new ProviderRateLimitError('Rate limit exceeded', retryAfterMs, cause);
      }

      if (status === 401 || status === 403) {
        // S-7: Sanitize error message - return generic category description
        throw new ProviderAuthError('Authentication failed', cause);
      }

      if (status === 408) {
        // S-7: Sanitize error message - return generic category description
        throw new ProviderTimeoutError('Request timed out', cause);
      }

      if (status >= 500) {
        // S-7: Sanitize error message - return generic category description
        throw new ProviderUnavailableError('Provider unavailable', cause);
      }
    }

    // S-7: Generic error message for unknown errors
    throw new ProviderUnavailableError('Provider unavailable', error);
  }

  private mapMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'system') {
        const content = this.mapContentToStringOrTextParts(msg.content);
        return {
          role: 'system',
          content,
        };
      }

      if (msg.role === 'user') {
        const content = this.mapContentToContentParts(msg.content);
        return {
          role: 'user',
          content,
        };
      }

      if (msg.role === 'assistant') {
        const content = this.mapContentToStringOrTextParts(msg.content);
        const result: ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content,
        };
        if (msg.toolCalls) {
          result.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          }));
        }
        return result;
      }

      if (msg.role === 'tool') {
        const content = this.mapContentToStringOrTextParts(msg.content);
        const toolResult: ChatCompletionToolMessageParam = {
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content,
        };
        return toolResult;
      }

      throw new ProviderMalformedResponse(
        `Unknown message role: ${(msg as { role: string }).role}`,
      );
    });
  }

  /**
   * Map content to string or text-only content parts (for system, assistant, tool messages).
   * These message types don't support image content.
   */
  private mapContentToStringOrTextParts(content: string | MessageContent[]): string | ChatCompletionContentPartText[] {
    if (typeof content === 'string') {
      return content;
    }

    // Only map text parts - system/assistant/tool messages don't support images
    return content
      .filter((c) => c.type === 'text')
      .map((c) => ({ type: 'text' as const, text: c.text }));
  }

  /**
   * Map content to string or mixed content parts including images (for user messages).
   */
  private mapContentToContentParts(content: string | MessageContent[]): string | (ChatCompletionContentPartText | ChatCompletionContentPartImage)[] {
    if (typeof content === 'string') {
      return content;
    }

    // Map MessageContent array to OpenAI content parts format
    const parts: (ChatCompletionContentPartText | ChatCompletionContentPartImage)[] = [];

    for (const c of content) {
      if (c.type === 'text') {
        parts.push({ type: 'text', text: c.text });
      } else if (c.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: c.url, detail: 'auto' },
        });
      }
    }

    return parts;
  }

  private mapTools(tools: ToolDefinition[]): ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private extractChoice(
    completion: ChatCompletion | Stream<ChatCompletionChunk>,
  ): ChatCompletion.Choice | undefined {
    // Handle both streaming and non-streaming responses
    if ('choices' in completion && Array.isArray(completion.choices)) {
      return completion.choices[0];
    }
    return undefined;
  }

  private extractMessage(choice: ChatCompletion.Choice): ExtractedMessage {
    // Extract message safely from the choice object
    const message = choice.message;
    const result: ExtractedMessage = {
      content: message.content ?? null,
    };

    // Extract tool_calls if present
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      result.tool_calls = message.tool_calls
        .filter((tc) => this.isFunctionToolCall(tc))
        .map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments ?? '',
          },
        }));
    }

    return result;
  }

  private isFunctionToolCall(tc: {
    type?: string;
    function?: unknown;
  }): tc is { id: string; type: 'function'; function: { name: string; arguments: string } } {
    return tc.type === 'function' && typeof tc.function === 'object' && tc.function !== null;
  }

  private extractToolCalls(message: ExtractedMessage): ToolCall[] | undefined {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return undefined;
    }

    const result: ToolCall[] = [];
    for (const tc of message.tool_calls) {
      result.push({
        id: tc.id || randomUUID(),
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
    return result.length > 0 ? result : undefined;
  }

  private extractUsage(
    completion: ChatCompletion | Stream<ChatCompletionChunk>,
  ): ExtractedUsage | undefined {
    if ('usage' in completion) {
      return {
        prompt_tokens: completion.usage?.prompt_tokens,
        completion_tokens: completion.usage?.completion_tokens,
        total_tokens: completion.usage?.total_tokens,
      };
    }
    return undefined;
  }

  private mapFinishReason(finishReason: string | null): 'stop' | 'tool_calls' | 'length' {
    if (finishReason === 'tool_calls') {
      return 'tool_calls';
    }
    if (finishReason === 'stop') {
      return 'stop';
    }
    if (finishReason === 'length') {
      return 'length';
    }
    return 'stop';
  }
}
