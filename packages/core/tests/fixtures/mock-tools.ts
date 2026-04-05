import type { Tool } from '../../src/interfaces.js';
import { ToolExecutionError, ToolValidationError } from '../../src/errors.js';

export const echoTool: Tool = {
  name: 'echo',
  description: 'Returns the input unchanged',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    return input;
  },
};

export const failingTool: Tool = {
  name: 'failing-tool',
  description: 'Always fails with ToolExecutionError',
  inputSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  },
  async execute() {
    throw new ToolExecutionError('failing-tool', new Error('simulated failure'));
  },
};

export const validationFailTool: Tool = {
  name: 'validation-fail-tool',
  description: 'Always fails with ToolValidationError',
  inputSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  },
  async execute() {
    throw new ToolValidationError('validation-fail-tool', ['schema mismatch']);
  },
};

export const createSlowTool = (delayMs: number): Tool => ({
  name: 'slow-tool',
  description: `Resolves after ${delayMs}ms delay`,
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return input;
  },
});
