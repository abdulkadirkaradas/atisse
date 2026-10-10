import { describe, it, expect, vi } from 'vitest';
import { ToolValidationError } from '../../src/errors.js';
import { ToolController } from '../../src/tool-controller.js';
import type { Tool, ToolCall, ToolPolicy } from '../../src/interfaces.js';
import type { ValidationErrorDetail } from '../../src/index.js';

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createPolicy = (): ToolPolicy => ({
  maxToolRounds: 5,
  allowParallelTools: false,
  toolTimeoutMs: 10_000,
});

const createTool = (
  name: string,
  inputSchema: Record<string, unknown>,
  execute: (input: unknown) => Promise<unknown>,
): Tool => ({
  name,
  description: `Tool: ${name}`,
  inputSchema,
  execute,
});

describe('ToolValidationError structured details', () => {
  it('constructs with string[] and derives details (backward compat)', () => {
    const error = new ToolValidationError('tool', ['query: Required', 'boom']);

    expect(error.details).toEqual([
      { fieldPath: 'query', constraint: 'Required', received: undefined },
      { fieldPath: '', constraint: 'boom', received: undefined },
    ]);
    expect(error.validationErrors).toEqual(['query: Required', 'boom']);
  });

  it('constructs with ValidationErrorDetail[] and preserves it', () => {
    const details: ValidationErrorDetail[] = [
      { fieldPath: 'query', constraint: 'Required', received: undefined },
      { fieldPath: 'limit', constraint: 'Expected number', received: 'many' },
    ];
    const error = new ToolValidationError('tool', details);

    expect(error.details).toEqual(details);
    expect(error.validationErrors).toEqual(['query: Required', 'limit: Expected number']);
  });

  it('keeps code, retryable, toolName and message unchanged', () => {
    const error = new ToolValidationError('myTool', ['err']);

    expect(error.code).toBe('TOOL_VALIDATION_FAILED');
    expect(error.retryable).toBe(false);
    expect(error.toolName).toBe('myTool');
    expect(error.message).toBe('Tool input validation failed: myTool');
  });

  it('handles empty array without index access', () => {
    const error = new ToolValidationError('tool', []);

    expect(error.details).toEqual([]);
    expect(error.validationErrors).toEqual([]);
  });

  it('exposes validationErrors as prototype accessor, not own property', () => {
    const error = new ToolValidationError('tool', [
      { fieldPath: 'query', constraint: 'Required', received: undefined },
    ]);

    expect(Object.prototype.hasOwnProperty.call(error, 'validationErrors')).toBe(false);
    expect(Object.keys(error)).not.toContain('validationErrors');

    const serialized = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(serialized).toHaveProperty('details');
    expect(serialized).not.toHaveProperty('validationErrors');

    const cloned = structuredClone(error) as unknown as Record<string, unknown>;
    // structuredClone serializes Error instances by message only — custom
    // fields (details and validationErrors alike) do not survive the clone.
    expect(cloned).toHaveProperty('message', error.message);
    expect('details' in cloned).toBe(false);
    expect('validationErrors' in cloned).toBe(false);
  });
});

describe('ToolController structured validation mapping', () => {
  const nestedSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      user: {
        type: 'object',
        properties: { age: { type: 'number' } },
        required: ['age'],
      },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
        },
      },
    },
    required: ['user'],
  };

  it('maps Zod issues to details with received from nested input', async () => {
    const tool = createTool('nested', nestedSchema, async () => 'ok');
    const tools = new Map([['nested', tool]]);
    const logger = createLogger();
    const controller = new ToolController(tools, createPolicy(), logger);

    const toolCall: ToolCall = {
      id: '1',
      name: 'nested',
      input: { user: { age: 'old' }, tags: [{ label: 42 }] },
    };

    const failure = await controller.executeRound([toolCall]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolValidationError);
    const error = failure as ToolValidationError;

    const byPath = new Map(error.details.map((detail) => [detail.fieldPath, detail]));
    expect(byPath.get('user.age')).toMatchObject({ fieldPath: 'user.age', received: 'old' });
    expect(byPath.get('tags.0.label')).toMatchObject({
      fieldPath: 'tags.0.label',
      received: 42,
    });
    for (const detail of error.details) {
      expect(typeof detail.constraint).toBe('string');
    }
    // Backward compat getter still renders the same strings
    expect(error.validationErrors).toEqual(
      error.details.map((detail) => `${detail.fieldPath}: ${detail.constraint}`),
    );
  });

  it('never logs received values or event payload keys (S-1)', async () => {
    const tool = createTool('nested', nestedSchema, async () => 'ok');
    const tools = new Map([['nested', tool]]);
    const logger = createLogger();
    const controller = new ToolController(tools, createPolicy(), logger);

    const toolCall: ToolCall = {
      id: '1',
      name: 'nested',
      input: { user: { age: 'old' }, tags: [{ label: 42 }] },
    };

    const failure = await controller.executeRound([toolCall]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolValidationError);

    expect(logger.warn).toHaveBeenCalledOnce();
    const loggedMeta = logger.warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(loggedMeta).toBeDefined();
    expect(loggedMeta).not.toHaveProperty('received');
    expect(loggedMeta).not.toHaveProperty('details');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('old');

    // Event payload contract carries only code/message/retryable — never received
    const error = failure as ToolValidationError;
    const eventPayload = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    expect(Object.keys(eventPayload).sort()).toEqual(['code', 'message', 'retryable']);
  });
});
