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
} from './interfaces.js';
import type { ResolvedConfig } from './types.js';
import type { OrchestratorError } from './errors.js';
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
  OrchestratorError as OrchestratorErrorClass,
} from './errors.js';

// Import EventErrorPayload type
import type { EventErrorPayload } from './interfaces.js';

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
  // ── Step 1 — INITIALIZED ───────────────────────────────────────────
  // eslint-disable-next-line no-undef -- crypto is a global in Node.js 24+
  const runId = crypto.randomUUID();
  let roundCounter = 0;
  const tempMessages: [Message, Message] = [
    { role: 'user', content: input.prompt },
    { role: 'assistant', content: '' },
  ];
  const stateMachine = new LifecycleStateMachine();
  const startTime = Date.now();

  // Determine active profile name (empty string if not provided)
  const activeProfile = input.profile ?? '';

  // Emit run.started
  const startedEvent: { type: 'run.started'; runId: string; timestamp: number } & {
    profile?: string;
  } = {
    type: 'run.started',
    runId,
    timestamp: startTime,
  };
  if (activeProfile) {
    startedEvent.profile = activeProfile;
  }
  eventBus.emit(startedEvent);

  logger.info('Run started', { runId, profile: activeProfile, sessionId: input.sessionId });

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

      // Calculate total hook count (base + profile)
      const baseHooks = normalizeHookRegistry(config.hooks);
      let hookCount = 0;
      hookCount += baseHooks.beforeRun.length;
      hookCount += baseHooks.afterRun.length;
      hookCount += baseHooks.beforeGenerate.length;
      hookCount += baseHooks.afterGenerate.length;
      hookCount += baseHooks.beforeTool.length;
      hookCount += baseHooks.afterTool.length;

      if (originalProfile.hooks) {
        const profileHooks = normalizeHookRegistry(originalProfile.hooks);
        hookCount += profileHooks.beforeRun.length;
        hookCount += profileHooks.afterRun.length;
        hookCount += profileHooks.beforeGenerate.length;
        hookCount += profileHooks.afterGenerate.length;
        hookCount += profileHooks.beforeTool.length;
        hookCount += profileHooks.afterTool.length;
      }

      eventBus.emit({
        type: 'profile.resolved',
        runId,
        profileName: input.profile,
        overrides,
        hookCount,
      });
    }
  }

  // Helper to track duration
  const trackDuration = (): number => Date.now() - startTime;

  // Normalize hooks once
  const hooks = normalizeHookRegistry(config.hooks);

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
    // ── Step 1b — beforeRun hooks ────────────────────────────────
    // Run beforeRun hooks once at the start of execution
    await runHooks(hooks.beforeRun, { input, runId });

    // ── Step 2 — CONTEXT_INJECTING ────────────────────────────────
    let attempt = 0;
    let activeProvider = config.provider;
    let contextMessages: SystemMessage[];

    // Loop for retry/backoff logic
    while (true) {
      try {
        // CONTEXT_INJECTING phase
        stateMachine.transition('CONTEXT_INJECTING');
        logger.debug('State transition: CONTEXT_INJECTING', { runId });

        // Build context provider input
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
              error instanceof OrchestratorErrorClass
                ? error
                : new ContextLoadError(provider.id, error);
            eventBus.emit({
              type: 'context.failed',
              runId,
              providerId: provider.id,
              error: toEventErrorPayload(err),
            });

            // Context errors use fail-fast strategy: context loading failures are treated as fatal
            // because the context is typically essential for the run to succeed.
            // This is an intentional design decision — retrying a failed context provider
            // is unlikely to succeed without external intervention.
            throw err;
          }
        }
        contextMessages = providerResults;

        // Use contextMessages in Step 4 (suppress unused warning for this block)
        void contextMessages;

        // ── Step 3 — CONTEXT_INJECTED + Memory Load ────────────────
        stateMachine.transition('CONTEXT_INJECTED');
        logger.debug('State transition: CONTEXT_INJECTED', { runId });

        // Load memory if sessionId provided
        const memoryMessages =
          input.sessionId && config.memoryAdapter
            ? await config.memoryAdapter.load(input.sessionId)
            : [];

        // Set user message - always role: 'user'
        tempMessages[0] = { role: 'user', content: input.prompt };

        // ── Step 4 — PROMPT_COMPOSED ───────────────────────────────
        stateMachine.transition('PROMPT_COMPOSED');
        logger.debug('State transition: PROMPT_COMPOSED', { runId });

        const promptComposer = new PromptComposer();

        // Calculate memory token budget based on provider's max context tokens.
        // Reserve tokens for: system prompt, context messages, current user prompt,
        // plus a buffer for completion tokens and overhead (~2000 tokens).
        const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
        const systemPromptTokens = config.systemPrompt ? estimateTokens(config.systemPrompt) : 0;
        const contextTokens = contextMessages.reduce(
          (sum, msg) => sum + estimateTokens(typeof msg.content === 'string' ? msg.content : ''),
          0,
        );
        const userPromptTokens = estimateTokens(input.prompt);
        const reserveTokens = 2000; // Buffer for completion + overhead
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
          contextMessages,
          memoryMessages,
          userPrompt: input.prompt,
          ...(memoryBudget > 0 ? { maxTokens: memoryBudget } : null),
        };
        if (config.systemPrompt) {
          composeParams.systemPrompt = config.systemPrompt;
        }

        const messages = promptComposer.compose(composeParams);

        // ── Step 5 — GENERATING (+ retry loop) ─────────────────
        let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
        let response: PromptResponse;
        const allToolResults: ToolResult[] = [];

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

          // Run afterGenerate hooks with explicit error handling
          try {
            await runHooks(hooks.afterGenerate, { messages, response, input, runId });
          } catch (hookError: unknown) {
            // Re-throw hook errors to ensure they propagate, preserving the original error
            if (hookError instanceof Error) {
              throw hookError;
            }
            const err = new Error(String(hookError));
            if (hookError !== null && typeof hookError === 'object') {
              Object.defineProperty(err, 'cause', {
                value: hookError,
                enumerable: false,
              });
            }
            throw err;
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
            const toolController = new ToolController(config.tools, config.toolPolicy, logger);

            try {
              // Run beforeTool hooks for each tool call
              for (const toolCall of response.toolCalls) {
                await runHooks(hooks.beforeTool, { toolCall, input, runId });
              }

              const toolResults = await toolController.executeRound(response.toolCalls);
              allToolResults.push(...toolResults);

              // Append tool results to messages
              for (const result of toolResults) {
                const toolCall = response.toolCalls?.find((tc) => tc.id === result.id);
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
                const toolCall = response.toolCalls?.find((tc) => tc.id === result.id);
                if (toolCall) {
                  eventBus.emit({
                    type: 'tool.called',
                    runId,
                    toolName: toolCall.name,
                    round: roundCounter,
                  });

                  eventBus.emit({
                    type: 'tool.completed',
                    runId,
                    toolName: toolCall.name,
                    durationMs: trackDuration(),
                  });
                }
              }
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
          }

          // No tool calls or finishReason is 'stop' | 'length'
          break;
        }

        // ── Step 9 — COMPLETING ────────────────────────────────
        stateMachine.transition('COMPLETING');
        logger.debug('State transition: COMPLETING', { runId });

        // Save to memory if sessionId present
        if (input.sessionId && config.memoryAdapter) {
          try {
            await config.memoryAdapter.save(input.sessionId, [tempMessages[0], tempMessages[1]]);
          } catch (error: unknown) {
            // D-M2-1/A: Memory save failure -> FAILED (no retry check)
            throw new ContextLoadError('memory', error);
          }
        }

        // Build output
        const output: RunOutput = {
          runId,
          text: response?.text ?? '',
          toolResults: allToolResults,
          usage: response?.usage ?? { prompt: 0, completion: 0, total: 0 },
          durationMs: trackDuration(),
          ...(activeProfile ? { profile: activeProfile } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };

        // Run afterRun hooks
        await runHooks(hooks.afterRun, { input, runId, output });

        // ── Step 10 — COMPLETED (terminal) ─────────────────────
        stateMachine.transition('COMPLETED');

        eventBus.emit({
          type: 'run.completed',
          runId,
          durationMs: trackDuration(),
          usage: output.usage,
        });

        logger.info('Run completed', {
          runId,
          durationMs: trackDuration(),
          totalTokens: output.usage.total,
        });

        return output;
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
  // eslint-disable-next-line no-undef -- crypto is a global in Node.js 24+
  const runId = crypto.randomUUID();
  const startTime = Date.now();
  const accumulatedUsage = { prompt: 0, completion: 0, total: 0 };
  const allToolResults: ToolResult[] = [];
  let accumulatedText = '';
  let pendingToolCalls: ToolCall[] = [];
  let roundCounter = 0;
  const activeProfile = input.profile ?? '';

  eventBus.emit({
    type: 'run.started',
    runId,
    timestamp: startTime,
    ...(activeProfile ? { profile: activeProfile } : {}),
  });

  logger.info('Run started', { runId, profile: activeProfile, sessionId: input.sessionId });

  if (input.profile) {
    const profiles = config.originalConfig?.profiles;
    const originalProfile = profiles?.[input.profile];
    if (profiles && originalProfile) {
      const overrides = {
        provider: originalProfile.provider !== undefined,
        tools: originalProfile.tools !== undefined,
        contextProviders: originalProfile.contextProviders !== undefined,
        systemPrompt: originalProfile.systemPrompt !== undefined,
        retry: originalProfile.retry !== undefined,
        toolPolicy: originalProfile.toolPolicy !== undefined,
      };

      const baseHooks = normalizeHookRegistry(config.hooks);
      let hookCount = 0;
      hookCount += baseHooks.beforeRun.length;
      hookCount += baseHooks.afterRun.length;
      hookCount += baseHooks.beforeGenerate.length;
      hookCount += baseHooks.afterGenerate.length;
      hookCount += baseHooks.beforeTool.length;
      hookCount += baseHooks.afterTool.length;

      if (originalProfile.hooks) {
        const profileHooks = normalizeHookRegistry(originalProfile.hooks);
        hookCount += profileHooks.beforeRun.length;
        hookCount += profileHooks.afterRun.length;
        hookCount += profileHooks.beforeGenerate.length;
        hookCount += profileHooks.afterGenerate.length;
        hookCount += profileHooks.beforeTool.length;
        hookCount += profileHooks.afterTool.length;
      }

      eventBus.emit({
        type: 'profile.resolved',
        runId,
        profileName: input.profile,
        overrides,
        hookCount,
      });
    }
  }

  const stateMachine = new LifecycleStateMachine();
  const hooks = normalizeHookRegistry(config.hooks);

  function trackDuration(): number {
    return Date.now() - startTime;
  }

  try {
    await runHooks(hooks.beforeRun, { input, runId });

    stateMachine.transition('CONTEXT_INJECTING');
    logger.debug('State transition: CONTEXT_INJECTING', { runId });

    const contextProviderInput: ContextProviderInput = {
      prompt: input.prompt,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    const contextMessages: SystemMessage[] = [];
    for (const provider of config.contextProviders) {
      try {
        const messages = await provider.provide(contextProviderInput);
        contextMessages.push(...messages);
        eventBus.emit({
          type: 'context.loaded',
          runId,
          providerId: provider.id,
          messageCount: messages.length,
        });
      } catch (error: unknown) {
        const err =
          error instanceof OrchestratorErrorClass
            ? error
            : new ContextLoadError(provider.id, error);
        eventBus.emit({
          type: 'context.failed',
          runId,
          providerId: provider.id,
          error: toEventErrorPayload(err),
        });
        throw err;
      }
    }

    stateMachine.transition('CONTEXT_INJECTED');
    logger.debug('State transition: CONTEXT_INJECTED', { runId });

    const memoryMessages =
      input.sessionId && config.memoryAdapter
        ? await config.memoryAdapter.load(input.sessionId)
        : [];

    const tempMessages: [Message, Message] = [
      { role: 'user', content: input.prompt },
      { role: 'assistant', content: '' },
    ];

    stateMachine.transition('PROMPT_COMPOSED');
    logger.debug('State transition: PROMPT_COMPOSED', { runId });

    const promptComposer = new PromptComposer();
    const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
    const systemPromptTokens = config.systemPrompt ? estimateTokens(config.systemPrompt) : 0;
    const contextTokens = contextMessages.reduce(
      (sum, msg) => sum + estimateTokens(typeof msg.content === 'string' ? msg.content : ''),
      0,
    );
    const userPromptTokens = estimateTokens(input.prompt);
    const reserveTokens = 2000;
    const memoryBudget =
      config.provider.capabilities.maxContextTokens -
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
      contextMessages,
      memoryMessages,
      userPrompt: input.prompt,
      ...(memoryBudget > 0 ? { maxTokens: memoryBudget } : null),
    };
    if (config.systemPrompt) {
      composeParams.systemPrompt = config.systemPrompt;
    }

    const messages = promptComposer.compose(composeParams);
    const activeProvider = config.provider;

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
            logger.error('Run failed', { runId, error: maxRetriesErr.message, code: maxRetriesErr.code });
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
            if (chunk.usage) {
              accumulatedUsage.prompt = chunk.usage.prompt;
              accumulatedUsage.completion = chunk.usage.completion;
              accumulatedUsage.total = chunk.usage.total;
            }
            yield chunk;
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
      const response: PromptResponse = {
        text: accumulatedText,
        toolCalls: pendingToolCalls,
        usage: accumulatedUsage,
        finishReason: pendingToolCalls.length > 0 ? 'tool_calls' : 'stop',
      };

      await runHooks(hooks.afterGenerate, { messages, response, input, runId });

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

        const toolController = new ToolController(config.tools, config.toolPolicy, logger);

        for (const toolCall of pendingToolCalls) {
          await runHooks(hooks.beforeTool, { toolCall, input, runId });
        }

        const toolResults = await toolController.executeRound(pendingToolCalls);
        allToolResults.push(...toolResults);

        for (const result of toolResults) {
          yield { type: 'tool_result', toolResult: result };

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

          const toolCall = pendingToolCalls.find((tc) => tc.id === result.id);
          if (toolCall) {
            await runHooks(hooks.afterTool, { toolCall, input, runId, toolResult: result });

            eventBus.emit({
              type: 'tool.called',
              runId,
              toolName: toolCall.name,
              round: roundCounter,
            });

            eventBus.emit({
              type: 'tool.completed',
              runId,
              toolName: toolCall.name,
              durationMs: trackDuration(),
            });
          }
        }

        pendingToolCalls = [];
        accumulatedText = '';
        continue;
      }

      break;
    }

    // ── COMPLETING ───────────────────────────────────────────────
    stateMachine.transition('COMPLETING');
    logger.debug('State transition: COMPLETING', { runId });

    if (input.sessionId && config.memoryAdapter) {
      try {
        await config.memoryAdapter.save(input.sessionId, [tempMessages[0], tempMessages[1]]);
      } catch (error: unknown) {
        const err = new ContextLoadError('memory', error);
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
    }

    const output: RunOutput = {
      runId,
      text: typeof tempMessages[1].content === 'string' ? tempMessages[1].content : '',
      toolResults: allToolResults,
      usage: accumulatedUsage,
      durationMs: trackDuration(),
      ...(activeProfile ? { profile: activeProfile } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    await runHooks(hooks.afterRun, { input, runId, output });

    // ── COMPLETED ───────────────────────────────────────────
    stateMachine.transition('COMPLETED');

    yield { type: 'done', usage: accumulatedUsage };

    eventBus.emit({
      type: 'run.completed',
      runId,
      durationMs: trackDuration(),
      usage: accumulatedUsage,
    });

    logger.info('Run completed', {
      runId,
      durationMs: trackDuration(),
      totalTokens: accumulatedUsage.total,
    });
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

function handleOrchestratorError(error: unknown, config: ResolvedConfig): OrchestratorError {
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
    // All thrown Errors (including hook errors) should propagate as-is
    // Don't convert to TimeoutExceededError
    err = error as OrchestratorErrorClass;
  } else {
    // Unknown non-Error - wrap it
    err = new TimeoutExceededError(config.timeout.totalTimeoutMs);
  }
  return err;
}
