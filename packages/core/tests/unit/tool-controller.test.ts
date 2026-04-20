import { describe, it, expect, vi } from 'vitest';
import { ToolController } from '../../src/tool-controller.js';
import { ToolNotFoundError, ToolValidationError, ToolExecutionError } from '../../src/errors.js';
import type { Tool, ToolCall, ToolPolicy } from '../../src/interfaces.js';

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
  });

  describe('executeWithTimeout', () => {
    it('throws ToolExecutionError on timeout', async () => {
      const slowTool = createTool('slow', { type: 'object', properties: {} }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'done';
      });
      const tools = new Map([['slow', slowTool]]);
      const policy = createPolicy();
      policy.toolTimeoutMs = 10;
      const controller = new ToolController(tools, policy, createLogger());

      const toolCall: ToolCall = { id: '1', name: 'slow', input: {} };

      await expect(controller.executeRound([toolCall])).rejects.toThrow(ToolExecutionError);
    });
  });
});
