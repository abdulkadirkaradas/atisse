/**
 * Orchestrator — Layer 4 (Public Surface)
 *
 * The main entry point for users of the @atisse/core library.
 * Provides orchestration of the complete LLM interaction lifecycle.
 */

import './types.js';

import type {
  OrchestratorConfig,
  RunInput,
  RunOutput,
  StreamChunk,
  OrchestratorEvent,
  Logger,
  Tool,
  AIProvider,
} from './interfaces.js';
import { ConfigValidationError } from './errors.js';
import { createEventBus } from './events.js';
import { executePipeline } from './pipeline.js';
import { resolveConfig } from './profile.js';

/**
 * No-op logger used when no logger is provided.
 */
function noOpLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * Main Orchestrator class for LLM interactions.
 *
 * @example
 * const orchestrator = new Orchestrator({ provider });
 * const result = await orchestrator.run({ prompt: 'Hello' });
 */
export class Orchestrator {
  private readonly tools: Map<string, Tool>;
  private readonly eventBus: ReturnType<typeof createEventBus>;
  private readonly logger: Logger;

  /**
   * Creates a new Orchestrator instance.
   *
   * @param config - Orchestrator configuration
   * @throws ConfigValidationError if configuration is invalid
   */
  constructor(config: OrchestratorConfig) {
    // ── Constructor Eager Validation ────────────────────────────────
    const validationErrors: string[] = [];

    // Validate provider is present
    if (!config.provider) {
      validationErrors.push('provider is required');
    }

    // Validate profiles[key].name === key
    if (config.profiles) {
      for (const [key, profile] of Object.entries(config.profiles)) {
        if (profile.name !== key) {
          validationErrors.push(`profile name mismatch: key '${key}' has name '${profile.name}'`);
        }
      }
    }

    // Validate allowParallelTools is false (v1 constraint)
    if (config.toolPolicy?.allowParallelTools === true) {
      validationErrors.push('allowParallelTools: true is forbidden in v1');
    }

    // Validate maxToolRounds >= 1
    if (config.toolPolicy?.maxToolRounds !== undefined && config.toolPolicy.maxToolRounds < 1) {
      validationErrors.push('maxToolRounds must be at least 1');
    }

    // Validate timeout values (must be > 0 and not Infinity)
    if (config.timeout) {
      if (config.timeout.generateTimeoutMs !== undefined) {
        if (config.timeout.generateTimeoutMs <= 0 || !isFinite(config.timeout.generateTimeoutMs)) {
          validationErrors.push('generateTimeoutMs must be > 0 and not Infinity');
        }
      }
      if (config.timeout.toolTimeoutMs !== undefined) {
        if (config.timeout.toolTimeoutMs <= 0 || !isFinite(config.timeout.toolTimeoutMs)) {
          validationErrors.push('toolTimeoutMs must be > 0 and not Infinity');
        }
      }
      if (config.timeout.totalTimeoutMs !== undefined) {
        if (config.timeout.totalTimeoutMs <= 0 || !isFinite(config.timeout.totalTimeoutMs)) {
          validationErrors.push('totalTimeoutMs must be > 0 and not Infinity');
        }
      }
    }

    // Validate no duplicate tool names
    if (config.tools && config.tools.length > 0) {
      const toolNames = new Set<string>();
      for (const tool of config.tools) {
        if (toolNames.has(tool.name)) {
          validationErrors.push(`duplicate tool name: ${tool.name}`);
        }
        toolNames.add(tool.name);
      }
    }

    // Validate no empty inputSchema (empty {} is FORBIDDEN per contract)
    if (config.tools) {
      for (const tool of config.tools) {
        if (
          tool.inputSchema &&
          typeof tool.inputSchema === 'object' &&
          Object.keys(tool.inputSchema).length === 0
        ) {
          validationErrors.push(`tool '${tool.name}' has empty inputSchema ({})`);
        }
      }
    }

    // Throw if any validation errors
    if (validationErrors.length > 0) {
      throw new ConfigValidationError(validationErrors);
    }

    // ── Initialize Instance ────────────────────────────────────────────────
    this.config = config;
    this.tools = new Map(config.tools?.map((t) => [t.name, t]) ?? []);
    this.eventBus = createEventBus();
    this.logger = config.logger ?? noOpLogger();
  }

  /**
   * Run the orchestrator with the given input.
   * @param input - Run input parameters
   * @returns RunOutput result or AsyncIterable<StreamChunk> for streaming
   */
  run(input: RunInput & { stream?: false }): Promise<RunOutput>;
  run(input: RunInput & { stream: true }): Promise<AsyncIterable<StreamChunk>>;
  run(input: RunInput): Promise<RunOutput> | Promise<AsyncIterable<StreamChunk>>;

  /**
   * Internal implementation of run().
   */
  async run(input: RunInput) {
    // ── Run Entry Validation ────────────────────────────────────────────────
    const validationErrors: string[] = [];

    // Validate stream + fallback combination (ADR-017)
    if (input.stream === true) {
      // Check fallbackProvider is not configured
      const baseHasFallback = this.config.fallbackProvider !== undefined;
      const profileHasFallback =
        input.profile && this.config.profiles?.[input.profile]?.fallbackProvider !== undefined;
      const hasFallback = baseHasFallback || profileHasFallback;
      if (hasFallback) {
        validationErrors.push('stream: true with fallbackProvider is forbidden in v1');
      }

      // Check provider streaming capabilities
      const provider = this.getProvider(input.profile);
      if (provider && provider.capabilities.streaming === false) {
        validationErrors.push('provider does not support streaming');
      }
      if (provider && !provider.generateStream) {
        validationErrors.push('provider does not implement generateStream');
      }
    }

    // Validate profile exists if specified
    if (input.profile) {
      if (!this.config.profiles || !this.config.profiles[input.profile]) {
        validationErrors.push(`profile not found: ${input.profile}`);
      }
    }

    if (validationErrors.length > 0) {
      throw new ConfigValidationError(validationErrors);
    }

    // ── Profile Resolution ────────────────────────────────────────────────
    const resolvedConfig = resolveConfig(this.config, input.profile, this.tools);

    // ── Delegation to Pipeline ──────────────────────────────────────────
    return executePipeline(input, resolvedConfig, this.eventBus, this.logger);
  }

  /**
   * Register an event listener.
   * @param type - Event type to listen for
   * @param listener - Event listener callback
   * @returns Unsubscribe function
   */
  on<T extends OrchestratorEvent['type']>(
    type: T,
    listener: (event: Extract<OrchestratorEvent, { type: T }>) => void,
  ): () => void {
    return this.eventBus.on(type, listener);
  }

  // ── Private Helper Accessors ────────────────────────────────────────────────

  private readonly config: OrchestratorConfig;

  private getProvider(profileName?: string): AIProvider | undefined {
    if (profileName && this.config.profiles?.[profileName]?.provider) {
      return this.config.profiles[profileName].provider;
    }
    return this.config.provider;
  }
}
