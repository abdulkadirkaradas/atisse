import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEventBus } from '../../src/events.js';

describe('events', () => {
  let eventBus: ReturnType<typeof createEventBus>;

  beforeEach(() => {
    eventBus = createEventBus();
  });

  describe('emit()', () => {
    it('calls listener with correct payload', () => {
      const listener = vi.fn();
      eventBus.on('run.started', listener);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'run.started',
          runId: '123',
        }),
      );
    });

    it('does not call listener after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = eventBus.on('run.started', listener);
      unsubscribe();

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener).not.toHaveBeenCalled();
    });

    it('sync listener throw propagates', () => {
      const listener = () => {
        throw new Error('listener error');
      };
      eventBus.on('run.started', listener);

      expect(() =>
        eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() }),
      ).toThrow('listener error');
    });

    it('swallows async listener rejection', async () => {
      const listener = async () => {
        throw new Error('async listener error');
      };
      eventBus.on('run.started', listener);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it('calls all listeners when multiple registered', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      eventBus.on('run.started', listener1);
      eventBus.on('run.started', listener2);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no listeners registered', () => {
      expect(() =>
        eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() }),
      ).not.toThrow();
    });
  });

  describe('on()', () => {
    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsubscribe = eventBus.on('run.started', listener);

      expect(typeof unsubscribe).toBe('function');

      unsubscribe();
      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener).not.toHaveBeenCalled();
    });

    it('handles different event types', () => {
      const runListener = vi.fn();
      const toolListener = vi.fn();

      eventBus.on('run.started', runListener);
      eventBus.on('tool.called', toolListener);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });
      eventBus.emit({ type: 'tool.called', runId: '123', toolName: 'echo', round: 1 });

      expect(runListener).toHaveBeenCalledTimes(1);
      expect(toolListener).toHaveBeenCalledTimes(1);
    });
  });
});
