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
  MaxRetriesExceededError,
  TokenLimitExceededError,
  TimeoutExceededError,
  FallbackExhaustedError,
  InvalidStateTransitionError,
  ConfigValidationError,
  PipelineInternalError,
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
});

describe('ProviderRateLimitError', () => {
  it('preserves retryAfterMs', () => {
    const error = new ProviderRateLimitError('rate limited', 5000);
    expect(error.retryAfterMs).toBe(5000);
  });
});

describe('InvalidStateTransitionError', () => {
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
});

describe('PipelineInternalError', () => {
  it('has code PIPELINE_INTERNAL_ERROR', () => {
    const error = new PipelineInternalError('test');
    expect(error.code).toBe('PIPELINE_INTERNAL_ERROR');
  });

  it('is not retryable', () => {
    expect(isRetryable(new PipelineInternalError('test'))).toBe(false);
  });
});

describe('MaxRetriesExceededError', () => {
  it('preserves attempts and lastError', () => {
    const lastError = new ProviderTimeoutError('timeout');
    const error = new MaxRetriesExceededError(3, lastError);
    expect(error.attempts).toBe(3);
    expect(error.lastError).toBe(lastError);
  });
});

describe('FallbackExhaustedError', () => {
  it('preserves primaryError and fallbackError', () => {
    const primary = new ProviderTimeoutError('primary');
    const fallback = new ProviderTimeoutError('fallback');
    const error = new FallbackExhaustedError(primary, fallback);
    expect(error.primaryError).toBe(primary);
    expect(error.fallbackError).toBe(fallback);
  });
});

describe('ToolValidationError', () => {
  it('preserves validationErrors', () => {
    const errors = ['field required', 'invalid format'];
    const error = new ToolValidationError('tool', errors);
    expect(error.validationErrors).toEqual(errors);
  });
});
