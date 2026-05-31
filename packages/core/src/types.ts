// Internal types for M1 — expanded in M2 as needed
// No exports — Layer 0 internal file

import type { AIProvider, ContextProvider, MemoryAdapter, Tool, ToolDefinition } from './interfaces.js';
import type {
  RetryPolicy,
  TimeoutPolicy,
  ToolPolicy,
  HookRegistry,
  Logger,
  OrchestratorConfig,
} from './interfaces.js';

/**
 * Internal type — post-profile-merge config passed to pipeline.ts.
 * Not exported. Adapter authors never see this type.
 *
 * Built from OrchestratorConfig + profile resolution.
 * All fields are non-optional with defaults applied.
 * Except for `originalConfig`, which is only used for the profile.resolved event and is stripped out before being passed to pipeline.ts.
 */
export interface ResolvedConfig {
  provider: AIProvider;
  fallbackProvider?: AIProvider;
  systemPrompt?: string;
  tools: Map<string, Tool>;
  /** Pre-computed ToolDefinition[] for PromptRequest.tools.
   *  Computed once during profile resolution to avoid repeated
   *  Array.from().map() in the generation loop.
   *  Undefined when config.tools is empty. */
  toolDefinitions?: ToolDefinition[];
  contextProviders: ContextProvider[];
  memoryAdapter?: MemoryAdapter;
  retry: RetryPolicy;
  timeout: TimeoutPolicy;
  toolPolicy: ToolPolicy;
  hooks: HookRegistry;
  logger: Logger;
  /** Original config before profile resolution - needed for profile.resolved event */
  originalConfig?: OrchestratorConfig;
}
