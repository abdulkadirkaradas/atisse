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

/**
 * Failure injection configuration for MockProvider.
 * Allows injecting errors on specific call counts.
 */
export interface MockProviderFailureConfig {
  callIndex: number;
  error: OrchestratorError;
}

/**
 * Entry for MockProvider queue.
 * Either a successful response with optional tool calls, or an error to simulate failure.
 */
export type MockProviderEntry =
  | { text: string; toolCalls?: ToolCall[]; finishReason?: PromptResponse['finishReason'] }
  | { error: OrchestratorError };

/**
 * MockProviderEntry with explicit stream chunks for fine-grained streaming control.
 */
export type MockProviderStreamEntry = {
  chunks: StreamChunk[];
};

/**
 * Mock provider for testing. Implements AIProvider with a configurable response queue.
 *
 * Pre-populate the queue with enqueue() before each test, then call generate()
 * or generateStream() to consume entries in FIFO order.
 *
 * @example
 * const provider = new MockProvider();
 * provider.enqueue({ text: 'Hello, world!' });
 * const response = await provider.generate({ messages: [] });
 * console.log(response.text); // 'Hello, world!'
 */
export class MockProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  private queue: MockProviderEntry[] = [];
  private streamQueue: MockProviderStreamEntry[] = [];
  private _callCount = 0;
  private _history: PromptRequest[] = [];
  private _failureInjections: MockProviderFailureConfig[] = [];

  constructor(id = 'mock-test') {
    this.id = id;
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: false,
      maxContextTokens: 128_000,
    };
  }

  /**
   * Enqueue an entry for consumption by generate() or generateStream().
   *
   * Pushes the entry to **both** `queue` (for {@link generate}) and `streamQueue`
   * (for {@link generateStream}). This means:
   *
   * 1. A {@link generate} call consumes from `queue`.
   * 2. A {@link generateStream} call consumes from `streamQueue` first.
   * 3. If `streamQueue` is empty, {@link generateStream} **falls back** to `queue`,
   *    consuming the same logical entry a second time.
   *
   * This dual-queue fallback is intentional — it allows testing mixed
   * generate/generateStream call sequences without manually managing both queues.
   */
  enqueue(entry: MockProviderEntry): this {
    this.queue.push(entry);
    this.streamQueue.push(this._entryToStreamChunks(entry));
    return this;
  }

  /**
   * Enqueue a stream entry for consumption by generateStream().
   * Unlike enqueue(), this does NOT push to the regular queue.
   */
  enqueueStream(entry: MockProviderStreamEntry): this {
    this.streamQueue.push(entry);
    return this;
  }

  /**
   * Convert entry to stream chunks for generateStream.
   */
  private _entryToStreamChunks(entry: MockProviderEntry): MockProviderStreamEntry {
    if ('error' in entry) {
      return { chunks: [{ type: 'error', error: entry.error }] };
    }

    const chunks: StreamChunk[] = [];

    // Yield text chunks
    for (const char of entry.text) {
      chunks.push({ type: 'text', delta: char });
    }

    // Yield tool_call chunks
    if (entry.toolCalls && entry.toolCalls.length > 0) {
      for (const toolCall of entry.toolCalls) {
        chunks.push({ type: 'tool_call', toolCall });
      }
    }

    // Yield done
    chunks.push({ type: 'done', usage: { prompt: 0, completion: 0, total: 0 } });

    return { chunks };
  }

  /** Returns the total number of generate()/generateStream() calls made. */
  callCount(): number {
    return this._callCount;
  }

  /** Returns true if the provider was called exactly n times. */
  wasCalledTimes(n: number): boolean {
    return this._callCount === n;
  }

  /** Returns the most recent PromptRequest received, or undefined if never called. */
  lastRequest(): PromptRequest | undefined {
    return this._history[this._history.length - 1];
  }

  /** Returns a copy of all PromptRequest calls received. */
  calls(): PromptRequest[] {
    return [...this._history];
  }

  /** Resets all queues, call count, history, and failure injections. */
  reset(): void {
    this.queue = [];
    this.streamQueue = [];
    this._callCount = 0;
    this._history = [];
    this._failureInjections = [];
  }

  /**
   * Inject a failure to be thrown on a specific call count (1-indexed).
   * @param callIndex - The call number to inject failure (1 = first call, 2 = second call, etc.)
   * @param error - The error to throw
   */
  failureOnCall(callIndex: number, error: OrchestratorError): this {
    this._failureInjections.push({ callIndex, error });
    return this;
  }

  /**
   * Clear all failure injections.
   */
  clearFailures(): void {
    this._failureInjections = [];
  }

  /**
   * Check if a failure should be injected for the current call.
   */
  private _shouldInjectFailure(): OrchestratorError | undefined {
    const nextCall = this._callCount;
    for (const config of this._failureInjections) {
      if (config.callIndex === nextCall) {
        return config.error;
      }
    }
    return undefined;
  }

  generate(request: PromptRequest): Promise<PromptResponse> {
    this._callCount++;
    this._history.push(request);

    // Check for injected failure
    const injectedError = this._shouldInjectFailure();
    if (injectedError) {
      return Promise.reject(injectedError);
    }

    if (this.queue.length === 0) {
      return Promise.reject(new ProviderUnavailableError('MockProvider queue is empty'));
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const entry = this.queue.shift()!;

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

    // Check for injected failure
    const injectedError = this._shouldInjectFailure();
    if (injectedError) {
      return Promise.reject(injectedError);
    }

    // Use stream queue if available
    if (this.streamQueue.length > 0) {
      const entry = this.streamQueue.shift();
      if (!entry) {
        const error = new ProviderUnavailableError('MockProvider stream queue is empty');
        return Promise.resolve({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield { type: 'error', error };
          },
        });
      }

      // Check if it's an error entry (rejection)
      if (entry.chunks.length === 1) {
        const firstChunk = entry.chunks[0];
        if (firstChunk && firstChunk.type === 'error') {
          const err = firstChunk.error;
          return Promise.reject(err);
        }
      }

      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          for (const chunk of entry.chunks) {
            await Promise.resolve();
            yield chunk;
          }
        },
      });
    }

    // Fallback to regular queue conversion
    if (this.queue.length === 0) {
      const error = new ProviderUnavailableError('MockProvider queue is empty');
      return Promise.reject(error);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const entry = this.queue.shift()!;

    if ('error' in entry) {
      return Promise.reject(entry.error);
    }

    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (const char of entry.text) {
          await Promise.resolve();
          yield { type: 'text', delta: char };
        }

        if (entry.toolCalls && entry.toolCalls.length > 0) {
          for (const toolCall of entry.toolCalls) {
            await Promise.resolve();
            yield { type: 'tool_call', toolCall };
          }
        }

        yield { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } };
      },
    });
  }
}
