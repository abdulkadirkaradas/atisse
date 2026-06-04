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

    it('backward compat: no callback silently swallows async listener rejection', async () => {
      const listener = async () => {
        throw new Error('async listener error');
      };
      const bus = createEventBus(); // no callback
      bus.on('run.started', listener);

      const unhandledRejectionHandler = vi.fn();
      process.on('unhandledRejection', unhandledRejectionHandler);

      bus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      await new Promise<void>((resolve) => process.nextTick(resolve));

      process.removeListener('unhandledRejection', unhandledRejectionHandler);

      expect(unhandledRejectionHandler).not.toHaveBeenCalled();
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

    it('sync listener throw short-circuits remaining async listeners', () => {
      const syncThrowListener = () => {
        throw new Error('sync fail');
      };
      const afterListener = vi.fn(async () => {});
      eventBus.on('run.started', syncThrowListener);
      eventBus.on('run.started', afterListener);

      expect(() =>
        eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() }),
      ).toThrow('sync fail');
      expect(afterListener).not.toHaveBeenCalled();
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

    it('unsubscribe is idempotent when called twice', () => {
      const listener = vi.fn();
      const unsubscribe = eventBus.on('run.started', listener);
      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not call the same listener reference twice when registered twice', () => {
      const listener = vi.fn();
      eventBus.on('run.started', listener);
      eventBus.on('run.started', listener);
      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('supports re-subscribing after all listeners for a type are unsubscribed', () => {
      const listener1 = vi.fn();
      const unsubscribe = eventBus.on('run.started', listener1);
      unsubscribe();

      const listener2 = vi.fn();
      eventBus.on('run.started', listener2);
      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('instanceof Promise guard (Fix 1)', () => {
    it('does NOT treat thenable object as async', () => {
      const then = vi.fn();
      const listener = vi.fn().mockReturnValue({ then });
      eventBus.on('run.started', listener);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(then).not.toHaveBeenCalled();
    });

    it('null return does not trigger async wrap', () => {
      const listener = vi.fn().mockReturnValue(null);
      eventBus.on('run.started', listener);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('undefined return does not trigger async wrap', () => {
      const listener = vi.fn().mockReturnValue(undefined);
      eventBus.on('run.started', listener);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('string return does not trigger async wrap', () => {
      const listener = vi.fn().mockReturnValue('hello');
      eventBus.on('run.started', listener);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('plain object return does not trigger async wrap', () => {
      const listener = vi.fn().mockReturnValue({});
      eventBus.on('run.started', listener);

      eventBus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('onListenerError callback (Fix 2)', () => {
    it('invokes onListenerError when async listener rejects', async () => {
      const onError = vi.fn();
      const bus = createEventBus(onError);
      bus.on('run.started', async () => {
        throw new Error('async fail');
      });

      bus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('passes the error object as first argument to onListenerError', async () => {
      const onError = vi.fn();
      const bus = createEventBus(onError);
      const error = new Error('async fail');
      bus.on('run.started', async () => {
        throw error;
      });

      bus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(onError).toHaveBeenCalledWith(error, expect.any(String));
    });

    it('passes the event type string as second argument to onListenerError', async () => {
      const onError = vi.fn();
      const bus = createEventBus(onError);
      bus.on('run.started', async () => {
        throw new Error('fail');
      });

      bus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'run.started');
    });

    it('does NOT invoke onListenerError when async listener succeeds', async () => {
      const onError = vi.fn();
      const bus = createEventBus(onError);
      bus.on('run.started', async () => {
        return 'ok';
      });

      bus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(onError).not.toHaveBeenCalled();
    });

    it('does NOT produce unhandled rejection when onListenerError itself throws', async () => {
      const onError = vi.fn().mockImplementation(() => {
        throw new Error('callback itself throws');
      });
      const bus = createEventBus(onError);
      bus.on('run.started', async () => {
        throw new Error('async listener fail');
      });

      const unhandledRejectionHandler = vi.fn();
      process.on('unhandledRejection', unhandledRejectionHandler);

      bus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      await new Promise<void>((resolve) => process.nextTick(resolve));

      process.removeListener('unhandledRejection', unhandledRejectionHandler);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(unhandledRejectionHandler).not.toHaveBeenCalled();
    });

    it('mixed async success/failure isolates correctly', async () => {
      const onError = vi.fn();
      const bus = createEventBus(onError);

      bus.on('run.started', async () => {
        return 'success';
      });
      bus.on('run.started', async () => {
        throw new Error('failure');
      });

      bus.emit({ type: 'run.started', runId: '123', timestamp: Date.now() });

      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'run.started');
    });
  });
});
