import type { Logger } from '../interfaces.js';
import { LOG_LEVELS, type LogLevel } from './shared.js';

const LEVEL_PADDED: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

// ANSI color codes — only applied when output is a TTY
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

export interface PrettyLoggerOptions {
  level?: LogLevel;
  output?: (line: string) => void;
  colors?: boolean; // auto-detect by default
}

/**
 * Human-readable pretty logger implementing the Logger interface.
 * Uses colors when output is a TTY.
 *
 * @example
 * const logger = new PrettyLogger({ level: 'info' });
 * logger.info('Run started', { runId: 'abc' });
 * // 2026-08-11T10:30:00.000Z INFO  (runId: abc) Run started
 */
export class PrettyLogger implements Logger {
  private readonly level: number;
  private readonly output: (line: string) => void;
  private readonly useColors: boolean;

  constructor(options: PrettyLoggerOptions = {}) {
    this.level = LOG_LEVELS[options.level ?? 'debug'];
    // eslint-disable-next-line no-console
    this.output = options.output ?? ((line: string) => console.log(line));
    this.useColors = options.colors ?? (options.output !== undefined ? false : hasTTY());
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log('debug', msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.log('info', msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log('warn', msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.log('error', msg, meta);
  }

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.level) return;

    const timestamp = new Date().toISOString();

    const metaStr = meta
      ? Object.entries(meta)
          .map(([k, v]) => `${k}: ${formatMetaValue(v)}`)
          .join(', ')
      : '';

    const metaPart = metaStr ? `(${metaStr}) ` : '';
    const prefix = `${timestamp} `;

    if (this.useColors) {
      const color = COLORS[level];
      this.output(`${color}${prefix}${LEVEL_PADDED[level]} ${metaPart}${msg}${RESET}`);
    } else {
      this.output(`${prefix}${LEVEL_PADDED[level]} ${metaPart}${msg}`);
    }
  }
}

function hasTTY(): boolean {
  try {
    return typeof process !== 'undefined' && process.stdout?.isTTY === true;
  } catch {
    return false;
  }
}

function formatMetaValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
