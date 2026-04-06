import type {
  AIProvider,
  PromptRequest,
  PromptResponse,
  StreamChunk,
  ToolCall,
  ProviderCapabilities,
} from '../interfaces.js';
import { ProviderUnavailableError } from '../errors.js';
import type { OrchestratorError } from '../errors.js';

export type MockProviderEntry =
  | { text: string; toolCalls?: ToolCall[]; finishReason?: PromptResponse['finishReason'] }
  | { error: OrchestratorError };

export class MockProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  private queue: MockProviderEntry[] = [];
  private _callCount = 0;
  private _history: PromptRequest[] = [];

  constructor(id = 'mock-test') {
    this.id = id;
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: false,
      maxContextTokens: 128_000,
    };
  }

  enqueue(entry: MockProviderEntry): this {
    this.queue.push(entry);
    return this;
  }

  callCount(): number {
    return this._callCount;
  }

  wasCalledTimes(n: number): boolean {
    return this._callCount === n;
  }

  lastRequest(): PromptRequest | undefined {
    return this._history[this._history.length - 1];
  }

  calls(): PromptRequest[] {
    return [...this._history];
  }

  reset(): void {
    this.queue = [];
    this._callCount = 0;
    this._history = [];
  }

  generate(request: PromptRequest): Promise<PromptResponse> {
    this._callCount++;
    this._history.push(request);

    if (this.queue.length === 0) {
      throw new ProviderUnavailableError('MockProvider queue is empty');
    }

    const entry = this.queue.shift();
    if (!entry) {
      throw new ProviderUnavailableError('MockProvider queue is empty');
    }

    if ('error' in entry) {
      return Promise.reject(entry.error);
    }

    // Infer finishReason from toolCalls if not explicitly provided
    let finishReason = entry.finishReason ?? 'stop';
    if (!entry.finishReason && entry.toolCalls && entry.toolCalls.length > 0) {
      finishReason = 'tool_calls';
    }

    return Promise.resolve({
      text: entry.text,
      toolCalls: entry.toolCalls ?? [],
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason,
    });
  }

  generateStream(request: PromptRequest): Promise<AsyncIterable<StreamChunk>> {
    this._callCount++;
    this._history.push(request);

    if (this.queue.length === 0) {
      const error = new ProviderUnavailableError('MockProvider queue is empty');
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield { type: 'error', error };
        },
      });
    }

    const entry = this.queue.shift();
    if (!entry) {
      const error = new ProviderUnavailableError('MockProvider queue is empty');
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield { type: 'error', error };
        },
      });
    }

    if ('error' in entry) {
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield { type: 'error', error: entry.error };
        },
      });
    }

    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (const char of entry.text) {
          await Promise.resolve();
          yield { type: 'text', delta: char };
        }
        yield { type: 'done' };
      },
    });
  }
}
