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
import { LifecycleStateMachine } from './lifecycle.js';
import { PromptComposer } from './prompt-composer.js';
import { ToolController } from './tool-controller.js';
import { runHooks, normalizeHookRegistry } from './hooks.js';
import { calculateDelay, rejectAfter, sleep, executeWithRetry } from './policies.js';
import {
  isRetryable,
  TimeoutExceededError,
  MaxToolRoundsExceededError,
  FallbackExhaustedError,
  ToolExecutionError,
  ToolValidationError,
  ToolNotFoundError,
  ContextLoadError,
  MaxRetriesExceededError,
  ConfigValidationError,
  TokenLimitExceededError,
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

  const promptComposer = new PromptComposer();

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

  const composeParams: {
    systemPrompt?: string;
    contextMessages: SystemMessage[];
    memoryMessages: Message[];
    userPrompt: string;
    maxTokens?: number;
  } = {
    contextMessages: providerResults,
    memoryMessages,
    userPrompt: input.prompt,
    ...(memoryBudget > 0 ? { maxTokens: memoryBudget } : null),
  };
  if (config.systemPrompt) {
    composeParams.systemPrompt = config.systemPrompt;
  }

  const messages = promptComposer.compose(composeParams);

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
): Promise<RunOutput> {
  // ── Step 9 — COMPLETING ──────────────────────────────────
  stateMachine.transition('COMPLETING');
  logger.debug('State transition: COMPLETING', { runId });

  // Save to memory if sessionId present
  if (input.sessionId && memoryAdapter) {
    try {
      await memoryAdapter.save(input.sessionId, [tempMessages[0], tempMessages[1]]);
    } catch (error: unknown) {
      // D-M2-1/A: Memory save failure -> FAILED (no retry check)
      throw new ContextLoadError('memory', error);
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
  });

  logger.info('Run completed', {
    runId,
    durationMs: Date.now() - startTime,
    totalTokens: output.usage.total,
  });

  return output;
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

  // Non-streaming path follows the original implementation
  // Helper to run the main execution with top-level timeout
  try {
    return await Promise.race([_execute(), rejectAfter(config.timeout.totalTimeoutMs)]);
  } catch (error) {
    // Handle timeout from the race - rethrow TimeoutExceededError
    if (error instanceof TimeoutExceededError) {
      throw error;
    }
    throw error;
  }

  // Internal async function containing all steps
  async function _execute(): Promise<RunOutput> {
    // Variables hoisted outside the try block so they are accessible in catch for FAILED handling.
    // initializePipeline returns these, but if it throws, we use the local stateMachine for FAILED transition.
    let runId = '';
    let stateMachine = new LifecycleStateMachine();
    let activeProvider: AIProvider = config.provider;
    let roundCounter = 0;
    let attempt = 0;

    // Loop for retry/backoff logic
    while (true) {
      try {
        // ── Steps 1–4 — initializePipeline ──────────────────
        const init = await initializePipeline(input, config, eventBus, logger);
        activeProvider = init.activeProvider;
        runId = init.runId;
        stateMachine = init.stateMachine;
        const { startTime, trackDuration, hooks, activeProfile, tempMessages } = init;
        const messages = init.messages;
        const allToolResults: ToolResult[] = [];

        let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
        let response: PromptResponse;

        // ── Step 5 — GENERATING (+ retry loop) ──────────────
        while (true) {
          stateMachine.transition('GENERATING');
          logger.debug('State transition: GENERATING', { runId });

          // Run beforeGenerate hooks
          await runHooks(hooks.beforeGenerate, { messages, input, runId });

          eventBus.emit({
            type: 'generate.started',
            runId,
            messageCount: messages.length,
          });

          // Build PromptRequest
          const promptTools =
            config.tools.size > 0
              ? Array.from(config.tools.values()).map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema,
                }))
              : undefined;

          const promptRequest: PromptRequest = {
            messages,
            ...(promptTools ? { tools: promptTools } : {}),
            ...(config.timeout.generateTimeoutMs > 0
              ? { signal: AbortSignal.timeout(config.timeout.generateTimeoutMs) }
              : null),
          };

          // Try to generate with retry
          try {
            response = await executeWithRetry(
              () => activeProvider.generate(promptRequest),
              config.retry,
              (retryAttempt, error) => {
                attempt = retryAttempt;
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
                  type: 'retry.attempt',
                  runId,
                  attempt: retryAttempt,
                  reason: error.code,
                  delayMs,
                });
              },
            );
          } catch (error: unknown) {
            const err =
              error instanceof OrchestratorErrorClass
                ? error
                : new TimeoutExceededError(config.timeout.generateTimeoutMs);

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

              // Switch to fallback provider
              activeProvider = config.fallbackProvider;

              // Try fallback once with no retry
              try {
                response = await activeProvider.generate(promptRequest);
              } catch (fallbackError: unknown) {
                const fallbackErr =
                  fallbackError instanceof OrchestratorErrorClass
                    ? fallbackError
                    : new TimeoutExceededError(config.timeout.generateTimeoutMs);
                throw new FallbackExhaustedError(err, fallbackErr);
              }

              break;
            }

            // Not retryable - throw to FAILED
            if (!isRetryable(err)) {
              throw err;
            }

            // Retryable without fallback - continue loop
            const delayMs = calculateDelay(attempt, config.retry, err);
            await sleep(delayMs);
            // Transition back to GENERATING for retry attempt
            stateMachine.transition('GENERATING');
            continue;
          }

          // Success - check finish reason
          finishReason = response.finishReason;

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
          if (
            finishReason === 'tool_calls' &&
            response.toolCalls &&
            response.toolCalls.length > 0
          ) {
            // ── Step 6 — TOOL_EXECUTING ───────────────────────
            roundCounter++;
            if (roundCounter >= config.toolPolicy.maxToolRounds) {
              throw new MaxToolRoundsExceededError(roundCounter, config.toolPolicy.maxToolRounds);
            }

            stateMachine.transition('TOOL_EXECUTING');
            logger.debug('State transition: TOOL_EXECUTING', { runId, round: roundCounter });

            // Execute tools with fail-fast
            try {
              await executeToolRound(
                roundCounter,
                response.toolCalls,
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
                error instanceof OrchestratorErrorClass
                  ? error
                  : new ToolExecutionError('unknown', error);

              // ToolValidationError, ToolNotFoundError -> FAILED (fail-fast)
              if (err instanceof ToolValidationError || err instanceof ToolNotFoundError) {
                throw err;
              }

              // ToolExecutionError -> emit failed event and retry
              const toolCallName = err instanceof ToolExecutionError ? err.toolName : 'unknown';

              eventBus.emit({
                type: 'tool.failed',
                runId,
                toolName: toolCallName,
                error: toEventErrorPayload(err),
              });

              // Retry
              const delayMs = calculateDelay(attempt, config.retry, err);
              await sleep(delayMs);
              continue;
            }
            continue;
          }

          // No tool calls or finishReason is 'stop' | 'length'
          break;
        }

        // Run afterGenerate hooks (after tool loop completes, before finalization)
        try {
          await runHooks(hooks.afterGenerate, { messages, response, input, runId });
        } catch (hookError: unknown) {
          const err = handleOrchestratorError(hookError, config);
          throw err;
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
  }
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
  const accumulatedUsage = { prompt: 0, completion: 0, total: 0 };
  const allToolResults: ToolResult[] = [];
  let accumulatedText = '';
  let pendingToolCalls: ToolCall[] = [];
  let roundCounter = 0;
  // Variables hoisted for catch block access
  let runId = '';
  let stateMachine = new LifecycleStateMachine();
  let response: PromptResponse;

  try {
    // ── Steps 1–4 — initializePipeline ──────────────────
    const init = await initializePipeline(input, config, eventBus, logger);
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
    while (true) {
      stateMachine.transition('GENERATING');
      logger.debug('State transition: GENERATING', { runId });

      await runHooks(hooks.beforeGenerate, { messages, input, runId });

      eventBus.emit({
        type: 'generate.started',
        runId,
        messageCount: messages.length,
      });

      const promptTools =
        config.tools.size > 0
          ? Array.from(config.tools.values()).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            }))
          : undefined;

      const promptRequest: PromptRequest = {
        messages,
        ...(promptTools ? { tools: promptTools } : {}),
        ...(config.timeout.generateTimeoutMs > 0
          ? { signal: AbortSignal.timeout(config.timeout.generateTimeoutMs) }
          : null),
      };

      // D-M3-1: Full retry loop with maxAttempts for streaming pre-stream errors
      // (generateStream Promise rejection — not mid-stream chunk errors)
      let attempt = 0;
      let streamIterable: AsyncIterable<StreamChunk> | undefined;

      while (true) {
        try {
          // Validated at run() entry: provider.generateStream exists when stream === true
          if (!activeProvider.generateStream) {
            throw new ConfigValidationError(['provider does not implement generateStream']);
          }
          streamIterable = await activeProvider.generateStream(promptRequest);
          break; // Success - exit retry loop
        } catch (error: unknown) {
          const err: OrchestratorErrorClass = handleOrchestratorError(error, config);

          // Non-retryable errors exit immediately
          if (!isRetryable(err)) {
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

          attempt++;

          // Check if max attempts reached
          if (attempt >= config.retry.maxAttempts) {
            const maxRetriesErr = new MaxRetriesExceededError(attempt, err);
            yield { type: 'error', error: maxRetriesErr };
            try {
              stateMachine.transition('FAILED');
            } catch {
              // Already in terminal state
            }
            eventBus.emit({ type: 'run.failed', runId, error: maxRetriesErr });
            logger.error('Run failed', {
              runId,
              error: maxRetriesErr.message,
              code: maxRetriesErr.code,
            });
            return;
          }

          stateMachine.transition('RETRYING');
          const delayMs = calculateDelay(attempt, config.retry, err);
          logger.warn('Retrying', { runId, attempt, reason: err.code, delayMs });
          eventBus.emit({ type: 'retry.attempt', runId, attempt, reason: err.code, delayMs });
          await sleep(delayMs);
          stateMachine.transition('GENERATING');
        }
      }

      // D-M3-2: Stream consumption with timeout fallback
      // Wrap stream consumption in Promise.race with generateTimeoutMs timeout
      let streamError: OrchestratorErrorClass | undefined;

      // Consume stream and collect chunks (can be interrupted by timeout)
      const chunks = await Promise.race([
        (async () => {
          const collected: StreamChunk[] = [];
          for await (const chunk of streamIterable) {
            collected.push(chunk);
            if (chunk.type === 'error') {
              streamError = chunk.error;
            }
          }
          return collected;
        })(),
        rejectAfter(config.timeout.generateTimeoutMs),
      ]);

      // Process collected chunks and yield to consumer
      for (const chunk of chunks) {
        switch (chunk.type) {
          case 'text':
            accumulatedText += chunk.delta;
            yield chunk;
            break;

          case 'tool_call':
            pendingToolCalls.push(chunk.toolCall);
            yield chunk;
            break;

          case 'done':
            // Accumulate usage but do NOT yield — the provider's 'done' is an internal
            // "generation round ended" signal. The pipeline yields its own 'done' chunk
            // at line 1053 after finalizePipeline completes.
            if (chunk.usage) {
              accumulatedUsage.prompt = chunk.usage.prompt;
              accumulatedUsage.completion = chunk.usage.completion;
              accumulatedUsage.total = chunk.usage.total;
            }
            break;

          case 'error':
            // streamError is already set above
            yield chunk;
            break;

          default:
            yield chunk;
        }
      }

      // Handle stream error (mid-stream error chunk)
      if (streamError) {
        try {
          stateMachine.transition('FAILED');
        } catch {
          // Already in terminal state
        }

        eventBus.emit({
          type: 'run.failed',
          runId,
          error: streamError,
        });

        logger.error('Run failed', {
          runId,
          error: streamError.message,
          code: streamError.code,
        });
        return;
      }

      // After done or error: construct PromptResponse for hooks
      response = {
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
        roundCounter++;
        if (roundCounter >= config.toolPolicy.maxToolRounds) {
          const err = new MaxToolRoundsExceededError(roundCounter, config.toolPolicy.maxToolRounds);
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
          return;
        }

        stateMachine.transition('TOOL_EXECUTING');
        logger.debug('State transition: TOOL_EXECUTING', { runId, round: roundCounter });

        // B-LOW-02 fix: add try/catch around tool execution in streaming path
        try {
          const toolResults = await executeToolRound(
            roundCounter,
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

          // Yield tool_result chunks to consumer
          for (const result of toolResults) {
            yield { type: 'tool_result', toolResult: result };
          }
        } catch (error: unknown) {
          const err =
            error instanceof OrchestratorErrorClass
              ? error
              : new ToolExecutionError('unknown', error);

          // ToolValidationError, ToolNotFoundError -> yield error and return (fail-fast)
          if (err instanceof ToolValidationError || err instanceof ToolNotFoundError) {
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

          // ToolExecutionError -> emit failed event and retry
          const toolCallName = err instanceof ToolExecutionError ? err.toolName : 'unknown';

          eventBus.emit({
            type: 'tool.failed',
            runId,
            toolName: toolCallName,
            error: toEventErrorPayload(err),
          });

          // Backoff before retry
          const delayMs = calculateDelay(attempt, config.retry, err);
          await sleep(delayMs);

          // Reset streaming state for retry
          pendingToolCalls = [];
          accumulatedText = '';
          continue;
        }

        pendingToolCalls = [];
        accumulatedText = '';
        continue;
      }

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
    // Wrap non-OrchestratorError instances to satisfy the StreamChunk error contract
    // TokenLimitExceededError structurally supports arbitrary messages with cause,
    // preserving original error info for consumer inspection via cause chain
    err = new TokenLimitExceededError(error.message, error);
  } else {
    // Unknown non-Error - wrap it
    err = new TimeoutExceededError(config.timeout.totalTimeoutMs);
  }
  return err;
}
