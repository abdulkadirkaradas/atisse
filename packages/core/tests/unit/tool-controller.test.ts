import { describe, it, expect, vi } from 'vitest';
import { ToolController } from '../../src/tool-controller.js';
import { ToolNotFoundError, ToolValidationError, ToolExecutionError, TimeoutExceededError } from '../../src/errors.js';
import type { Tool, ToolCall, ToolPolicy } from '../../src/interfaces.js';
import { validationFailTool } from '../fixtures/mock-tools.js';

describe('ToolController', () => {
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

  describe('executeRound()', () => {
    it('throws ToolNotFoundError when tool not found - FATAL', async () => {
      const tools = new Map<string, Tool>();
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'unknown-tool', input: {} };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolNotFoundError);
    });

    it('throws ToolValidationError when schema validation fails - FATAL', async () => {
      const tool = createTool(
        'validator',
        { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        async () => 'ok',
      );
      const tools = new Map([['validator', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'validator', input: { x: 123 } };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('throws ToolExecutionError when execute throws - RETRYABLE', async () => {
      const tool = createTool('failing', { type: 'object', properties: {} }, async () => {
        throw new Error('execute failed');
      });
      const tools = new Map([['failing', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'failing', input: {} };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolExecutionError);
    });

    it('returns ToolResult with output on success', async () => {
      const tool = createTool(
        'echo',
        { type: 'object', properties: { value: { type: 'string' } } },
        async (input) => input,
      );
      const tools = new Map([['echo', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: 'call-1', name: 'echo', input: { value: 'test' } };

      const results = await controller.executeRound([toolCall]);

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('call-1');
      expect(results[0]!.name).toBe('echo');
      expect(results[0]!.output).toEqual({ value: 'test' });
      expect(results[0]!.error).toBeUndefined();
    });

    it('fail-fast: first tool failure stops entire round', async () => {
      const firstTool = createTool('first', { type: 'object', properties: {} }, async () => {
        throw new Error('first failed');
      });
      const secondTool = createTool(
        'second',
        { type: 'object', properties: {} },
        async () => 'never called',
      );
      const tools = new Map([
        ['first', firstTool],
        ['second', secondTool],
      ]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCalls: ToolCall[] = [
        { id: '1', name: 'first', input: {} },
        { id: '2', name: 'second', input: {} },
      ];

      await expect(controller.executeRound(toolCalls)).rejects.toThrow(ToolExecutionError);
    });

    it('returns only output arm (not error arm) for successful results', async () => {
      const tool = createTool(
        'success',
        { type: 'object', properties: { x: { type: 'string' } } },
        async () => 'result',
      );
      const tools = new Map([['success', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'success', input: { x: 'y' } };
      const results = await controller.executeRound([toolCall]);

      expect(results[0]!.output).toBe('result');
    });

    it('rejects string not in enum - FATAL', async () => {
      const tool = createTool(
        'string-enum',
        { type: 'string', enum: ['a', 'b'] },
        async (input) => input,
      );
      const tools = new Map([['string-enum', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'string-enum', input: 'c' };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects string violating minLength/maxLength - FATAL', async () => {
      const tool = createTool(
        'string-length',
        { type: 'string', minLength: 2, maxLength: 5 },
        async (input) => input,
      );
      const tools = new Map([['string-length', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'string-length', input: 'x' };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects non-number input for number type - FATAL', async () => {
      const tool = createTool('num', { type: 'number' }, async (input) => input);
      const tools = new Map([['num', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'num', input: 'abc' };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects float for integer type - FATAL', async () => {
      const tool = createTool('int', { type: 'integer' }, async (input) => input);
      const tools = new Map([['int', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'int', input: 1.5 };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects number outside min/max range - FATAL', async () => {
      const tool = createTool(
        'ranged',
        { type: 'number', minimum: 0, maximum: 100 },
        async (input) => input,
      );
      const tools = new Map([['ranged', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'ranged', input: -1 };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects non-boolean for boolean type - FATAL', async () => {
      const tool = createTool('bool', { type: 'boolean' }, async (input) => input);
      const tools = new Map([['bool', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'bool', input: 'true' };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects array with wrong item types - FATAL', async () => {
      const tool = createTool(
        'arr',
        { type: 'array', items: { type: 'string' } },
        async (input) => input,
      );
      const tools = new Map([['arr', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'arr', input: [1, 2] };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('accepts any array when items constraint is absent', async () => {
      const tool = createTool('arr-any', { type: 'array' }, async (input) => input);
      const tools = new Map([['arr-any', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'arr-any', input: [1, 'a', null] };

      const results = await controller.executeRound([toolCall]);
      expect(results).toHaveLength(1);
      expect(results[0]!.output).toEqual([1, 'a', null]);
    });

    it('rejects non-null for null type - FATAL', async () => {
      const tool = createTool('null-type', { type: 'null' }, async (input) => input);
      const tools = new Map([['null-type', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'null-type', input: 'x' };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects input not matching any anyOf branch - FATAL', async () => {
      const tool = createTool(
        'anyof',
        { anyOf: [{ type: 'string' }, { type: 'number' }] },
        async (input) => input,
      );
      const tools = new Map([['anyof', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'anyof', input: true };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects partial allOf intersection - FATAL', async () => {
      const tool = createTool(
        'allof',
        {
          allOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' }, b: { type: 'number' } },
              required: ['a'],
            },
            {
              type: 'object',
              properties: { a: { type: 'string' }, b: { type: 'number' } },
              required: ['b'],
            },
          ],
        },
        async (input) => input,
      );
      const tools = new Map([['allof', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      // Satisfies first schema (has 'a') but not second (missing 'b')
      const toolCall: ToolCall = { id: '1', name: 'allof', input: { a: 'hello' } };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('accepts full allOf intersection match', async () => {
      const tool = createTool(
        'allof-ok',
        {
          allOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' }, b: { type: 'number' } },
              required: ['a'],
            },
            {
              type: 'object',
              properties: { a: { type: 'string' }, b: { type: 'number' } },
              required: ['b'],
            },
          ],
        },
        async (input) => input,
      );
      const tools = new Map([['allof-ok', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'allof-ok', input: { a: 'hello', b: 42 } };

      const results = await controller.executeRound([toolCall]);
      expect(results).toHaveLength(1);
      expect(results[0]!.output).toEqual({ a: 'hello', b: 42 });
    });

    it('accepts object with optional fields absent (no required array)', async () => {
      const tool = createTool(
        'optional',
        { type: 'object', properties: { x: { type: 'string' } } },
        async (input) => input,
      );
      const tools = new Map([['optional', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'optional', input: {} };

      const results = await controller.executeRound([toolCall]);
      expect(results).toHaveLength(1);
      expect(results[0]!.output).toEqual({});
    });

    it('rejects input against unrecognized type schema - FATAL', async () => {
      const tool = createTool('custom', { type: 'custom' }, async (input) => input);
      const tools = new Map([['custom', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'custom', input: 'anything' };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('rejects all input when inputSchema is empty object - FATAL (security boundary)', async () => {
      const tool = createTool('empty-schema', {}, async (input) => input);
      const tools = new Map([['empty-schema', tool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      const toolCall: ToolCall = { id: '1', name: 'empty-schema', input: 'anything' };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
    });

    it('propagates OrchestratorError from tool.execute() as-is, not wrapped', async () => {
      const tools = new Map([['validation-fail-tool', validationFailTool]]);
      const controller = new ToolController(tools, createPolicy(), createLogger());

      // validationFailTool has schema that requires { input: string } and throws ToolValidationError
      const toolCall: ToolCall = { id: '1', name: 'validation-fail-tool', input: { input: 'ok' } };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolValidationError);
      // If the OrchestratorError were wrapped it would be ToolExecutionError — verify it's not
      await expect(controller.executeRound([toolCall])).rejects.not.toThrow(ToolExecutionError);
    });
  });

  describe('executeWithTimeout', () => {
    it('throws ToolExecutionError on timeout with TimeoutExceededError as cause', async () => {
      const slowTool = createTool('slow', { type: 'object', properties: {} }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'done';
      });
      const tools = new Map([['slow', slowTool]]);
      const policy = createPolicy();
      policy.toolTimeoutMs = 10;
      const controller = new ToolController(tools, policy, createLogger());

      const toolCall: ToolCall = { id: '1', name: 'slow', input: {} };

      let error: unknown;
      try {
        await controller.executeRound([toolCall]);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect((error as ToolExecutionError).cause).toBeInstanceOf(TimeoutExceededError);
    });
  });
});
