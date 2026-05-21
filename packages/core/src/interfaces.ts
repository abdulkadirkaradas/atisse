import type { OrchestratorError } from './errors.js';

/**
 * Lifecycle state enumeration for pipeline execution.
 * Exported for type-checking state transitions in InvalidStateTransitionError.
 */
export type LifecycleState =
  | 'INITIALIZED'
  | 'CONTEXT_INJECTING'
  | 'CONTEXT_INJECTED'
  | 'PROMPT_COMPOSED'
  | 'GENERATING'
  | 'TOOL_EXECUTING'
  | 'RETRYING'
  | 'FALLBACKING'
  | 'COMPLETING'
  | 'COMPLETED'
  | 'FAILED';

/**
 * Error code registry for all kernel error types.
 */
export type OrchestratorErrorCode =
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_MALFORMED_RESPONSE'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_VALIDATION_FAILED'
  | 'TOOL_NOT_FOUND'
  | 'CONTEXT_LOAD_FAILED'
  | 'CONTEXT_PROVIDER_FAILED'
  | 'MAX_RETRIES_EXCEEDED'
  | 'MAX_TOOL_ROUNDS_EXCEEDED'
  | 'TOKEN_LIMIT_EXCEEDED'
  | 'TIMEOUT_EXCEEDED'
  | 'FALLBACK_EXHAUSTED'
  | 'INVALID_STATE_TRANSITION'
  | 'CONFIG_VALIDATION_FAILED'
  | 'HOOK_EXECUTION_FAILED';

/**
 * Serialized error payload for event bus.
 * @see ToolResultError
 */
export interface EventErrorPayload {
  code: OrchestratorErrorCode;
  message: string;
  retryable: boolean;
}

/**
 * AI model provider interface.
 */
export interface AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  generate(request: PromptRequest): Promise<PromptResponse>;
  generateStream?(request: PromptRequest): Promise<AsyncIterable<StreamChunk>>;
}

/**
 * Provider capability flags.
 */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  maxContextTokens: number;
}

/**
 * Request payload for provider generation.
 */
export interface PromptRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Response from provider generation.
 */
export interface PromptResponse {
  text: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length';
}

/**
 * Message model - 4-arm discriminated union.
 */
export type Message =
  | { role: 'system'; content: string | MessageContent[] }
  | { role: 'user'; content: string | MessageContent[] }
  | { role: 'assistant'; content: string | MessageContent[]; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string | MessageContent[]; toolCallId: string; name: string };

/**
 * Message content types.
 */
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; mimeType: string };

/**
 * System message type extracted from Message union.
 */
export type SystemMessage = Extract<Message, { role: 'system' }>;

/**
 * Tool definition for LLM function calling.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Executable tool with implementation.
 */
export interface Tool extends ToolDefinition {
  execute(input: unknown): Promise<unknown>;
}

/**
 * Tool call request from LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Tool result - discriminated union with mutually exclusive output/error.
 * @see ToolResultError
 */
export type ToolResult =
  | { id: string; name: string; output: unknown; error?: never }
  | { id: string; name: string; output?: never; error: ToolResultError };

/**
 * Tool result error DTO.
 */
export interface ToolResultError {
  code: 'TOOL_EXECUTION_FAILED' | 'TOOL_VALIDATION_FAILED' | 'TOOL_NOT_FOUND';
  message: string;
  retryable: boolean;
}

/**
 * Memory adapter for session persistence.
 */
export interface MemoryAdapter {
  load(sessionId: string): Promise<Message[]>;
  save(sessionId: string, messages: Message[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/**
 * Input type for context providers.
 */
export type ContextProviderInput = Omit<RunInput, 'stream' | 'profile'>;

/**
 * Context provider for injection-time content retrieval.
 */
export interface ContextProvider {
  readonly id: string;
  provide(input: ContextProviderInput): Promise<SystemMessage[]>;
}

/**
 * Token usage tracking.
 */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/**
 * Timeout policy configuration.
 */
export interface TimeoutPolicy {
  generateTimeoutMs: number;
  toolTimeoutMs: number;
  totalTimeoutMs: number;
}

/**
 * Tool execution policy configuration.
 */
export interface ToolPolicy {
  maxToolRounds: number;
  allowParallelTools: boolean;
  toolTimeoutMs: number; // per Tool.execute(); enforced via Promise.race in ToolController; default: 10_000
}

/**
 * Run input parameters.
 */
export interface RunInput {
  prompt: string;
  profile?: string;
  sessionId?: string;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Run output result.
 */
export interface RunOutput {
  runId: string;
  text: string;
  toolResults: ToolResult[];
  usage: TokenUsage;
  durationMs: number;
  profile?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Stream chunk discriminated union.
 */
export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'done'; usage?: TokenUsage }
  | { type: 'error'; error: OrchestratorError };

/**
 * Lifecycle hook function type.
 */
export type LifecycleHook<TContext> = (context: TContext) => Promise<TContext> | TContext;

/**
 * Hook registry with all available hook points.
 */
export interface HookRegistry {
  beforeRun: ReadonlyArray<LifecycleHook<RunContext>>;
  afterRun: ReadonlyArray<LifecycleHook<AfterRunContext>>;
  beforeGenerate: ReadonlyArray<LifecycleHook<BeforeGenerateContext>>;
  afterGenerate: ReadonlyArray<LifecycleHook<AfterGenerateContext>>;
  beforeTool: ReadonlyArray<LifecycleHook<ToolContext>>;
  afterTool: ReadonlyArray<LifecycleHook<AfterToolContext>>;
}

/**
 * Run context for beforeRun hook.
 */
export interface RunContext {
  input: RunInput;
  runId: string;
}

/**
 * AfterRun context with output.
 */
export type AfterRunContext = RunContext & { output: RunOutput };

/**
 * BeforeGenerate context - response not yet available.
 */
export interface BeforeGenerateContext {
  messages: Message[];
  input: RunInput;
  runId: string;
}

/**
 * AfterGenerate context with response.
 */
export interface AfterGenerateContext {
  messages: Message[];
  response: PromptResponse;
  input: RunInput;
  runId: string;
}

/**
 * Tool execution context.
 */
export interface ToolContext {
  toolCall: ToolCall;
  input: RunInput;
  runId: string;
}

/**
 * AfterTool context with result.
 */
export type AfterToolContext = ToolContext & { toolResult: ToolResult };

/**
 * Logger interface.
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Orchestrator configuration.
 */
export interface OrchestratorConfig {
  provider: AIProvider;
  fallbackProvider?: AIProvider;
  systemPrompt?: string;
  tools?: Tool[];
  contextProviders?: ContextProvider[];
  memoryAdapter?: MemoryAdapter;
  retry?: Partial<RetryPolicy>;
  timeout?: Partial<TimeoutPolicy>;
  toolPolicy?: Partial<ToolPolicy>;
  hooks?: Partial<HookRegistry>;
  profiles?: Record<string, OrchestratorProfile>;
  logger?: Logger;
}

/**
 * Orchestrator profile for run-time configuration.
 */
export interface OrchestratorProfile {
  name: string;
  description?: string;
  provider?: AIProvider;
  fallbackProvider?: AIProvider;
  systemPrompt?: string;
  retry?: Partial<RetryPolicy>;
  timeout?: Partial<TimeoutPolicy>;
  toolPolicy?: Partial<ToolPolicy>;
  contextProviders?: ContextProvider[];
  tools?: Tool[];
  hooks?: Partial<HookRegistry>;
}

/**
 * Main orchestration class for LLM interactions.
 * @example
 * const orchestrator = new Orchestrator({ provider });
 * const result = await orchestrator.run({ prompt: 'Hello' });
 */
export declare class Orchestrator {
  constructor(config: OrchestratorConfig);
  run(input: RunInput & { stream?: false }): Promise<RunOutput>;
  run(input: RunInput & { stream: true }): Promise<AsyncIterable<StreamChunk>>;
  run(input: RunInput): Promise<RunOutput> | Promise<AsyncIterable<StreamChunk>>;
  on<T extends OrchestratorEvent['type']>(
    type: T,
    listener: (event: Extract<OrchestratorEvent, { type: T }>) => void,
  ): () => void;
}

/**
 * Event bus interface - internal only.
 */
export interface EventBus {
  emit<T extends OrchestratorEvent>(event: T): void;
  on<T extends OrchestratorEvent['type']>(
    type: T,
    listener: (event: Extract<OrchestratorEvent, { type: T }>) => void,
  ): () => void;
}

/**
 * Orchestrator event types.
 */
export type OrchestratorEvent =
  | { type: 'run.started'; runId: string; timestamp: number; profile?: string }
  | { type: 'run.completed'; runId: string; durationMs: number; usage: TokenUsage }
  | { type: 'run.failed'; runId: string; error: OrchestratorError }
  | { type: 'generate.started'; runId: string; messageCount: number }
  | { type: 'generate.completed'; runId: string; durationMs: number; finishReason: string }
  | { type: 'tool.called'; runId: string; toolName: string; round: number }
  | { type: 'tool.completed'; runId: string; toolName: string; durationMs: number }
  | { type: 'tool.failed'; runId: string; toolName: string; error: EventErrorPayload }
  | { type: 'retry.attempt'; runId: string; attempt: number; reason: string; delayMs: number }
  | { type: 'fallback.triggered'; runId: string; reason: string }
  | { type: 'context.loaded'; runId: string; providerId: string; messageCount: number }
  | { type: 'context.failed'; runId: string; providerId: string; error: EventErrorPayload }
  | {
      type: 'profile.resolved';
      runId: string;
      profileName: string;
      overrides: {
        provider: boolean;
        tools: boolean;
        contextProviders: boolean;
        systemPrompt: boolean;
        retry: boolean;
        toolPolicy: boolean;
      };
      hookCount: number;
    };
