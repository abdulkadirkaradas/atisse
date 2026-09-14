import type { OrchestratorEvent, EventBus, Logger } from './interfaces.js';
import { OrchestratorError } from './errors.js';

type InternalEventBusOptions = {
  onListenerError?: (error: unknown, eventType: string) => void;
  logger?: Logger;
};

/**
 * Internal EventBus.
 *
 * Layer: L2 (controller)
 * Dependencies: L0 only (interfaces.ts, errors.ts)
 */
class InternalEventBus implements EventBus {
  private readonly listeners: Map<string, Set<(event: OrchestratorEvent) => void>> = new Map();
  private readonly onListenerError: ((error: unknown, eventType: string) => void) | undefined;
  private readonly logger: Logger | undefined;

  constructor(options: InternalEventBusOptions = {}) {
    this.onListenerError = options.onListenerError;
    this.logger = options.logger;
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
            // Fire-and-forget per ADR-004 + hooks-events SKILL: notify and log, never throw
            try {
              this.onListenerError?.(error, event.type);
              this.logger?.warn('Event listener threw an error', {
                runId: event.runId,
                eventType: event.type,
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof OrchestratorError ? { code: error.code } : {}),
              });
            } catch {
              // Neither onListenerError nor logger.warn may produce unhandled rejections
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
 * @param options - Optional configuration for the EventBus.
 *   onListenerError: callback invoked when an async listener rejects.
 *   logger: optional Logger for warn-level logging of listener errors.
 */
export function createEventBus(options: InternalEventBusOptions = {}): EventBus {
  return new InternalEventBus(options);
}
