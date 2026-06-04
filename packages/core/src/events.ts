import type { OrchestratorEvent, EventBus } from './interfaces.js';

/**
 * Internal EventBus.
 *
 * Layer: L2 (controller)
 * Dependencies: L0 only (interfaces.ts)
 */
class InternalEventBus implements EventBus {
  private readonly listeners: Map<string, Set<(event: OrchestratorEvent) => void>> = new Map();
  private readonly onListenerError: ((error: unknown, eventType: string) => void) | undefined;

  constructor(onListenerError?: (error: unknown, eventType: string) => void) {
    this.onListenerError = onListenerError;
  }

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
      if (result instanceof Promise) {
        void (async () => {
          try {
            await result;
          } catch (error) {
            // Notify caller if callback provided; otherwise silently swallow per ADR-004
            try {
              this.onListenerError?.(error, event.type);
            } catch {
              // Silently swallow per ADR-004 — onListenerError itself must not produce unhandled rejections
            }
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
 *
 * @param onListenerError - Optional callback invoked when an async listener rejects.
 *   Receives the error and the event type. Default behavior is silent (no callback).
 *   Pass a logger.error wrapper during development for visibility into listener failures.
 */
export function createEventBus(
  onListenerError?: (error: unknown, eventType: string) => void,
): EventBus {
  return new InternalEventBus(onListenerError);
}
