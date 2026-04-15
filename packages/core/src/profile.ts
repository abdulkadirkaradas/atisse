import type { OrchestratorConfig, HookRegistry, AIProvider, Tool, Logger } from './interfaces.js';
import type { ResolvedConfig } from './types.js';
import { ConfigValidationError } from './errors.js';
import {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  DEFAULT_TOOL_POLICY,
  mergeRetryPolicy,
  mergeTimeoutPolicy,
  mergeToolPolicy,
} from './policies.js';

/**
 * Normalizes a partial HookRegistry to a complete HookRegistry.
 * All missing arrays default to empty arrays.
 */
function normalizeHookRegistry(partial?: Partial<HookRegistry>): HookRegistry {
  return {
    beforeRun: partial?.beforeRun ?? [],
    afterRun: partial?.afterRun ?? [],
    beforeGenerate: partial?.beforeGenerate ?? [],
    afterGenerate: partial?.afterGenerate ?? [],
    beforeTool: partial?.beforeTool ?? [],
    afterTool: partial?.afterTool ?? [],
  };
}

/**
 * Merges two hook registries with concatenation.
 * Base hooks execute first, then profile hooks.
 */
function mergeHookRegistries(base: HookRegistry, profile?: Partial<HookRegistry>): HookRegistry {
  if (!profile) {
    return base;
  }

  const normalizedProfile = normalizeHookRegistry(profile);

  return {
    beforeRun: [...base.beforeRun, ...normalizedProfile.beforeRun],
    afterRun: [...base.afterRun, ...normalizedProfile.afterRun],
    beforeGenerate: [...base.beforeGenerate, ...normalizedProfile.beforeGenerate],
    afterGenerate: [...base.afterGenerate, ...normalizedProfile.afterGenerate],
    beforeTool: [...base.beforeTool, ...normalizedProfile.beforeTool],
    afterTool: [...base.afterTool, ...normalizedProfile.afterTool],
  };
}

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
 * Converts a tools array to a Map for efficient lookup.
 */
function toolsArrayToMap(tools?: Tool[]): Map<string, Tool> {
  if (!tools || tools.length === 0) {
    return new Map();
  }
  return new Map(tools.map((t) => [t.name, t]));
}

/**
 * Resolves the orchestrator configuration by applying profile overrides.
 *
 * @param base - The base orchestrator configuration
 * @param profileName - Optional profile name to apply
 * @param baseTools - Map of base tools from orchestrator
 * @returns Resolved configuration with all defaults applied
 * @throws ConfigValidationError if profileName is provided but not found in config.profiles
 */
export function resolveConfig(
  base: OrchestratorConfig,
  profileName: string | undefined,
  baseTools: Map<string, Tool>,
): ResolvedConfig {
  // Start with defaults (not base config - these come from DEFAULT_* constants)
  let provider = base.provider;
  let fallbackProvider: AIProvider | undefined = base.fallbackProvider;
  let systemPrompt = base.systemPrompt;
  let tools = baseTools;
  let contextProviders = base.contextProviders ?? [];
  const memoryAdapter = base.memoryAdapter;
  let retry = DEFAULT_RETRY;
  let timeout = DEFAULT_TIMEOUT;
  let toolPolicy = DEFAULT_TOOL_POLICY;
  let hooks = normalizeHookRegistry(base.hooks);
  const logger = base.logger ?? noOpLogger();

  // If a profile is specified, apply its overrides
  if (profileName !== undefined) {
    if (!base.profiles || !base.profiles[profileName]) {
      throw new ConfigValidationError([`Profile not found: ${profileName}`]);
    }

    const profile = base.profiles[profileName];

    // Profile value replaces base (??)
    if (profile.provider !== undefined) {
      provider = profile.provider;
    }
    if (profile.fallbackProvider !== undefined) {
      fallbackProvider = profile.fallbackProvider;
    }
    if (profile.systemPrompt !== undefined) {
      systemPrompt = profile.systemPrompt;
    }

    // Deep merge for retry/timeout/toolPolicy
    if (profile.retry !== undefined) {
      retry = mergeRetryPolicy(retry, profile.retry);
    }
    if (profile.timeout !== undefined) {
      timeout = mergeTimeoutPolicy(timeout, profile.timeout);
    }
    if (profile.toolPolicy !== undefined) {
      toolPolicy = mergeToolPolicy(toolPolicy, profile.toolPolicy);
    }

    // Full replace for tools and contextProviders (including [] replaces)
    if (profile.tools !== undefined) {
      tools = toolsArrayToMap(profile.tools);
    }
    if (profile.contextProviders !== undefined) {
      contextProviders = profile.contextProviders;
    }

    // Concatenate hooks - base first, profile second
    if (profile.hooks !== undefined) {
      hooks = mergeHookRegistries(hooks, profile.hooks);
    }
  } else {
    // No profile: apply base config partial overrides to defaults
    if (base.retry) {
      retry = mergeRetryPolicy(retry, base.retry);
    }
    if (base.timeout) {
      timeout = mergeTimeoutPolicy(timeout, base.timeout);
    }
    if (base.toolPolicy) {
      toolPolicy = mergeToolPolicy(toolPolicy, base.toolPolicy);
    }
    // contextProviders defaults to [] when not provided
    // tools remains baseTools when not provided
  }

  const resolvedConfig: ResolvedConfig = {
    provider,
    ...(fallbackProvider !== undefined && { fallbackProvider }),
    ...(systemPrompt !== undefined && { systemPrompt }),
    tools,
    contextProviders,
    ...(memoryAdapter !== undefined && { memoryAdapter }),
    retry,
    timeout,
    toolPolicy,
    hooks,
    logger,
    originalConfig: base,
  };

  return resolvedConfig;
}
