# B9 — Built-in Structured Logger (JsonLogger, PrettyLogger)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

1. Implement `JsonLogger` class that outputs structured JSON lines via a pluggable output function.
2. Implement `PrettyLogger` class that outputs human-readable colored output (no colors when output is not a TTY).
3. Both must respect the `Logger` interface from `interfaces.ts` exactly.
4. Support log level filtering via constructor option (`level: 'error' | 'warn' | 'info' | 'debug'`).
5. Export both from `@atisse/core` public API.
6. Must be runtime-agnostic: no Node.js-specific APIs (`process.stdout`, `fs`). Use a pluggable `output` function.

---

## 2. Context (Why This Exists)

The current shipped v1 kernel uses a no-op logger by default (see `orchestrator.ts` line 28–35):

```typescript
function noOpLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
```

Production deployments must inject their own `Logger` implementation to see any output. This is a significant DX pain point — every new user must either:

1. Write their own logger before they can debug their first `run()` call, or
2. Use a third-party logging library that they must integrate to match the `Logger` interface.

This violates Principle 6 (Production-Ready Defaults). A production-ready kernel should ship working logger implementations that users can use immediately, even if they eventually replace them with a custom integration.

The `Logger` interface itself is frozen (defined in `packages/core/src/interfaces.ts:359-364`) — these implementations must conform exactly to it. No changes to the interface are permitted.

The default no-op logger behavior is NOT changed — the Orchestrator still defaults to silent operation unless a logger is provided. These new classes are exported utilities that users can optionally pass to `OrchestratorConfig.logger`.

---

## 3. Issues/Changes

### Issue B9-1: No Built-in Logger Implementations

| Field       | Value                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/logger/` (NEW directory)                                                                                 |
| Lines       | N/A — new files                                                                                                             |
| Severity    | LOW                                                                                                                         |
| Description | No `JsonLogger` or `PrettyLogger` implementations exist. Users must write their own Logger or use the silent no-op default. |
| Fix         | Create `shared.ts`, `json-logger.ts`, `pretty-logger.ts`, and barrel export in `packages/core/src/logger/`.                              |

### Issue B9-2: No Public Export of Built-in Loggers

| Field       | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| File        | `packages/core/src/index.ts`                                          |
| Lines       | 1–73 (entire file)                                                    |
| Severity    | LOW                                                                   |
| Description | `JsonLogger` and `PrettyLogger` must be exported from the public API. |
| Fix         | Add exports for both classes and their options types via barrel.                                         |

---

## 4. Architectural Directives

Layer: L1 primitives per ADR-030 (L0 is only interfaces/errors/types). Logger imports only `import type {Logger} from '../interfaces.js'` — no circular, no adapter imports. Logger is stateless per-principle: no `this` state shared across `run()` calls beyond level/output config.

### 4.1 Chosen Approach

#### Architecture: Pluggable Output

Both logger implementations must NOT use Node.js-specific APIs (`process.stdout`, `fs.createWriteStream`). Instead, they accept an `output` function in their constructor options:

```typescript
interface LoggerOptions {
  level?: LogLevel;
  output?: (line: string) => void;
}
```

Default output: single (line:string)=>void callback; default impl routes to console.log (all levels). If per-level routing is needed, caller wraps output and dispatches on level. `console.error` is NOT used by default. This is runtime-agnostic — `console` is available in Node.js, browsers, Deno, and Bun. JsonLogEntry runId is injected via meta by pipeline.ts:343 `logger.info('Run started', {runId})` — logger does not special-case runId, correct per observability skill.

#### Log Levels

Order (lowest to highest severity): `debug` → `info` → `warn` → `error`.

Level filtering: When a logger is constructed with `level: 'warn'`, only `warn` and `error` calls produce output. `debug` and `info` are no-ops.

```typescript
import { LOG_LEVELS, type LogLevel } from './shared.js';
```

Shared definition lives in `packages/core/src/logger/shared.ts`:

```typescript
export const LOG_LEVELS = { debug:0, info:1, warn:2, error:3 } as const;
export type LogLevel = keyof typeof LOG_LEVELS;
```

#### `JsonLogger`

Each log call produces one line of JSON. Format:

```typescript
interface JsonLogEntry {
  timestamp: string; // ISO 8601
  level: LogLevel;
  msg: string;
  meta?: Record<string, unknown>;
}
```

Example output:

```
{"timestamp":"2026-08-11T10:30:00.000Z","level":"info","msg":"Run started","meta":{"runId":"abc-123"}}
{"timestamp":"2026-08-11T10:30:00.001Z","level":"debug","msg":"Generating","meta":{"runId":"abc-123","messageCount":5}}
```

#### `PrettyLogger`

Each log call produces a human-readable line. Format:

```
2026-08-11T10:30:00.000Z INFO  (runId: abc-123) Run started
2026-08-11T10:30:00.001Z DEBUG (runId: abc-123) Generating — messageCount: 5
```

- Timestamp: ISO 8601 (e.g., `2026-08-11T10:30:00.000Z`).
- Level: padded to 5 characters for alignment (`"INFO" → "INFO "` trailing space, `"DEBUG"` stays 5, `"WARN "`, `"ERROR"`).
- Meta fields: rendered as `key: value` pairs in parentheses.
- Colors (ANSI): Applied only when `output` is connected to a TTY. Default detection via `typeof process !== 'undefined' && process.stdout?.isTTY`. This is the only runtime check — acceptable because it's a single detection at construction time, not per-call. Custom output defaults to colors:false to avoid ANSI pollution in test/CI capture; explicit colors:true overrides.
- Color scheme:
  - `error`: red
  - `warn`: yellow
  - `info`: green
  - `debug`: gray/dim

#### No External Dependencies

Both loggers use only standard ECMAScript features. No dependencies required — Zod is the only runtime dep in core, and no logging library (pino, winston, etc.) may be added.

#### `Logger` Interface Compliance

Both classes must implement the `Logger` interface exactly:

```typescript
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
```

No additional public methods. Internal helpers are private.

### 4.2 What NOT to Do

- Do NOT add any runtime dependencies (pino, winston, etc.) — Zod is the only permitted runtime dependency in core.
- Do NOT use `process.stdout` directly — use the pluggable `output` function; default impl uses single-channel `console.log`.
- Do NOT modify the `Logger` interface — it is frozen.
- Do NOT change the default no-op logger behavior in `orchestrator.ts`. The default remains silent. Users opt in by passing `logger: new JsonLogger()`.
- Do NOT add async log methods — the `Logger` interface is synchronous.
- Do NOT add log rotation, file output, or transport configuration — this is a built-in default, not a logging framework.
- Do NOT add ANSI color codes when `output` is not connected to a TTY — respect non-TTY environments (CI, log files, pipes).
- tsconfig.base.json:6 already includes lib: ["ES2022","DOM"]; no additional lib needed; hasTTY() guard suffices without DOM types via @types/node.
- Default console.log is intentional — add `// eslint-disable-next-line no-console` comment to satisfy no-console warn per code-standards:95.

---

## 5. Files to Modify

| File                                        | Action | Notes                                           |
| ------------------------------------------- | ------ | ----------------------------------------------- |
| `packages/core/src/logger/shared.ts`        | NEW    | Shared `LOG_LEVELS` + `LogLevel` (DRY)          |
| `packages/core/src/logger/json-logger.ts`   | NEW    | `JsonLogger` implementation                     |
| `packages/core/src/logger/pretty-logger.ts` | NEW    | `PrettyLogger` implementation                   |
| `packages/core/src/logger/index.ts`         | NEW    | Barrel export for both loggers                  |
| `packages/core/src/index.ts`                | Modify | Add exports for `JsonLogger` and `PrettyLogger` via barrel |

No existing code is modified except `packages/core/src/index.ts` (adding exports).

### 5b. Versioning & Changeset

Additive export → MINOR bump for `@atisse/core` per api-design:40-48; add `.changeset/<id>.md` with `minor` entry describing `JsonLogger`, `PrettyLogger`, and options types export. API addition is optional and backward-compatible; no MAJOR required. tsup.config.ts:3-6 unchanged — logger files transitive via src/index.ts.

---

## 6. Implementation Strategy

### Step 0: Create `packages/core/src/logger/shared.ts`

```typescript
export const LOG_LEVELS = { debug:0, info:1, warn:2, error:3 } as const;
export type LogLevel = keyof typeof LOG_LEVELS;
```

### Step 1: Create `packages/core/src/logger/json-logger.ts`

```typescript
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
```

### Step 2: Create `packages/core/src/logger/pretty-logger.ts`

```typescript
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
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
```

### Step 3: Create `packages/core/src/logger/index.ts`

```typescript
export { JsonLogger } from './json-logger.js';
export type { JsonLoggerOptions } from './json-logger.js';
export { PrettyLogger } from './pretty-logger.js';
export type { PrettyLoggerOptions } from './pretty-logger.js';
export { LOG_LEVELS } from './shared.js';
export type { LogLevel } from './shared.js';
```

### Step 4: Export from `packages/core/src/index.ts`

Add after the existing exports (before or after the error exports):

```typescript
// Built-in logger implementations
export { JsonLogger, PrettyLogger } from './logger/index.js';
export type { JsonLoggerOptions, PrettyLoggerOptions } from './logger/index.js';
```

This is additive optional export → MINOR, Pit of Success per api-design. Keep tsup.config.ts:3-6 unchanged — logger files transitive via src/index.ts.

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify:

### JsonLogger

1. `new JsonLogger().info('test')` outputs a valid JSON line to the default output.
2. `new JsonLogger({ level: 'warn' }).debug('test')` produces NO output.
3. `new JsonLogger({ level: 'warn' }).info('test')` produces NO output.
4. `new JsonLogger({ level: 'warn' }).warn('test')` produces output.
5. `new JsonLogger({ level: 'error' }).error('test')` produces output.
6. Each JSON line is valid and contains `timestamp`, `level`, `msg`.
7. When `meta` is provided, the JSON line includes a `meta` field.
8. Custom `output` function receives the exact JSON string.

### PrettyLogger

9. `new PrettyLogger().info('test')` outputs a human-readable line.
10. `new PrettyLogger({ level: 'warn' }).debug('test')` produces NO output.
11. `new PrettyLogger({ colors: false, output: (line) => outputs.push(line) }).info('test')` produces uncolored output.
12. `new PrettyLogger({ colors: true }).info('test')` produces colored output with ANSI escape codes.
13. When `meta` is provided, it appears in `(key: value)` format.

### Logger Interface Compliance

14. Both classes satisfy `type LoggerCheck = Logger` assignment compatibility (`const logger: Logger = new JsonLogger()` compiles).
15. All four methods (`debug`, `info`, `warn`, `error`) are callable and type-check correctly.
16. `pnpm test:coverage` core ≥70% lines/branches preserved (testing skill threshold).
17. No filesystem writes — verify no `fs.*` import in logger files (constraints: no `fs`, no `process.stdout` direct).
18. Logger interface compliance verified via mockLogger capture (runtime) not just type-check, and options types importable from top-level index (`import type { JsonLoggerOptions, PrettyLoggerOptions } from '@atisse/core'`).

### No Code Regressions

19. All existing tests pass (orchestrator uses no-op logger — unchanged).
20. TypeScript compilation succeeds with `tsconfig.base.json:6` lib `["ES2022","DOM"]` (no extra DOM/Node types needed).

JsonLogEntry runId is injected via meta by pipeline.ts:343 `logger.info('Run started', {runId})` — logger does not special-case runId, correct per observability skill.

---

## 8. Risk Assessment

| Risk                                                         | Likelihood | Impact | Mitigation                                                                                                                                      |
| ------------------------------------------------------------ | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `console.log` output in non-Node runtimes differs            | LOW        | LOW    | `console.log` is defined in the Web API spec and available in all modern runtimes. Browsers, Deno, and Bun all support it. Single-channel output ensures consistency.                      |
| ANSI color codes in non-TTY output (CI, logs)                | LOW        | LOW    | Addressed: custom output defaults to colors:false to avoid ANSI pollution; TTY auto-detection via `hasTTY()` guards default case; explicit `colors: true` overrides.                            |
| Timestamp format (UTC ISO 8601) surprises local-time readers | LOW        | LOW    | `toISOString()` emits UTC ISO 8601 deterministically regardless of system locale; local-time rendering is out of scope for v1.                  |
| `process` global not available in some edge runtimes         | LOW        | MEDIUM | The `hasTTY()` function uses a guarded `typeof process !== 'undefined'` check inside a try-catch. If unavailable, `colors` defaults to `false`. |
| Performance: `JSON.stringify` on every log call              | LOW        | LOW    | Logging is by definition an I/O operation. `JSON.stringify` overhead is negligible compared to the I/O cost.                                    |

---

## 9. References

- `packages/core/src/interfaces.ts:359-364` — `Logger` interface (frozen)
- `.opencode/skill/interfaces/SKILL.md` — `Logger` interface (§Logger Contract)
- `.opencode/skill/observability/SKILL.md` — Log levels, required log points, log message format rules
- `.opencode/skill/principles/SKILL.md` — Principle 6 (Production-Ready Defaults)
- `.opencode/skill/constraints/SKILL.md` — No new runtime dependencies (Zod only)
- `tsconfig.base.json:6` — lib `["ES2022","DOM"]` (no extra lib needed)
- `packages/core/src/index.ts` — Current public API exports
- `packages/core/src/interfaces.ts` — `Logger` interface definition
- `packages/core/src/orchestrator.ts` — Current no-op logger (lines 28–35)
