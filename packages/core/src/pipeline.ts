/**
 * Pipeline — Layer 3
 *
 * Wires all 10 execution steps together.
 * All execution state is local to the function - never stored on Orchestrator instance.
 */

import type {
  RunInput,
  RunOutput,
  Message,
  SystemMessage,
  EventBus,
  Logger,
  ContextProviderInput,
  PromptRequest,
  PromptResponse,
  StreamChunk,
  ToolResult,
  ToolCall,
  AIProvider,
  TokenUsage,
  OrchestratorEvent,
} from './interfaces.js';
import type { ResolvedConfig } from './types.js';
import type { OrchestratorError } from './errors.js';
import type { EventErrorPayload } from './interfaces.js';
import type { HookRegistry } from './interfaces.js';
import { TimingCollector } from './timing-collector.js';
import { LifecycleStateMachine } from './lifecycle.js';
import { type ComposeParams, PromptComposer } from './prompt-composer.js';
import { ToolController } from './tool-controller.js';
import { runHooks, normalizeHookRegistry } from './hooks.js';
import { abortableSleep, calculateDelay, executeWithRetry, withTimeout } from './policies.js';
import {
  isRetryable,
  RunCancelledError,
  TimeoutExceededError,
  MaxToolRoundsExceededError,
  FallbackExhaustedError,
  ToolExecutionError,
  ToolValidationError,
  ToolNotFoundError,
  ContextLoadError,
  MaxRetriesExceededError,
  ConfigValidationError,
  PipelineInternalError,
  MemorySaveError,
  OrchestratorError as OrchestratorErrorClass,
} from './errors.js';

/**
 * Helper to convert an OrchestratorError to EventErrorPayload for event emission.
 */
function toEventErrorPayload(error: OrchestratorError): EventErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

/**
 * Build a PromptRequest from messages and config.
 * Shared by both streaming and non-streaming paths.
 */
function buildPromptRequest(
  messages: Message[],
  config: ResolvedConfig,
  signal?: AbortSignal,
): PromptRequest {
  const timeoutSignal =
    config.timeout.generateTimeoutMs > 0
      ? AbortSignal.timeout(config.timeout.generateTimeoutMs)
      : undefined;

  const composedSignal =
    signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);

  return {
    messages,
    ...(config.toolDefinitions ? { tools: config.toolDefinitions } : {}),
    ...(composedSignal ? { signal: composedSignal } : {}),
  };
}

type GenerationRoundResult =
  | { action: 'continue'; toolAttempt: number }
  | { action: 'break'; response: PromptResponse };

type ExecutionResponse = { response: PromptResponse };

type StreamingGenerationRoundResult =
  | { action: 'continue'; chunksToYield: StreamChunk[] }
  | { action: 'break'; response: PromptResponse; finalChunks: StreamChunk[] }
  | { action: 'error'; error: OrchestratorError; chunksToYield: StreamChunk[] };

/**
 * Wraps an AsyncIterable with a per-iteration idle timeout.
 * If the time between consecutive `next()` calls exceeds `timeoutMs`,
 * the wrapped iterator throws TimeoutExceededError.
 *
 * When timeoutMs <= 0, passthrough with no timeout wrapping.
 * Preserves yield order — each chunk is yielded as it arrives.
 *
 * File-private — NOT exported.
 */
async function* asyncIteratorWithIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  onTimeout?: () => void,
): AsyncGenerator<T, void, undefined> {
  const iterator = iterable[Symbol.asyncIterator]();

  while (true) {
    await abortRunCall(signal ? { signal } : {});
    if (timeoutMs <= 0) {
      const result = await iterator.next();
      if (result.done) return;
      yield result.value;
      continue;
    }

    let timerHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const nextPromise = iterator.next();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerHandle = setTimeout(() => {
          onTimeout?.();
          reject(new TimeoutExceededError(timeoutMs));
        }, timeoutMs);
      });

      const result = await Promise.race([nextPromise, timeoutPromise]);
      if (result.done) return;
      yield result.value;
    } finally {
      if (timerHandle !== undefined) {
        clearTimeout(timerHandle);
      }
    }
  }
}

/**
 * Handle errors thrown during pipeline execution and convert to appropriate OrchestratorError subtypes if needed.
 *
 * @param error - the original error thrown
 * @param config - the resolved configuration, used to determine timeout values for wrapping unknown errors
 * @param timeoutMs - optional specific timeout value to use when wrapping unknown errors (e.g. generateTimeoutMs for generation step), falls back to totalTimeoutMs if not provided
 * @returns - an OrchestratorError instance that can be emitted and logged consistently
 * @remarks
 * This function ensures that all errors emitted by the pipeline are instances of OrchestratorError (or its subtypes) for consistent handling downstream.
 * It preserves the original error message and code when possible, and wraps unknown errors in a generic TimeoutExceededError to avoid losing error information.
 * This is important for observability and debugging, as it ensures that all errors have a consistent structure and can be properly categorized in events and logs.
 */
function handleOrchestratorError(
  error: unknown,
  config: ResolvedConfig,
  timeoutMs?: number,
): OrchestratorError {
  // ── FAILED path ────────────────────────────────────────
  // Always properly propagate errors:
  // 1. OrchestratorError subtypes -> pass through
  // 2. Hook errors (beforeGenerate, afterGenerate, beforeTool, afterTool, beforeRun, afterRun) -> pass through
  // 3. Any other Error -> pass through (don't convert to timeout)
  // 4. Unknown errors -> wrap as generic OrchestratorError
  let err: OrchestratorErrorClass;
  if (error instanceof OrchestratorErrorClass) {
    err = error;
  } else if (error instanceof Error) {
    // Wrap non-OrchestratorError instances to satisfy the StreamChunk error contract.
    // PipelineInternalError is used (not HookExecutionError) because this catch
    // block handles errors from the entire pipeline execution, not just hook code.
    err = new PipelineInternalError(error.message, error);
  } else {
    // Unknown non-Error - wrap it
    err = new TimeoutExceededError(timeoutMs ?? config.timeout.totalTimeoutMs);
  }
  return err;
}

/**
 * Resolve profiles and emit profile.resolved event with details on active profile and overrides.
 *
 * @param runId - canonical runId for the execution (same across retries/fallbacks)
 * @param input - original RunInput which may contain profile reference
 * @param config - ResolvedConfig after profile merging, used to calculate overrides and hook count
 * @param eventBus - Event bus to emit profile.resolved event
 * @remarks
 * This function is called at the start of both run() and stream() pipelines to ensure that profile resolution is handled consistently and the profile.resolved event is emitted with the canonical runId before any retries or fallbacks occur.
 * The profile.resolved event includes details on which profile is active, what configuration keys it overrides, and how many hooks are registered after merging, providing valuable context for observability and debugging.
 */
function resolveProfiles(
  runId: string,
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
) {
  // Emit profile.resolved event with canonical runId
  if (input.profile) {
    const profiles = config.originalConfig?.profiles;
    const profileName = input.profile;
    const originalProfile = profiles?.[profileName];
    if (profiles && originalProfile) {
      // Calculate overrides based on what was set in the profile
      const overrides = {
        provider: originalProfile.provider !== undefined,
        tools: originalProfile.tools !== undefined,
        contextProviders: originalProfile.contextProviders !== undefined,
        systemPrompt: originalProfile.systemPrompt !== undefined,
        retry: originalProfile.retry !== undefined,
        toolPolicy: originalProfile.toolPolicy !== undefined,
      };

      // Calculate total hook count
      // config.hooks is already merged (base + profile) by resolveConfig()
      const mergedHooks = normalizeHookRegistry(config.hooks);
      const hookCount =
        mergedHooks.beforeRun.length +
        mergedHooks.afterRun.length +
        mergedHooks.beforeGenerate.length +
        mergedHooks.afterGenerate.length +
        mergedHooks.beforeTool.length +
        mergedHooks.afterTool.length;

      eventBus.emit({
        type: 'profile.resolved',
        runId,
        profileName: input.profile,
        overrides,
        hookCount,
      });
    }
  }
}

async function abortRunCall(abort: { delayMs?: number; signal?: AbortSignal }): Promise<void> {
  const { delayMs = 0, signal } = abort;

  if (signal?.aborted) {
    throw new RunCancelledError();
  }

  if (delayMs > 0) {
    const aborted = await abortableSleep(delayMs, signal);
    if (aborted || signal?.aborted) {
      throw new RunCancelledError();
    }
  }
}

/**
 * Helper 1: Steps 1–4 (INITIALIZED → CONTEXT_INJECTING → CONTEXT_INJECTED → PROMPT_COMPOSED)
 *
 * Consolidates identical initialization from both streaming and non-streaming paths:
 * - runId generation, stateMachine creation, startTime, activeProfile
 * - run.started event emission, resolveProfiles, hooks normalization
 * - context provider loading, memory loading, PromptComposer.compose
 *
 * File-private — NOT exported.
 */
async function initializePipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
  timing?: TimingCollector,
): Promise<{
  runId: string;
  startTime: number;
  trackDuration: () => number;
  stateMachine: LifecycleStateMachine;
  hooks: HookRegistry;
  activeProfile: string;
  activeProvider: AIProvider;
  messages: Message[];
  tempMessages: [Message, Message];
}> {
  // ── Step 1 — INITIALIZED ───────────────────────────────────────────
  // eslint-disable-next-line no-undef -- crypto is a global in Node.js 24+
  const runId = crypto.randomUUID();
  const startTime = Date.now();
  const stateMachine = new LifecycleStateMachine();
  const activeProfile = input.profile ?? '';

  // B-LOW-03 fix: use activeProvider consistently for memory budget calculation
  const activeProvider = config.provider;

  const tempMessages: [Message, Message] = [
    { role: 'user', content: input.prompt },
    { role: 'assistant', content: '' },
  ];

  // Emit run.started
  const startedEvent: OrchestratorEvent = {
    type: 'run.started',
    runId,
    timestamp: startTime,
  };
  if (activeProfile) {
    startedEvent.profile = activeProfile;
  }
  eventBus.emit(startedEvent);

  logger.info('Run started', { runId, profile: activeProfile, sessionId: input.sessionId });

  resolveProfiles(runId, input, config, eventBus);

  const trackDuration = (): number => Date.now() - startTime;

  // Normalize hooks once
  const hooks = normalizeHookRegistry(config.hooks);

  // beforeRun hooks
  await runHooks(hooks.beforeRun, { input, runId });

  // ── Step 2 — CONTEXT_INJECTING ────────────────────────────────
  stateMachine.transition('CONTEXT_INJECTING');
  logger.debug('State transition: CONTEXT_INJECTING', { runId });

  // Timing: start pipeline and context loading
  timing?.mark('start');
  timing?.mark('context_start');

  const contextProviderInput: ContextProviderInput = {
    prompt: input.prompt,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  // Execute each context provider sequentially
  const providerResults: SystemMessage[] = [];
  for (const provider of config.contextProviders) {
    try {
      const messages = await provider.provide(contextProviderInput);
      providerResults.push(...messages);
      eventBus.emit({
        type: 'context.loaded',
        runId,
        providerId: provider.id,
        messageCount: messages.length,
      });
    } catch (error: unknown) {
      const err =
        error instanceof OrchestratorErrorClass ? error : new ContextLoadError(provider.id, error);
      eventBus.emit({
        type: 'context.failed',
        runId,
        providerId: provider.id,
        error: toEventErrorPayload(err),
      });

      // Context errors use fail-fast strategy: context loading failures are treated as fatal
      // because the context is typically essential for the run to succeed.
      throw err;
    }
  }

  // ── Step 3 — CONTEXT_INJECTED + Memory Load ──────────────────
  stateMachine.transition('CONTEXT_INJECTED');
  logger.debug('State transition: CONTEXT_INJECTED', { runId });

  // Load memory if sessionId provided
  const memoryMessages =
    input.sessionId && config.memoryAdapter ? await config.memoryAdapter.load(input.sessionId) : [];

  // ── Step 4 — PROMPT_COMPOSED ──────────────────────────────────
  stateMachine.transition('PROMPT_COMPOSED');
  logger.debug('State transition: PROMPT_COMPOSED', { runId });

  // Timing: context loading complete (includes memory load)
  timing?.mark('context_end');

  const promptComposer = new PromptComposer();

  // Timing: composition starts
  timing?.mark('composition_start');

  // Calculate memory token budget based on activeProvider's max context tokens.
  // Reserve tokens for: system prompt, context messages, current user prompt,
  // plus a buffer for completion tokens and overhead (~2000 tokens).
  // B-LOW-03 fix: use activeProvider (not config.provider) consistently.
  const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
  const systemPromptTokens = config.systemPrompt ? estimateTokens(config.systemPrompt) : 0;
  const contextTokens = providerResults.reduce(
    (sum, msg) => sum + estimateTokens(typeof msg.content === 'string' ? msg.content : ''),
    0,
  );
  const userPromptTokens = estimateTokens(input.prompt);
  const reserveTokens = 2000;
  const memoryBudget =
    activeProvider.capabilities.maxContextTokens -
    systemPromptTokens -
    contextTokens -
    userPromptTokens -
    reserveTokens;

  const composeParams: ComposeParams = {
    contextMessages: providerResults,
    memoryMessages,
    userPrompt: input.prompt,
    ...(memoryBudget > 0 ? { maxTokens: memoryBudget } : null),
  };
  if (config.systemPrompt) {
    composeParams.systemPrompt = config.systemPrompt;
  }

  const messages = promptComposer.compose(composeParams);

  // Timing: composition complete
  timing?.mark('composition_end');

  return {
    runId,
    startTime,
    trackDuration,
    stateMachine,
    hooks,
    activeProfile,
    activeProvider,
    messages,
    tempMessages,
  };
}

/**
 * Helper 2: Step 6 (tool execution)
 *
 * Core tool execution logic shared by both streaming and non-streaming paths:
 * - Creates ToolController, runs beforeTool hooks
 * - Executes tool round via ToolController.executeRound
 * - Appends tool result messages, runs afterTool hooks
 * - Emits tool.called and tool.completed events
 *
 * Returns the ToolResult[] from this round so streaming path can yield tool_result chunks.
 * Error recovery (retry on ToolExecutionError, fatal on ToolValidationError/ToolNotFoundError)
 * is the responsibility of the caller.
 *
 * File-private — NOT exported.
 */
async function executeToolRound(
  roundNumber: number,
  toolCalls: ToolCall[],
  config: ResolvedConfig,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  trackDuration: () => number,
  messages: Message[],
  allToolResults: ToolResult[],
  input: RunInput,
): Promise<ToolResult[]> {
  const toolController = new ToolController(config.tools, config.toolPolicy, logger);

  // Run beforeTool hooks for each tool call
  for (const toolCall of toolCalls) {
    await runHooks(hooks.beforeTool, { toolCall, input, runId });
  }

  const toolResults = await toolController.executeRound(toolCalls);
  allToolResults.push(...toolResults);

  // Append tool results to messages and run afterTool hooks
  for (const result of toolResults) {
    const toolCall = toolCalls.find((tc) => tc.id === result.id);
    if (!toolCall) continue;

    // Build tool result message
    const toolMessage: Message = {
      role: 'tool',
      toolCallId: result.id,
      name: result.name,
      content: result.error
        ? `Error: ${result.error.message}`
        : typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output),
    };
    messages.push(toolMessage);

    // Run afterTool hooks
    await runHooks(hooks.afterTool, { toolCall, input, runId, toolResult: result });
  }

  // Emit events for each tool
  for (const result of toolResults) {
    const toolCall = toolCalls.find((tc) => tc.id === result.id);
    if (toolCall) {
      eventBus.emit({
        type: 'tool.called',
        runId,
        toolName: toolCall.name,
        round: roundNumber,
      });

      eventBus.emit({
        type: 'tool.completed',
        runId,
        toolName: toolCall.name,
        durationMs: trackDuration(),
      });
    }
  }

  return toolResults;
}

/**
 * Helper 3: Steps 9–10 (COMPLETING → COMPLETED)
 *
 * Wires completion logic shared by both paths:
 * - Transitions to COMPLETING
 * - Saves memory if sessionId present
 * - Builds RunOutput, runs afterRun hooks
 * - Transitions to COMPLETED, emits run.completed
 *
 * Returns the RunOutput for non-streaming path to return directly.
 * Streaming path uses the returned RunOutput for the 'done' chunk.
 *
 * File-private — NOT exported.
 */
async function finalizePipeline(
  stateMachine: LifecycleStateMachine,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  startTime: number,
  tempMessages: [Message, Message],
  usage: TokenUsage,
  input: RunInput,
  allToolResults: ToolResult[],
  activeProfile: string,
  memoryAdapter: ResolvedConfig['memoryAdapter'],
  responseText: string,
  timing?: TimingCollector,
): Promise<RunOutput> {
  // ── Step 9 — COMPLETING ──────────────────────────────────
  stateMachine.transition('COMPLETING');
  logger.debug('State transition: COMPLETING', { runId });

  // Timing: mark finalization start (before memory save)
  timing?.mark('finalization_start');

  // Save to memory if sessionId present
  await abortRunCall(input.signal ? { signal: input.signal } : {});
  if (input.sessionId && memoryAdapter) {
    try {
      await memoryAdapter.save(input.sessionId, [tempMessages[0], tempMessages[1]]);
    } catch (error: unknown) {
      // D-M2-1/A: Memory save failure -> FAILED (no retry check)
      throw new MemorySaveError(error);
    }
  }

  // Build output
  // Non-streaming: responseText comes from response.text
  // Streaming: responseText comes from accumulatedText (stored in tempMessages[1].content)
  const text = responseText;
  const output: RunOutput = {
    runId,
    text,
    toolResults: allToolResults,
    usage,
    durationMs: Date.now() - startTime,
    ...(activeProfile ? { profile: activeProfile } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  // Run afterRun hooks
  await runHooks(hooks.afterRun, { input, runId, output });

  // ── Step 10 — COMPLETED (terminal) ────────────────────────
  stateMachine.transition('COMPLETED');

  eventBus.emit({
    type: 'run.completed',
    runId,
    durationMs: Date.now() - startTime,
    usage: output.usage,
    ...(timing !== undefined ? { timings: timing.snapshot() } : {}),
  });

  logger.info('Run completed', {
    runId,
    durationMs: Date.now() - startTime,
    totalTokens: output.usage.total,
  });

  return output;
}

/**
 * Handle a provider error: attempt fallback if eligible, otherwise
 * throw or return continue signal.
 *
 * - MaxRetriesExceededError + fallbackProvider: switch to fallback, try once
 * - Non-retryable: rethrow
 * - Retryable without fallback: sleep, return continue
 *
 * File-private — NOT exported.
 */
async function handleProviderError(
  err: OrchestratorError,
  promptRequest: PromptRequest,
  providerAttempt: number,
  toolAttempt: number,
  config: ResolvedConfig,
  stateMachine: LifecycleStateMachine,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  signal?: AbortSignal,
): Promise<{ response: PromptResponse } | { action: 'continue'; toolAttempt: number }> {
  // Check for fallback
  if (err instanceof MaxRetriesExceededError && config.fallbackProvider) {
    // FALLBACKING
    stateMachine.transition('FALLBACKING');
    logger.warn('Fallback triggered', { runId, reason: err.code });
    eventBus.emit({
      type: 'fallback.triggered',
      runId,
      reason: err.code,
    });

    // Try fallback once with no retry
    try {
      const response = await config.fallbackProvider.generate(promptRequest);
      stateMachine.transition('GENERATING');
      return { response };
    } catch (fallbackError: unknown) {
      const fallbackErr = handleOrchestratorError(
        fallbackError,
        config,
        config.timeout.generateTimeoutMs,
      );
      throw new FallbackExhaustedError(err, fallbackErr);
    }
  }

  if (!isRetryable(err)) {
    // Not retryable - throw to FAILED
    throw err;
  }

  // Retryable without fallback - continue loop
  const delayMs = calculateDelay(providerAttempt, config.retry, err);
  await abortRunCall({ delayMs, ...(signal ? { signal } : {}) });
  stateMachine.transition('GENERATING');
  // Note: toolAttempt is passed through unchanged in GenerationRoundResult
  return { action: 'continue', toolAttempt };
}

/**
 * Execute a single tool round with error handling for retryable ToolExecutionError
 * and fail-fast for ToolValidationError / ToolNotFoundError.
 *
 * Transitions to TOOL_EXECUTING, executes tools, and handles errors.
 * Returns a GenerationRoundResult with 'continue' action and updated toolAttempt.
 * Throws on fail-fast errors (ToolValidationError, ToolNotFoundError).
 *
 * File-private — NOT exported.
 */
async function executeToolRoundWithErrorHandling(
  roundNumber: number,
  toolCalls: ToolCall[],
  config: ResolvedConfig,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  stateMachine: LifecycleStateMachine,
  trackDuration: () => number,
  messages: Message[],
  allToolResults: ToolResult[],
  input: RunInput,
  toolAttempt: number,
): Promise<GenerationRoundResult> {
  stateMachine.transition('TOOL_EXECUTING');
  logger.debug('State transition: TOOL_EXECUTING', { runId, round: roundNumber });

  try {
    await executeToolRound(
      roundNumber,
      toolCalls,
      config,
      hooks,
      eventBus,
      logger,
      runId,
      trackDuration,
      messages,
      allToolResults,
      input,
    );
  } catch (error: unknown) {
    const err =
      error instanceof OrchestratorErrorClass ? error : new ToolExecutionError('unknown', error);

    // ToolValidationError, ToolNotFoundError -> FAILED (fail-fast)
    if (err instanceof ToolValidationError || err instanceof ToolNotFoundError) {
      throw err;
    }

    // ToolExecutionError -> emit failed event and retry with exponential backoff
    const toolCallName = err instanceof ToolExecutionError ? err.toolName : 'unknown';

    eventBus.emit({
      type: 'tool.failed',
      runId,
      toolName: toolCallName,
      error: toEventErrorPayload(err),
    });

    const delayMs = calculateDelay(toolAttempt, config.retry, err);
    await abortRunCall({ delayMs, ...(input.signal ? { signal: input.signal } : {}) });

    return { action: 'continue', toolAttempt: toolAttempt + 1 };
  }

  // Success — toolAttempt unchanged
  return { action: 'continue', toolAttempt };
}

/**
 * Execute a single generation round within the non-streaming pipeline.
 *
 * Handles GENERATING state transition, provider call with retry,
 * fallback, tool execution routing, and round counter management.
 *
 * Returns GenerationRoundResult directing the caller to continue or break.
 *
 * File-private — NOT exported.
 */
async function executeGenerationRound(
  roundCounter: number,
  toolAttempt: number,
  activeProvider: AIProvider,
  config: ResolvedConfig,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  stateMachine: LifecycleStateMachine,
  trackDuration: () => number,
  messages: Message[],
  tempMessages: [Message, Message],
  allToolResults: ToolResult[],
  input: RunInput,
): Promise<GenerationRoundResult> {
  stateMachine.transition('GENERATING');
  logger.debug('State transition: GENERATING', { runId });

  // Run beforeGenerate hooks
  await runHooks(hooks.beforeGenerate, { messages, input, runId });

  eventBus.emit({
    type: 'generate.started',
    runId,
    messageCount: messages.length,
  });

  // Build PromptRequest using shared helper
  const promptRequest = buildPromptRequest(messages, config, input.signal);

  let providerAttempt = 0;
  let response: PromptResponse;

  await abortRunCall(input.signal ? { signal: input.signal } : {});

  // Try to generate with retry
  try {
    response = await executeWithRetry(
      () => activeProvider.generate(promptRequest),
      config.retry,
      (retryAttempt, error) => {
        providerAttempt = retryAttempt;
        const delayMs = calculateDelay(retryAttempt, config.retry, error);

        // Transition to RETRYING state - pause before next generation attempt
        stateMachine.transition('RETRYING');
        logger.warn('Retrying', {
          runId,
          attempt: retryAttempt,
          reason: error.code,
          delayMs,
        });

        eventBus.emit({
          type: 'retry.attempted',
          runId,
          attempt: retryAttempt,
          reason: error.code,
          delayMs,
        });
      },
      input.signal,
    );
  } catch (error: unknown) {
    const err = handleOrchestratorError(error, config, config.timeout.generateTimeoutMs);
    const result = await handleProviderError(
      err,
      promptRequest,
      providerAttempt,
      toolAttempt,
      config,
      stateMachine,
      eventBus,
      logger,
      runId,
      input.signal,
    );
    if ('action' in result) {
      return result; // { action: 'continue', toolAttempt }
    }
    response = result.response; // Fallback succeeded — fall through
  }

  // Transition back to GENERATING if we were in RETRYING state
  if (stateMachine.state === 'RETRYING') {
    stateMachine.transition('GENERATING');
  }

  // Success - check finish reason
  const finishReason = response.finishReason;

  eventBus.emit({
    type: 'generate.completed',
    runId,
    durationMs: trackDuration(),
    finishReason,
  });

  // Store assistant message
  const assistantContent = response.text;
  const assistantToolCalls = response.toolCalls;
  if (assistantToolCalls && assistantToolCalls.length > 0) {
    tempMessages[1] = {
      role: 'assistant',
      content: assistantContent,
      toolCalls: assistantToolCalls,
    };
  } else {
    tempMessages[1] = { role: 'assistant', content: assistantContent };
  }

  // Handle tool_calls
  if (finishReason === 'tool_calls' && response.toolCalls && response.toolCalls.length > 0) {
    // ── Step 6 — TOOL_EXECUTING ───────────────────────
    if (roundCounter >= config.toolPolicy.maxToolRounds) {
      throw new MaxToolRoundsExceededError(roundCounter, config.toolPolicy.maxToolRounds);
    }

    return await executeToolRoundWithErrorHandling(
      roundCounter + 1,
      response.toolCalls,
      config,
      hooks,
      eventBus,
      logger,
      runId,
      stateMachine,
      trackDuration,
      messages,
      allToolResults,
      input,
      toolAttempt,
    );
  }

  // No tool calls or finishReason is 'stop' | 'length'
  return { action: 'break', response };
}

/**
 * Execute all generation rounds within the non-streaming pipeline.
 *
 * Owns the generation while(true) loop that orchestrates the cycle of:
 *   GENERATING → (tool_calls → TOOL_EXECUTING → GENERATING) → stop/length
 *
 * Manages roundCounter and toolAttempt across rounds.
 * Returns the final PromptResponse when a break condition is reached.
 *
 * File-private — NOT exported.
 */
async function executeAllGenerationRounds(
  activeProvider: AIProvider,
  config: ResolvedConfig,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  stateMachine: LifecycleStateMachine,
  trackDuration: () => number,
  messages: Message[],
  tempMessages: [Message, Message],
  allToolResults: ToolResult[],
  input: RunInput,
  timing?: TimingCollector,
): Promise<ExecutionResponse> {
  let roundCounter = 0;
  let toolAttempt = 0;

  // Timing: mark generation and tool execution start once before the round loop
  timing?.mark('generation_start');
  timing?.mark('tool_execution_start');

  while (true) {
    const result = await executeGenerationRound(
      roundCounter,
      toolAttempt,
      activeProvider,
      config,
      hooks,
      eventBus,
      logger,
      runId,
      stateMachine,
      trackDuration,
      messages,
      tempMessages,
      allToolResults,
      input,
    );

    if (result.action === 'continue') {
      roundCounter++;
      toolAttempt = result.toolAttempt;
      continue;
    }

    return { response: result.response };
  }
}

/**
 * Execute the non-streaming orchestration pipeline (promoted from nested _execute).
 *
 * Initializes the pipeline, runs generation rounds, and finalizes.
 * All execution state is local to this function.
 *
 * File-private — NOT exported.
 */
async function executeNonStreamingPipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
): Promise<RunOutput> {
  let runId = '';
  let stateMachine = new LifecycleStateMachine();
  const timing = new TimingCollector();

  try {
    // ── Steps 1–4 — initializePipeline ──────────────────
    const init = await initializePipeline(input, config, eventBus, logger, timing);
    runId = init.runId;
    stateMachine = init.stateMachine;
    const { startTime, trackDuration, hooks, activeProfile, tempMessages } = init;
    const messages = init.messages;
    const allToolResults: ToolResult[] = [];

    // ── Step 5 — GENERATING (generation rounds) ─────────
    const { response } = await executeAllGenerationRounds(
      init.activeProvider,
      config,
      hooks,
      eventBus,
      logger,
      runId,
      stateMachine,
      trackDuration,
      messages,
      tempMessages,
      allToolResults,
      input,
      timing,
    );

    // Run afterGenerate hooks (after tool loop completes, before finalization)
    try {
      await runHooks(hooks.afterGenerate, { messages, response, input, runId });
    } catch (hookError: unknown) {
      throw handleOrchestratorError(hookError, config);
    }

    // ── Steps 9–10 — COMPLETING → COMPLETED ────────────
    return await finalizePipeline(
      stateMachine,
      hooks,
      eventBus,
      logger,
      runId,
      startTime,
      tempMessages,
      response.usage,
      input,
      allToolResults,
      activeProfile,
      config.memoryAdapter,
      response.text,
      timing,
    );
  } catch (error: unknown) {
    const err: OrchestratorErrorClass = handleOrchestratorError(error, config);

    // Attempt transition to FAILED
    try {
      stateMachine.transition('FAILED');
    } catch {
      // Already in a terminal state
    }

    eventBus.emit({
      type: 'run.failed',
      runId,
      error: err,
    });

    logger.error('Run failed', {
      runId,
      error: err.message,
      code: err.code,
    });

    throw err;
  }
}

/**
 * Execute a single streaming generation round.
 *
 * Handles stream setup with retry, stream consumption with chunk collection,
 * PromptResponse construction, and tool execution routing.
 * Instead of yielding chunks directly, collects them into arrays for the caller to yield.
 *
 * File-private — NOT exported.
 */
async function executeStreamingGenerationRound(
  roundCounter: number,
  toolAttempt: number,
  activeProvider: AIProvider,
  config: ResolvedConfig,
  hooks: HookRegistry,
  eventBus: EventBus,
  logger: Logger,
  runId: string,
  stateMachine: LifecycleStateMachine,
  trackDuration: () => number,
  messages: Message[],
  tempMessages: [Message, Message],
  allToolResults: ToolResult[],
  input: RunInput,
  accumulatedUsage: TokenUsage,
  accumulatedText: string,
  pendingToolCalls: ToolCall[],
): Promise<{
  result: StreamingGenerationRoundResult;
  accumulatedUsage: TokenUsage;
  accumulatedText: string;
  pendingToolCalls: ToolCall[];
  toolAttempt: number;
}> {
  stateMachine.transition('GENERATING');
  logger.debug('State transition: GENERATING', { runId });

  await runHooks(hooks.beforeGenerate, { messages, input, runId });

  eventBus.emit({
    type: 'generate.started',
    runId,
    messageCount: messages.length,
  });

  const promptRequest = buildPromptRequest(messages, config, input.signal);

  // D-M3-1: Full retry loop for streaming pre-stream errors
  let attempt = 0;
  let streamIterable: AsyncIterable<StreamChunk> | undefined;

  while (true) {
    try {
      // Validated at run() entry: provider.generateStream exists when stream === true
      if (activeProvider.capabilities.streaming === false) {
        throw new ConfigValidationError(['provider does not support streaming']);
      }
      if (!activeProvider.generateStream) {
        throw new ConfigValidationError(['provider does not implement generateStream']);
      }
      streamIterable = await activeProvider.generateStream(promptRequest);
      break; // Success - exit retry loop
    } catch (error: unknown) {
      const err: OrchestratorErrorClass = handleOrchestratorError(error, config);

      // Non-retryable errors exit immediately
      if (!isRetryable(err)) {
        return {
          result: { action: 'error', error: err, chunksToYield: [] },
          accumulatedUsage,
          accumulatedText,
          pendingToolCalls,
          toolAttempt,
        };
      }

      attempt++;

      // Check if max attempts reached
      if (attempt >= config.retry.maxAttempts) {
        const maxRetriesErr = new MaxRetriesExceededError(attempt, err);
        return {
          result: { action: 'error', error: maxRetriesErr, chunksToYield: [] },
          accumulatedUsage,
          accumulatedText,
          pendingToolCalls,
          toolAttempt,
        };
      }

      stateMachine.transition('RETRYING');
      const delayMs = calculateDelay(attempt, config.retry, err);
      logger.warn('Retrying', { runId, attempt, reason: err.code, delayMs });
      eventBus.emit({ type: 'retry.attempted', runId, attempt, reason: err.code, delayMs });
      await abortRunCall({ delayMs, ...(input.signal ? { signal: input.signal } : {}) });
      stateMachine.transition('GENERATING');
    }
  }

  // D-M3-2: Stream consumption with per-chunk idle timeout
  // Collect all chunks into arrays instead of yielding directly.
  const chunksToYield: StreamChunk[] = [];

  for await (const chunk of asyncIteratorWithIdleTimeout(
    streamIterable,
    config.timeout.generateTimeoutMs,
    input.signal,
  )) {
    switch (chunk.type) {
      case 'text':
        accumulatedText += chunk.delta;
        chunksToYield.push(chunk);
        break;

      case 'tool_call':
        pendingToolCalls.push(chunk.toolCall);
        chunksToYield.push(chunk);
        break;

      case 'done':
        // Accumulate usage but do NOT yield — the provider's 'done' is an internal
        // "generation round ended" signal. The pipeline yields its own 'done' chunk
        // after finalizePipeline completes.
        if (chunk.usage) {
          accumulatedUsage.prompt = chunk.usage.prompt;
          accumulatedUsage.completion = chunk.usage.completion;
          accumulatedUsage.total = chunk.usage.total;
        }
        break;

      case 'error':
        chunksToYield.push(chunk);
        break;

      default:
        chunksToYield.push(chunk);
    }
  }

  // After done or error: construct PromptResponse for hooks
  const response: PromptResponse = {
    text: accumulatedText,
    toolCalls: pendingToolCalls,
    usage: accumulatedUsage,
    finishReason: pendingToolCalls.length > 0 ? 'tool_calls' : 'stop',
  };

  const finishReason = response.finishReason;

  eventBus.emit({
    type: 'generate.completed',
    runId,
    durationMs: trackDuration(),
    finishReason,
  });

  tempMessages[1] = {
    role: 'assistant',
    content: accumulatedText,
    ...(pendingToolCalls.length > 0 ? { toolCalls: pendingToolCalls } : null),
  };

  // Tool execution
  if (finishReason === 'tool_calls' && pendingToolCalls.length > 0) {
    // Use roundCounter + 1 for 1-indexed check and event round numbers
    // (stream consumption happens before this check, so we must use 1-indexed
    // comparison against maxToolRounds to limit the exact number of streams consumed)
    const nextRound = roundCounter + 1;
    if (nextRound >= config.toolPolicy.maxToolRounds) {
      const err = new MaxToolRoundsExceededError(nextRound, config.toolPolicy.maxToolRounds);
      return {
        result: { action: 'error', error: err, chunksToYield },
        accumulatedUsage,
        accumulatedText,
        pendingToolCalls,
        toolAttempt,
      };
    }

    stateMachine.transition('TOOL_EXECUTING');
    logger.debug('State transition: TOOL_EXECUTING', { runId, round: nextRound });

    try {
      const toolResults = await executeToolRound(
        nextRound,
        pendingToolCalls,
        config,
        hooks,
        eventBus,
        logger,
        runId,
        trackDuration,
        messages,
        allToolResults,
        input,
      );

      // Collect tool_result chunks
      for (const result of toolResults) {
        chunksToYield.push({ type: 'tool_result', toolResult: result });
      }
    } catch (error: unknown) {
      const err =
        error instanceof OrchestratorErrorClass ? error : new ToolExecutionError('unknown', error);

      // ToolValidationError, ToolNotFoundError -> return error (fail-fast)
      if (err instanceof ToolValidationError || err instanceof ToolNotFoundError) {
        return {
          result: { action: 'error', error: err, chunksToYield },
          accumulatedUsage,
          accumulatedText,
          pendingToolCalls,
          toolAttempt,
        };
      }

      // ToolExecutionError -> emit failed event and retry
      const toolCallName = err instanceof ToolExecutionError ? err.toolName : 'unknown';

      eventBus.emit({
        type: 'tool.failed',
        runId,
        toolName: toolCallName,
        error: toEventErrorPayload(err),
      });

      // Backoff before retry — use toolAttempt for exponential backoff
      const delayMs = calculateDelay(toolAttempt, config.retry, err);
      await abortRunCall({ delayMs, ...(input.signal ? { signal: input.signal } : {}) });

      // Reset streaming state for retry
      return {
        result: { action: 'continue', chunksToYield },
        accumulatedUsage,
        accumulatedText,
        pendingToolCalls: [],
        toolAttempt: toolAttempt + 1,
      };
    }

    // Tool execution succeeded - reset streaming state for next round
    return {
      result: { action: 'continue', chunksToYield },
      accumulatedUsage,
      accumulatedText,
      pendingToolCalls: [],
      toolAttempt,
    };
  }

  // No tool calls or finishReason is 'stop' | 'length'
  return {
    result: { action: 'break', response, finalChunks: chunksToYield },
    accumulatedUsage,
    accumulatedText,
    pendingToolCalls,
    toolAttempt,
  };
}

/**
 * Streaming pipeline - async generator that yields StreamChunk.
 *
 * @param input - Run input parameters
 * @param config - Resolved configuration (after profile merge)
 * @param eventBus - Event bus for emitting events
 * @param logger - Logger instance
 * @yields StreamChunk to consumer
 */
async function* executeStreamingPipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
): AsyncGenerator<StreamChunk> {
  // Streaming-specific state
  let accumulatedUsage = { prompt: 0, completion: 0, total: 0 };
  const allToolResults: ToolResult[] = [];
  let accumulatedText = '';
  let pendingToolCalls: ToolCall[] = [];
  let roundCounter = 0;
  let toolAttempt = 0;
  // Variables hoisted for catch block access
  let runId = '';
  let stateMachine = new LifecycleStateMachine();
  let response: PromptResponse;

  try {
    const timing = new TimingCollector();

    // ── Steps 1–4 — initializePipeline ──────────────────
    const init = await initializePipeline(input, config, eventBus, logger, timing);
    runId = init.runId;
    stateMachine = init.stateMachine;
    const {
      startTime,
      trackDuration,
      hooks,
      activeProfile,
      activeProvider,
      messages,
      tempMessages,
    } = init;

    // ── Step 5 — GENERATING (Streaming) ─────────────────────
    // Timing: mark generation and tool execution start once before the round loop
    timing.mark('generation_start');
    timing.mark('tool_execution_start');

    while (true) {
      await abortRunCall(input.signal ? { signal: input.signal } : {});

      const roundResult = await executeStreamingGenerationRound(
        roundCounter,
        toolAttempt,
        activeProvider,
        config,
        hooks,
        eventBus,
        logger,
        runId,
        stateMachine,
        trackDuration,
        messages,
        tempMessages,
        allToolResults,
        input,
        accumulatedUsage,
        accumulatedText,
        pendingToolCalls,
      );

      // Update mutable state from return
      accumulatedUsage = roundResult.accumulatedUsage;
      accumulatedText = roundResult.accumulatedText;
      pendingToolCalls = roundResult.pendingToolCalls;
      toolAttempt = roundResult.toolAttempt;

      const { result } = roundResult;

      if (result.action === 'continue') {
        for (const chunk of result.chunksToYield) {
          yield chunk;
        }
        roundCounter++;
        continue;
      }

      if (result.action === 'error') {
        for (const chunk of result.chunksToYield) {
          yield chunk;
        }
        yield { type: 'error', error: result.error };
        try {
          stateMachine.transition('FAILED');
        } catch {
          // Already in terminal state
        }
        eventBus.emit({ type: 'run.failed', runId, error: result.error });
        logger.error('Run failed', { runId, error: result.error.message, code: result.error.code });
        return;
      }

      // break
      for (const chunk of result.finalChunks) {
        yield chunk;
      }
      response = result.response;
      break;
    }

    // Run afterGenerate hooks (after tool loop completes, before finalization)
    try {
      await runHooks(hooks.afterGenerate, { messages, response, input, runId });
    } catch (hookError: unknown) {
      const err = handleOrchestratorError(hookError, config);
      yield { type: 'error', error: err };
      try {
        stateMachine.transition('FAILED');
      } catch {
        // Already in terminal state
      }
      eventBus.emit({ type: 'run.failed', runId, error: err });
      logger.error('Run failed', { runId, error: err.message, code: err.code });
      return;
    }

    // ── Steps 9–10 — COMPLETING → COMPLETED ────────────
    const output = await finalizePipeline(
      stateMachine,
      hooks,
      eventBus,
      logger,
      runId,
      startTime,
      tempMessages,
      accumulatedUsage,
      input,
      allToolResults,
      activeProfile,
      config.memoryAdapter,
      accumulatedText,
      timing,
    );

    yield { type: 'done', usage: output.usage };
  } catch (error: unknown) {
    const err: OrchestratorErrorClass = handleOrchestratorError(error, config);

    yield { type: 'error', error: err };

    try {
      stateMachine.transition('FAILED');
    } catch {
      // Already in terminal state
    }

    eventBus.emit({
      type: 'run.failed',
      runId,
      error: err,
    });

    logger.error('Run failed', {
      runId,
      error: err.message,
      code: err.code,
    });
  }
}

/**
 * Execute the orchestration pipeline.
 *
 * @param input - Run input parameters
 * @param config - Resolved configuration (after profile merge)
 * @param eventBus - Event bus for emitting events
 * @param logger - Logger instance
 * @returns RunOutput or AsyncIterable<StreamChunk>
 */
export async function executePipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
): Promise<RunOutput | AsyncIterable<StreamChunk>> {
  // Route to streaming pipeline if stream === true
  if (input.stream === true) {
    return executeStreamingPipeline(input, config, eventBus, logger);
  }

  // Non-streaming path - delegate to executeNonStreamingPipeline with top-level timeout
  try {
    return await withTimeout(
      executeNonStreamingPipeline(input, config, eventBus, logger),
      config.timeout.totalTimeoutMs,
    );
  } catch (error) {
    // Handle timeout from the race - rethrow TimeoutExceededError
    if (error instanceof TimeoutExceededError) {
      throw error;
    }
    throw error;
  }
}
