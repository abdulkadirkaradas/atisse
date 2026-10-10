import type { Logger } from '../interfaces.js';
import { LOG_LEVELS, type LogLevel } from './shared.js';

export interface JsonLoggerOptions {
  level?: LogLevel;
  output?: (line: string) => void;
}

/**
 * Structured JSON logger implementing the Logger interface.
 * Outputs one JSON line per log call.
 *
 * @example
 * const logger = new JsonLogger({ level: 'info' });
 * logger.info('Run started', { runId: 'abc' });
 * // {"timestamp":"2026-08-11T10:30:00.000Z","level":"info","msg":"Run started","meta":{"runId":"abc"}}
 */
export class JsonLogger implements Logger {
  private readonly level: number;
  private readonly output: (line: string) => void;

  constructor(options: JsonLoggerOptions = {}) {
    this.level = LOG_LEVELS[options.level ?? 'debug'];
    // eslint-disable-next-line no-console
    this.output = options.output ?? ((line: string) => console.log(line));
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

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...(meta !== undefined ? { meta } : {}),
    };

    this.output(JSON.stringify(entry));
  }
}
