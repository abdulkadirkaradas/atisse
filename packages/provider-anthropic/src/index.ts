import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/messages';
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
  ConfigValidationError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderAuthError,
  ProviderMalformedResponse,
  OrchestratorError,
} from '@atisse/core';

interface AnthropicErrorResponse {
  status?: number;
  message?: string;
  cause?: unknown;
  headers?: Record<string, string | undefined>;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicTextDelta {
  type: 'text_delta';
  text: string;
}

interface AnthropicInputJSONDelta {
  type: 'input_json_delta';
  partial_json: string;
}

type AnthropicStreamEvent =
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: AnthropicTextDelta | AnthropicInputJSONDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string; stop_sequence: string | null }; usage?: { output_tokens: number } }
  | { type: 'message_stop' };

interface AnthropicTextBlockParam {
  type: 'text';
  text: string;
}

interface AnthropicImageBlockParam {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface AnthropicToolUseBlockParam {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicContentBlockParam[];
}

type AnthropicContentBlockParam =
  | AnthropicTextBlockParam
  | AnthropicImageBlockParam
  | AnthropicToolUseBlockParam
  | AnthropicToolResultBlockParam;

interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlockParam[];
}

interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Keys reserved by the adapter — cannot be overridden by providerOptions. */
const RESERVED_PROVIDER_OPTIONS = new Set([
  'model',
  'messages',
  'stream',
  'max_tokens',
  'tools',
  'system',
  'tool_choice',
]);

/** Validate providerOptions against reserved keys. Throws if conflict found. */
function validateProviderOptions(
  providerOptions: Record<string, unknown>,
  reservedKeys: Set<string>,
): void {
  for (const key of Object.keys(providerOptions)) {
    if (reservedKeys.has(key)) {
      throw new ConfigValidationError([
        `providerOptions key '${key}' is reserved and cannot be overridden`,
      ]);
    }
  }
}

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class AnthropicProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(config: AnthropicProviderConfig) {
    this.model = config.model ?? 'claude-sonnet-4-5';
    this.id = `anthropic-${this.model}`;
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: true,
      maxContextTokens: 200_000,
    };
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async generate(request: PromptRequest): Promise<PromptResponse> {
    try {
      const { system, messages } = this.mapMessages(request.messages);
      const tools = request.tools ? this.mapTools(request.tools) : undefined;

      const createParams: Record<string, unknown> = {
        model: this.model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
      };

      if (system) createParams.system = system;
      if (tools) createParams.tools = tools;
      if (request.temperature !== undefined) createParams.temperature = request.temperature;
      if (request.providerOptions) {
        validateProviderOptions(request.providerOptions, RESERVED_PROVIDER_OPTIONS);
        Object.assign(createParams, request.providerOptions);
      }

      const response = await this.client.messages.create(
        createParams as unknown as MessageCreateParamsBase,
        request.signal ? { signal: request.signal } : undefined,
      );

      return this.extractResponse(response as unknown as AnthropicMessageResponse);
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.mapError(error);
    }
  }

  async generateStream(request: PromptRequest): Promise<AsyncIterable<StreamChunk>> {
    try {
      const { system, messages } = this.mapMessages(request.messages);
      const tools = request.tools ? this.mapTools(request.tools) : undefined;

      const createParams: Record<string, unknown> = {
        model: this.model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        stream: true,
      };

      if (system) createParams.system = system;
      if (tools) createParams.tools = tools;
      if (request.temperature !== undefined) createParams.temperature = request.temperature;
      if (request.providerOptions) {
        validateProviderOptions(request.providerOptions, RESERVED_PROVIDER_OPTIONS);
        Object.assign(createParams, request.providerOptions);
      }

      const stream = await this.client.messages.create(
        createParams as unknown as MessageCreateParamsBase,
        request.signal ? { signal: request.signal } : undefined,
      );

      return this.assembleStream(stream as AsyncIterable<unknown>);
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.mapError(error);
    }
  }

  private async *assembleStream(
    stream: AsyncIterable<unknown>,
  ): AsyncIterable<StreamChunk> {
    interface TrackedBlock {
      type: string;
      id: string | undefined;
      name: string | undefined;
      args: string;
    }

    const blocks = new Map<number, TrackedBlock>();
    let finalUsage: TokenUsage | undefined;

    try {
      for await (const raw of stream) {
        const event = raw as AnthropicStreamEvent;

        if (event.type === 'content_block_start') {
          const block = event.content_block;
          const tracked: TrackedBlock = {
            type: block.type,
            id: block.type === 'tool_use' ? block.id : undefined,
            name: block.type === 'tool_use' ? block.name : undefined,
            args: '',
          };
          blocks.set(event.index, tracked);
          continue;
        }

        if (event.type === 'content_block_delta') {
          const tracked = blocks.get(event.index);
          if (!tracked) continue;

          if (event.delta.type === 'text_delta' && tracked.type === 'text') {
            yield { type: 'text', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta' && tracked.type === 'tool_use') {
            tracked.args += event.delta.partial_json;
          }
          continue;
        }

        if (event.type === 'content_block_stop') {
          const tracked = blocks.get(event.index);
          if (tracked?.type === 'tool_use' && tracked.name) {
            let input: unknown;
            try {
              input = JSON.parse(tracked.args || '{}');
            } catch {
              yield { type: 'error', error: new ProviderMalformedResponse('Failed to parse tool call arguments') };
              return;
            }

            const toolCall: ToolCall = {
              id: tracked.id || randomUUID(),
              name: tracked.name,
              input,
            };
            yield { type: 'tool_call', toolCall };
          }
          continue;
        }

        if (event.type === 'message_delta') {
          if (event.usage) {
            finalUsage = {
              prompt: 0,
              completion: event.usage.output_tokens,
              total: event.usage.output_tokens,
            };
          }
          continue;
        }

        if (event.type === 'message_stop') {
          yield { type: 'done', ...(finalUsage ? { usage: finalUsage } : {}) };
          return;
        }
      }

      yield { type: 'done', ...(finalUsage ? { usage: finalUsage } : {}) };
    } catch (error: unknown) {
      const mapped = this.toOrchestratorError(error);
      yield { type: 'error', error: mapped };
      return;
    }
  }

  private extractResponse(message: AnthropicMessageResponse): PromptResponse {
    // Defensive validation — fail fast with non-retryable error
    if (!message.content || !Array.isArray(message.content)) {
      throw new ProviderMalformedResponse(
        'Anthropic response missing "content" array',
      );
    }
    if (!message.usage || typeof message.usage.input_tokens !== 'number') {
      throw new ProviderMalformedResponse(
        'Anthropic response missing valid "usage" object',
      );
    }

    const text = message.content
      .filter((c): c is AnthropicTextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    const toolUseBlocks = message.content.filter(
      (c): c is AnthropicToolUseBlock => c.type === 'tool_use',
    );

    const result: PromptResponse = {
      text,
      usage: {
        prompt: message.usage.input_tokens,
        completion: message.usage.output_tokens,
        total: message.usage.input_tokens + message.usage.output_tokens,
      },
      finishReason: this.mapFinishReason(message.stop_reason),
    };

    if (toolUseBlocks.length > 0) {
      result.toolCalls = toolUseBlocks.map((block) => ({
        id: block.id || randomUUID(),
        name: block.name,
        input: block.input,
      }));
    }

    return result;
  }

  private mapFinishReason(
    stopReason: string | null,
  ): 'stop' | 'tool_calls' | 'length' {
    if (stopReason === 'end_turn') return 'stop';
    if (stopReason === 'tool_use') return 'tool_calls';
    if (stopReason === 'max_tokens') return 'length';
    if (stopReason === 'stop_sequence') return 'stop';

    throw new ProviderMalformedResponse(
      `Unrecognized stop_reason: ${stopReason ?? 'null'}`,
    );
  }

  private mapMessages(messages: Message[]): {
    system?: string;
    messages: AnthropicMessageParam[];
  } {
    const systemParts: string[] = [];
    const mapped: AnthropicMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = this.extractTextContent(msg.content);
        systemParts.push(text);
        continue;
      }

      if (msg.role === 'user') {
        const content = this.mapUserContent(msg.content);
        mapped.push({ role: 'user', content });
        continue;
      }

      if (msg.role === 'assistant') {
        const content = this.mapAssistantContent(msg.content, msg.toolCalls);
        mapped.push({ role: 'assistant', content });
        continue;
      }

      if (msg.role === 'tool') {
        const content = this.mapToolResultContent(msg.content, msg.toolCallId);
        mapped.push({ role: 'user', content });
        continue;
      }
    }

    return {
      ...(systemParts.length > 0 ? { system: systemParts.join('\n') } : {}),
      messages: mapped,
    };
  }

  private mapUserContent(
    content: string | MessageContent[],
  ): string | AnthropicContentBlockParam[] {
    if (typeof content === 'string') {
      return content;
    }

    return content.map((c): AnthropicContentBlockParam => {
      if (c.type === 'text') {
        return { type: 'text', text: c.text };
      }
      return this.parseImageContent(c);
    });
  }

  private parseImageContent(image: { url: string; mimeType: string }): AnthropicImageBlockParam {
    if (!image.url.startsWith('data:')) {
      throw new ProviderMalformedResponse('Image URL must be a data URI for Anthropic provider');
    }

    const matches = image.url.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new ProviderMalformedResponse('Invalid data URI format');
    }

    const mediaType = matches[1];
    const data = matches[2];

    if (!mediaType || !data) {
      throw new ProviderMalformedResponse('Invalid data URI format');
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data,
      },
    };
  }

  private mapAssistantContent(
    content: string | MessageContent[],
    toolCalls?: ToolCall[],
  ): AnthropicContentBlockParam[] {
    const blocks: AnthropicContentBlockParam[] = [];

    const text = typeof content === 'string' ? content : this.extractTextContent(content);
    if (text) {
      blocks.push({ type: 'text', text });
    }

    if (toolCalls) {
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
    }

    return blocks;
  }

  private mapToolResultContent(
    content: string | MessageContent[],
    toolCallId: string,
  ): AnthropicContentBlockParam[] {
    if (typeof content === 'string') {
      return [{ type: 'tool_result', tool_use_id: toolCallId, content }];
    }

    return [{
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: content.map((c): AnthropicContentBlockParam => {
        if (c.type === 'text') {
          return { type: 'text', text: c.text };
        }
        return this.parseImageContent(c);
      }),
    }];
  }

  private extractTextContent(content: string | MessageContent[]): string {
    if (typeof content === 'string') return content;
    return content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join(' ');
  }

  private mapTools(tools: ToolDefinition[]): AnthropicToolParam[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  private mapError(error: unknown): never {
    throw this.toOrchestratorError(error);
  }

  private toOrchestratorError(error: unknown): OrchestratorError {
    if (error instanceof OrchestratorError) return error;

    const err = error as AnthropicErrorResponse;

    if (err.status !== undefined) {
      const status = err.status;

      if (status === 429) {
        const retryAfterHeader = err.headers?.['retry-after'];
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 || undefined : undefined;
        return new ProviderRateLimitError('Rate limit exceeded', retryAfterMs, err.cause);
      }

      if (status === 401 || status === 403) {
        return new ProviderAuthError('Authentication failed', err.cause);
      }

      if (status === 408) {
        return new ProviderTimeoutError('Request timed out', err.cause);
      }

      if (status >= 500) {
        return new ProviderUnavailableError('Provider unavailable', err.cause);
      }
    }

    return new ProviderUnavailableError('Provider unavailable', error);
  }
}
