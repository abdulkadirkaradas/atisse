import type { LifecycleHook, HookRegistry } from './interfaces.js';

/**
 * Executes hooks serially, passing each hook's output as the next hook's input.
 * @param hooks - Array of lifecycle hooks to execute in order
 * @param context - Initial context passed to the first hook
 * @returns Final context after all hooks have executed
 * @throws Error if any hook returns null or undefined
 * @throws Propagates any error thrown by a hook
 */
export async function runHooks<T>(hooks: ReadonlyArray<LifecycleHook<T>>, context: T): Promise<T> {
  let currentContext: T = context;

  for (const hook of hooks) {
    const result = hook(currentContext);

    // Handle both sync and async return values
    const resolved = result instanceof Promise ? await result : result;

    // Validate hook return value
    if (resolved === null || resolved === undefined) {
      throw new Error('Hook returned null/undefined — hooks must always return context');
    }

    currentContext = resolved;
  }

  return currentContext;
}

/**
 * Normalizes a partial hook registry to a complete one, replacing undefined fields with empty arrays.
 * Called once per run in pipeline.ts to eliminate null-checks at every hook call site.
 * @param partial - Optional partial hook registry
 * @returns Normalized HookRegistry with all fields defined as arrays
 */
export function normalizeHookRegistry(partial?: Partial<HookRegistry>): HookRegistry {
  return {
    beforeRun: partial?.beforeRun ?? [],
    afterRun: partial?.afterRun ?? [],
    beforeGenerate: partial?.beforeGenerate ?? [],
    afterGenerate: partial?.afterGenerate ?? [],
    beforeTool: partial?.beforeTool ?? [],
    afterTool: partial?.afterTool ?? [],
  };
}
