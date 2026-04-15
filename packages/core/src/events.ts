import type { OrchestratorEvent, EventBus } from './interfaces.js';

/**
 * Internal EventBus.
 *
 * Layer: L2 (controller)
 * Dependencies: L0 only (interfaces.ts)
 */
class InternalEventBus implements EventBus {
  private readonly listeners: Map<string, Set<(event: OrchestratorEvent) => void>> = new Map();

  /**
   * Emit an event to all registered listeners.
   * Sync listeners are called directly; async listeners are wrapped in try/catch
   * — errors are silently swallowed to prevent pipeline disruption.
   */
  emit<T extends OrchestratorEvent>(event: T): void {
    const type = event.type as string;
    const listenersForType = this.listeners.get(type);

    if (!listenersForType) {
      return;
    }

    for (const listener of listenersForType) {
      // Cast to unknown to handle both sync and async listeners
      const result = listener(event) as unknown;

      // Handle potential Promise returns — errors silently swallowed per implementation-standards.md
      if (
        result &&
        typeof result === 'object' &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        void (async () => {
          try {
            await Promise.resolve(result as Promise<unknown>);
          } catch {
            // Swallow — listener errors must never affect pipeline
          }
        })();
      }
    }
  }

  /**
   * Register a listener for a specific event type.
   * Returns an unsubscribe function.
   */
  on<T extends OrchestratorEvent['type']>(
    type: T,
    listener: (event: Extract<OrchestratorEvent, { type: T }>) => void,
  ): () => void {
    let listenersForType = this.listeners.get(type);

    if (!listenersForType) {
      listenersForType = new Set();
      this.listeners.set(type, listenersForType);
    }

    listenersForType.add(listener as (event: OrchestratorEvent) => void);

    // Return unsubscribe closure
    return () => {
      const current = this.listeners.get(type);
      if (current) {
        current.delete(listener as (event: OrchestratorEvent) => void);
      }
    };
  }
}

/**
 * Factory function to create a new EventBus instance.
 * Used by orchestrator.ts to construct the EventBus.
 */
export function createEventBus(): EventBus {
  return new InternalEventBus();
}
