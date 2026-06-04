import { describe, it, expect } from 'vitest';
import {
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderAuthError,
  ProviderMalformedResponse,
  ToolExecutionError,
  ToolValidationError,
  ToolNotFoundError,
  ContextLoadError,
  ContextProviderError,
  MemorySaveError,
  MaxRetriesExceededError,
  MaxToolRoundsExceededError,
  TokenLimitExceededError,
  TimeoutExceededError,
  FallbackExhaustedError,
  InvalidStateTransitionError,
  ConfigValidationError,
  PipelineInternalError,
  HookExecutionError,
  RunCancelledError,
  isRetryable,
} from '../../src/errors.js';

describe('OrchestratorError', () => {
  it('error.name equals constructor name', () => {
    const error = new ProviderTimeoutError('test');
    expect(error.name).toBe('ProviderTimeoutError');
  });

  it('cause is preserved', () => {
    const cause = new Error('original');
    const error = new ProviderTimeoutError('test', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('isRetryable', () => {
  describe('returns true for retryable errors', () => {
    const retryableErrors = [
      ['ProviderRateLimitError', () => new ProviderRateLimitError('rate limited')],
      ['ProviderTimeoutError', () => new ProviderTimeoutError('timeout')],
      ['ProviderUnavailableError', () => new ProviderUnavailableError('unavailable')],
      ['ToolExecutionError', () => new ToolExecutionError('tool')],
      ['ContextLoadError', () => new ContextLoadError('provider')],
      ['ContextProviderError', () => new ContextProviderError('provider')],
    ] as const;

    for (const [name, factory] of retryableErrors) {
      it(name, () => {
        expect(isRetryable(factory())).toBe(true);
      });
    }
  });

  describe('returns false for non-retryable errors', () => {
    const nonRetryableErrors = [
      ['ProviderAuthError', () => new ProviderAuthError('auth')],
      ['ProviderMalformedResponse', () => new ProviderMalformedResponse('malformed')],
      ['ToolValidationError', () => new ToolValidationError('tool', ['err'])],
      ['ToolNotFoundError', () => new ToolNotFoundError('tool')],
      [
        'MaxRetriesExceededError',
        () => new MaxRetriesExceededError(3, new ProviderTimeoutError('t')),
      ],
      ['TokenLimitExceededError', () => new TokenLimitExceededError('limit')],
      ['TimeoutExceededError', () => new TimeoutExceededError(5000)],
      [
        'FallbackExhaustedError',
        () =>
          new FallbackExhaustedError(new ProviderTimeoutError('p'), new ProviderTimeoutError('f')),
      ],
      [
        'InvalidStateTransitionError',
        () => new InvalidStateTransitionError('INITIALIZED', 'COMPLETED'),
      ],
      ['ConfigValidationError', () => new ConfigValidationError(['err'])],
      ['PipelineInternalError', () => new PipelineInternalError('test')],
      ['MemorySaveError', () => new MemorySaveError(new Error('test'))],
      ['HookExecutionError', () => new HookExecutionError('hook failed')],
      ['RunCancelledError', () => new RunCancelledError()],
      ['MaxToolRoundsExceededError', () => new MaxToolRoundsExceededError(5, 10)],
    ] as const;

    for (const [name, factory] of nonRetryableErrors) {
      it(name, () => {
        expect(isRetryable(factory())).toBe(false);
      });
    }
  });

  it('returns false for plain Error', () => {
    expect(isRetryable(new Error('plain'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRetryable(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRetryable(undefined)).toBe(false);
  });

  it('returns false for duck-typed object with retryable: true', () => {
    expect(isRetryable({ retryable: true })).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isRetryable('')).toBe(false);
  });

  it('returns false for number', () => {
    expect(isRetryable(42)).toBe(false);
  });

  it('returns false for plain object', () => {
    expect(isRetryable({})).toBe(false);
  });
});

// ── Provider Error Blocks ───────────────────────────────────────

describe('ProviderRateLimitError', () => {
  it('preserves retryAfterMs', () => {
    const error = new ProviderRateLimitError('rate limited', 5000);
    expect(error.retryAfterMs).toBe(5000);
  });

  it('has retryAfterMs undefined when not provided', () => {
    const error = new ProviderRateLimitError('rate limited');
    expect(error.retryAfterMs).toBeUndefined();
  });
});

describe('ProviderTimeoutError', () => {
  it('has code PROVIDER_TIMEOUT', () => {
    const error = new ProviderTimeoutError('timeout');
    expect(error.code).toBe('PROVIDER_TIMEOUT');
  });

  it('is retryable', () => {
    const error = new ProviderTimeoutError('timeout');
    expect(error.retryable).toBe(true);
  });
});

describe('ProviderUnavailableError', () => {
  it('has code PROVIDER_UNAVAILABLE', () => {
    const error = new ProviderUnavailableError('unavailable');
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('is retryable', () => {
    const error = new ProviderUnavailableError('unavailable');
    expect(error.retryable).toBe(true);
  });
});

describe('ProviderAuthError', () => {
  it('has code PROVIDER_AUTH_FAILED', () => {
    const error = new ProviderAuthError('auth failed');
    expect(error.code).toBe('PROVIDER_AUTH_FAILED');
  });

  it('is not retryable', () => {
    const error = new ProviderAuthError('auth failed');
    expect(error.retryable).toBe(false);
  });
});

describe('ProviderMalformedResponse', () => {
  it('has code PROVIDER_MALFORMED_RESPONSE', () => {
    const error = new ProviderMalformedResponse('bad json');
    expect(error.code).toBe('PROVIDER_MALFORMED_RESPONSE');
  });

  it('is not retryable', () => {
    const error = new ProviderMalformedResponse('bad json');
    expect(error.retryable).toBe(false);
  });
});

// ── Tool Error Blocks ───────────────────────────────────────────

describe('ToolExecutionError', () => {
  it('has code TOOL_EXECUTION_FAILED', () => {
    const error = new ToolExecutionError('myTool');
    expect(error.code).toBe('TOOL_EXECUTION_FAILED');
  });

  it('is retryable', () => {
    const error = new ToolExecutionError('myTool');
    expect(error.retryable).toBe(true);
  });

  it('preserves toolName', () => {
    const error = new ToolExecutionError('myTool');
    expect(error.toolName).toBe('myTool');
  });

  it('generates message with tool name', () => {
    const error = new ToolExecutionError('myTool');
    expect(error.message).toBe('Tool execution failed: myTool');
  });
});

describe('ToolValidationError', () => {
  it('has code TOOL_VALIDATION_FAILED', () => {
    const error = new ToolValidationError('myTool', ['err']);
    expect(error.code).toBe('TOOL_VALIDATION_FAILED');
  });

  it('is not retryable', () => {
    const error = new ToolValidationError('myTool', ['err']);
    expect(error.retryable).toBe(false);
  });

  it('preserves toolName', () => {
    const error = new ToolValidationError('myTool', ['err']);
    expect(error.toolName).toBe('myTool');
  });

  it('preserves validationErrors', () => {
    const errors = ['field required', 'invalid format'];
    const error = new ToolValidationError('tool', errors);
    expect(error.validationErrors).toEqual(errors);
  });

  it('generates message with tool name', () => {
    const error = new ToolValidationError('myTool', ['err']);
    expect(error.message).toBe('Tool input validation failed: myTool');
  });
});

describe('ToolNotFoundError', () => {
  it('has code TOOL_NOT_FOUND', () => {
    const error = new ToolNotFoundError('unknownTool');
    expect(error.code).toBe('TOOL_NOT_FOUND');
  });

  it('is not retryable', () => {
    const error = new ToolNotFoundError('unknownTool');
    expect(error.retryable).toBe(false);
  });

  it('preserves toolName', () => {
    const error = new ToolNotFoundError('unknownTool');
    expect(error.toolName).toBe('unknownTool');
  });

  it('generates message with tool name', () => {
    const error = new ToolNotFoundError('unknownTool');
    expect(error.message).toBe('Tool not registered: unknownTool');
  });
});

// ── Context Error Blocks ────────────────────────────────────────

describe('ContextLoadError', () => {
  it('has code CONTEXT_LOAD_FAILED', () => {
    const error = new ContextLoadError('ctx-provider');
    expect(error.code).toBe('CONTEXT_LOAD_FAILED');
  });

  it('is retryable', () => {
    const error = new ContextLoadError('ctx-provider');
    expect(error.retryable).toBe(true);
  });

  it('preserves providerId', () => {
    const error = new ContextLoadError('ctx-provider');
    expect(error.providerId).toBe('ctx-provider');
  });

  it('generates message with providerId', () => {
    const error = new ContextLoadError('ctx-provider');
    expect(error.message).toBe('Context load failed: ctx-provider');
  });

  it('preserves cause', () => {
    const cause = new Error('connection refused');
    const error = new ContextLoadError('ctx-provider', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('ContextProviderError', () => {
  it('has code CONTEXT_PROVIDER_FAILED', () => {
    const error = new ContextProviderError('ctx-provider');
    expect(error.code).toBe('CONTEXT_PROVIDER_FAILED');
  });

  it('is retryable', () => {
    const error = new ContextProviderError('ctx-provider');
    expect(error.retryable).toBe(true);
  });

  it('preserves providerId', () => {
    const error = new ContextProviderError('ctx-provider');
    expect(error.providerId).toBe('ctx-provider');
  });

  it('generates message with providerId', () => {
    const error = new ContextProviderError('ctx-provider');
    expect(error.message).toBe('Context provider error: ctx-provider');
  });

  it('preserves cause', () => {
    const cause = new Error('business logic error');
    const error = new ContextProviderError('ctx-provider', cause);
    expect(error.cause).toBe(cause);
  });
});

// ── Memory Error Block ──────────────────────────────────────────

describe('MemorySaveError', () => {
  it('has code MEMORY_SAVE_FAILED', () => {
    const error = new MemorySaveError();
    expect(error.code).toBe('MEMORY_SAVE_FAILED');
  });

  it('is not retryable', () => {
    const error = new MemorySaveError();
    expect(error.retryable).toBe(false);
  });

  it('has default message', () => {
    const error = new MemorySaveError();
    expect(error.message).toBe('Memory save failed during finalization');
  });

  it('preserves cause when provided', () => {
    const cause = new Error('disk full');
    const error = new MemorySaveError(cause);
    expect(error.cause).toBe(cause);
  });

  it('has undefined cause when not provided', () => {
    const error = new MemorySaveError();
    expect(error.cause).toBeUndefined();
  });
});

// ── Policy Error Blocks ─────────────────────────────────────────

describe('MaxRetriesExceededError', () => {
  it('has code MAX_RETRIES_EXCEEDED', () => {
    const lastError = new ProviderTimeoutError('timeout');
    const error = new MaxRetriesExceededError(3, lastError);
    expect(error.code).toBe('MAX_RETRIES_EXCEEDED');
  });

  it('is not retryable', () => {
    const lastError = new ProviderTimeoutError('timeout');
    const error = new MaxRetriesExceededError(3, lastError);
    expect(error.retryable).toBe(false);
  });

  it('preserves attempts and lastError', () => {
    const lastError = new ProviderTimeoutError('timeout');
    const error = new MaxRetriesExceededError(3, lastError);
    expect(error.attempts).toBe(3);
    expect(error.lastError).toBe(lastError);
  });

  it('generates message with attempt count', () => {
    const lastError = new ProviderTimeoutError('timeout');
    const error = new MaxRetriesExceededError(3, lastError);
    expect(error.message).toBe('Max retries exceeded after 3 attempts');
  });
});

describe('MaxToolRoundsExceededError', () => {
  it('has code MAX_TOOL_ROUNDS_EXCEEDED', () => {
    const error = new MaxToolRoundsExceededError(5, 10);
    expect(error.code).toBe('MAX_TOOL_ROUNDS_EXCEEDED');
  });

  it('is not retryable', () => {
    const error = new MaxToolRoundsExceededError(5, 10);
    expect(error.retryable).toBe(false);
  });

  it('preserves rounds and maxRounds', () => {
    const error = new MaxToolRoundsExceededError(5, 10);
    expect(error.rounds).toBe(5);
    expect(error.maxRounds).toBe(10);
  });

  it('generates message with rounds and maxRounds', () => {
    const error = new MaxToolRoundsExceededError(5, 10);
    expect(error.message).toBe('Tool round limit exceeded: 5/10');
  });
});

describe('TokenLimitExceededError', () => {
  it('has code TOKEN_LIMIT_EXCEEDED', () => {
    const error = new TokenLimitExceededError('over limit');
    expect(error.code).toBe('TOKEN_LIMIT_EXCEEDED');
  });

  it('is not retryable', () => {
    const error = new TokenLimitExceededError('over limit');
    expect(error.retryable).toBe(false);
  });

  it('preserves message', () => {
    const error = new TokenLimitExceededError('custom token message');
    expect(error.message).toBe('custom token message');
  });

  it('preserves cause', () => {
    const cause = new Error('token counter overflow');
    const error = new TokenLimitExceededError('over limit', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('TimeoutExceededError', () => {
  it('has code TIMEOUT_EXCEEDED', () => {
    const error = new TimeoutExceededError(5000);
    expect(error.code).toBe('TIMEOUT_EXCEEDED');
  });

  it('is not retryable', () => {
    const error = new TimeoutExceededError(5000);
    expect(error.retryable).toBe(false);
  });

  it('preserves timeoutMs', () => {
    const error = new TimeoutExceededError(5000);
    expect(error.timeoutMs).toBe(5000);
  });

  it('generates message with timeoutMs', () => {
    const error = new TimeoutExceededError(5000);
    expect(error.message).toBe('Execution timed out after 5000ms');
  });
});

describe('FallbackExhaustedError', () => {
  it('has code FALLBACK_EXHAUSTED', () => {
    const primary = new ProviderTimeoutError('primary');
    const fallback = new ProviderTimeoutError('fallback');
    const error = new FallbackExhaustedError(primary, fallback);
    expect(error.code).toBe('FALLBACK_EXHAUSTED');
  });

  it('is not retryable', () => {
    const primary = new ProviderTimeoutError('primary');
    const fallback = new ProviderTimeoutError('fallback');
    const error = new FallbackExhaustedError(primary, fallback);
    expect(error.retryable).toBe(false);
  });

  it('preserves primaryError and fallbackError', () => {
    const primary = new ProviderTimeoutError('primary');
    const fallback = new ProviderTimeoutError('fallback');
    const error = new FallbackExhaustedError(primary, fallback);
    expect(error.primaryError).toBe(primary);
    expect(error.fallbackError).toBe(fallback);
  });

  it('generates message', () => {
    const primary = new ProviderTimeoutError('primary');
    const fallback = new ProviderTimeoutError('fallback');
    const error = new FallbackExhaustedError(primary, fallback);
    expect(error.message).toBe('Both primary and fallback providers failed');
  });
});

// ── Lifecycle Error Blocks ──────────────────────────────────────

describe('InvalidStateTransitionError', () => {
  it('has code INVALID_STATE_TRANSITION', () => {
    const error = new InvalidStateTransitionError('INITIALIZED', 'COMPLETED');
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('is not retryable', () => {
    const error = new InvalidStateTransitionError('INITIALIZED', 'COMPLETED');
    expect(error.retryable).toBe(false);
  });

  it('preserves from and to fields', () => {
    const error = new InvalidStateTransitionError('INITIALIZED', 'COMPLETED');
    expect(error.from).toBe('INITIALIZED');
    expect(error.to).toBe('COMPLETED');
  });

  it('accepts "any" for to field', () => {
    const error = new InvalidStateTransitionError('COMPLETED', 'any');
    expect(error.from).toBe('COMPLETED');
    expect(error.to).toBe('any');
  });

  it('generates message with from and to', () => {
    const error = new InvalidStateTransitionError('INITIALIZED', 'COMPLETED');
    expect(error.message).toBe('Invalid state transition: INITIALIZED → COMPLETED');
  });
});

describe('ConfigValidationError', () => {
  it('has code CONFIG_VALIDATION_FAILED', () => {
    const error = new ConfigValidationError(['err']);
    expect(error.code).toBe('CONFIG_VALIDATION_FAILED');
  });

  it('is not retryable', () => {
    const error = new ConfigValidationError(['err']);
    expect(error.retryable).toBe(false);
  });

  it('preserves single validation error', () => {
    const error = new ConfigValidationError(['field required']);
    expect(error.validationErrors).toEqual(['field required']);
  });

  it('preserves multiple validation errors', () => {
    const error = new ConfigValidationError(['field required', 'invalid type']);
    expect(error.validationErrors).toEqual(['field required', 'invalid type']);
  });

  it('generates message with joined errors', () => {
    const error = new ConfigValidationError(['err1', 'err2']);
    expect(error.message).toBe('Config validation failed: err1, err2');
  });
});

describe('PipelineInternalError', () => {
  it('has code PIPELINE_INTERNAL_ERROR', () => {
    const error = new PipelineInternalError('test');
    expect(error.code).toBe('PIPELINE_INTERNAL_ERROR');
  });

  it('is not retryable', () => {
    expect(isRetryable(new PipelineInternalError('test'))).toBe(false);
  });

  it('preserves message', () => {
    const error = new PipelineInternalError('internal pipeline error');
    expect(error.message).toBe('internal pipeline error');
  });
});

// ── Hook Error Block ────────────────────────────────────────────

describe('HookExecutionError', () => {
  it('has code HOOK_EXECUTION_FAILED', () => {
    const error = new HookExecutionError('hook failed');
    expect(error.code).toBe('HOOK_EXECUTION_FAILED');
  });

  it('is not retryable', () => {
    const error = new HookExecutionError('hook failed');
    expect(error.retryable).toBe(false);
  });

  it('preserves message', () => {
    const error = new HookExecutionError('custom hook error');
    expect(error.message).toBe('custom hook error');
  });

  it('preserves cause', () => {
    const cause = new Error('underlying');
    const error = new HookExecutionError('hook failed', cause);
    expect(error.cause).toBe(cause);
  });
});

// ── Cancellation Error Block ────────────────────────────────────

describe('RunCancelledError', () => {
  it('has code RUN_CANCELLED', () => {
    const error = new RunCancelledError();
    expect(error.code).toBe('RUN_CANCELLED');
  });

  it('is not retryable', () => {
    const error = new RunCancelledError();
    expect(error.retryable).toBe(false);
  });

  it('has default message', () => {
    const error = new RunCancelledError();
    expect(error.message).toBe('Run was cancelled');
  });
});
