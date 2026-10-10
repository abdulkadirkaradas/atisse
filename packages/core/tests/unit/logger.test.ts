import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Logger } from '../../src/interfaces.js';
import { JsonLogger } from '../../src/logger/json-logger.js';
import { PrettyLogger } from '../../src/logger/pretty-logger.js';
import { LOG_LEVELS } from '../../src/logger/shared.js';
import type { JsonLoggerOptions, PrettyLoggerOptions } from '../../src/index.js';
import {
  JsonLogger as JsonLoggerFromIndex,
  PrettyLogger as PrettyLoggerFromIndex,
} from '../../src/index.js';

function captureOutput(): { lines: string[]; output: (line: string) => void } {
  const lines: string[] = [];
  return { lines, output: (line: string) => lines.push(line) };
}

describe('JsonLogger', () => {
  it('outputs a valid JSON line with timestamp, level, and msg', () => {
    const { lines, output } = captureOutput();
    new JsonLogger({ output }).info('Run started', { runId: 'abc-123' });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: 'info', msg: 'Run started', meta: { runId: 'abc-123' } });
    expect(typeof entry['timestamp']).toBe('string');
    expect(() => new Date(entry['timestamp'] as string).toISOString()).not.toThrow();
  });

  it('omits meta field when meta is not provided', () => {
    const { lines, output } = captureOutput();
    new JsonLogger({ output }).info('test');

    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).not.toHaveProperty('meta');
  });

  it('filters levels below the configured threshold', () => {
    const { lines, output } = captureOutput();
    const logger = new JsonLogger({ level: 'warn', output });

    logger.debug('d');
    logger.info('i');
    expect(lines).toHaveLength(0);

    logger.warn('w');
    logger.error('e');
    expect(lines).toHaveLength(2);
  });

  it('emits only error when level is error', () => {
    const { lines, output } = captureOutput();
    const logger = new JsonLogger({ level: 'error', output });

    logger.warn('w');
    expect(lines).toHaveLength(0);
    logger.error('test');
    expect(lines).toHaveLength(1);
  });

  it('satisfies the Logger interface assignment', () => {
    const { output } = captureOutput();
    const logger: Logger = new JsonLogger({ output });
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});

describe('PrettyLogger', () => {
  it('outputs a human-readable line with padded level', () => {
    const { lines, output } = captureOutput();
    new PrettyLogger({ colors: false, output }).info('Run started', { runId: 'abc-123' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/INFO  \(runId: abc-123\) Run started$/);
  });

  it('filters levels below the configured threshold', () => {
    const { lines, output } = captureOutput();
    const logger = new PrettyLogger({ level: 'warn', colors: false, output });

    logger.debug('d');
    expect(lines).toHaveLength(0);
  });

  it('produces uncolored output when colors is false', () => {
    const { lines, output } = captureOutput();
    new PrettyLogger({ colors: false, output }).info('test');

    expect(lines[0]).not.toContain('\x1b[');
  });

  it('produces colored output with ANSI codes when colors is true', () => {
    const { lines, output } = captureOutput();
    new PrettyLogger({ colors: true, output }).info('test');

    expect(lines[0]).toContain('\x1b[');
  });

  it('renders meta as key: value pairs', () => {
    const { lines, output } = captureOutput();
    new PrettyLogger({ colors: false, output }).info('Generating', {
      runId: 'abc-123',
      messageCount: 5,
    });

    expect(lines[0]).toContain('(runId: abc-123, messageCount: 5)');
  });

  it('satisfies the Logger interface assignment', () => {
    const { output } = captureOutput();
    const logger: Logger = new PrettyLogger({ colors: false, output });
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});

describe('logger edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes to console.log when no output is provided', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    new JsonLogger().info('default output');
    new PrettyLogger({ colors: false }).info('default output');

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('formats null, undefined, bigint, and boolean meta values', () => {
    const { lines, output } = captureOutput();
    new PrettyLogger({ colors: false, output }).info('edge', {
      // eslint-disable-next-line no-null/no-null
      nil: null,
      missing: undefined,
      big: 10n,
      flag: true,
    });

    expect(lines[0]).toContain('nil: null');
    expect(lines[0]).toContain('missing: undefined');
    expect(lines[0]).toContain('big: 10');
    expect(lines[0]).toContain('flag: true');
  });

  it('serializes object meta values and survives circular references', () => {
    const { lines, output } = captureOutput();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    new PrettyLogger({ colors: false, output }).info('objects', {
      nested: { retries: 3 },
      circular,
    });

    expect(lines[0]).toContain('nested: {"retries":3}');
    expect(lines[0]).toContain('circular: [object Object]');
  });
});

describe('logger barrel exports', () => {
  it('exposes loggers and option types from the public index', () => {
    expect(JsonLoggerFromIndex).toBe(JsonLogger);
    expect(PrettyLoggerFromIndex).toBe(PrettyLogger);
    expect(LOG_LEVELS).toMatchObject({ debug: 0, info: 1, warn: 2, error: 3 });

    const jsonOptions: JsonLoggerOptions = { level: 'info' };
    const prettyOptions: PrettyLoggerOptions = { level: 'debug', colors: false };
    expect(jsonOptions.level).toBe('info');
    expect(prettyOptions.level).toBe('debug');
  });
});
