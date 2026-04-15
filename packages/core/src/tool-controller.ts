import type { Tool, ToolCall, ToolResult, ToolPolicy, Logger } from './interfaces.js';
import { ToolNotFoundError, ToolValidationError, ToolExecutionError } from './errors.js';
import { rejectAfter } from './policies.js';
import { z } from 'zod';

/**
 * Tool controller - Layer 2 controller.
 * Handles tool execution with validation and timeout enforcement.
 * Fail-fast: first failure stops the entire round, no partial results returned.
 */
export class ToolController {
  private readonly tools: Map<string, Tool>;
  private readonly policy: ToolPolicy;
  private readonly logger: Logger;

  constructor(tools: Map<string, Tool>, policy: ToolPolicy, logger: Logger) {
    this.tools = tools;
    this.policy = policy;
    this.logger = logger;
  }

  /**
   * Execute a round of tool calls with fail-fast behavior.
   * Stops on the first failure - no partial results returned.
   */
  async executeRound(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      this.logger.debug('Executing tool', { toolName: toolCall.name, toolId: toolCall.id });

      // Step 1: Look up tool - not found is FATAL
      const tool = this.tools.get(toolCall.name);
      if (!tool) {
        this.logger.error('Tool not found', { toolName: toolCall.name });
        throw new ToolNotFoundError(toolCall.name);
      }

      // Step 2: Validate input - validation failure is FATAL
      const validatedInput = this.validateInput(toolCall.name, toolCall.input, tool.inputSchema);

      // Step 3: Execute with timeout - timeout or error is RETRYABLE
      try {
        const output = await this.executeWithTimeout(tool, validatedInput);
        results.push({
          id: toolCall.id,
          name: toolCall.name,
          output,
        });
        this.logger.debug('Tool executed successfully', {
          toolName: toolCall.name,
          toolId: toolCall.id,
        });
      } catch (error: unknown) {
        this.logger.error('Tool execution failed', {
          toolName: toolCall.name,
          toolId: toolCall.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Wrap any error in ToolExecutionError - preserves cause for retry logic
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new ToolExecutionError(toolCall.name, cause);
      }
    }

    return results;
  }

  /**
   * Validate tool input against its JSON schema using Zod.
   * @throws ToolValidationError when validation fails - FATAL, no retry
   */
  private validateInput(
    toolName: string,
    input: unknown,
    schema: Record<string, unknown>,
  ): unknown {
    try {
      // Convert JSON Schema object to Zod schema
      const zodSchema = this.jsonSchemaToZod(schema);
      const result = zodSchema.safeParse(input);

      if (!result.success) {
        const errors = result.error.issues.map((issue) => {
          const path = issue.path.join('.');
          return path ? `${path}: ${issue.message}` : issue.message;
        });
        this.logger.warn('Tool input validation failed', { toolName, errors });
        throw new ToolValidationError(toolName, errors);
      }

      return result.data;
    } catch (error) {
      // Re-throw ToolValidationError as-is, wrap others
      if (error instanceof ToolValidationError) {
        throw error;
      }
      // This shouldn't happen since safeParse is used, but handle defensively
      const message = error instanceof Error ? error.message : 'Unknown validation error';
      throw new ToolValidationError(toolName, [message]);
    }
  }

  /**
   * Execute a tool with timeout enforcement.
   * @throws ToolExecutionError when timeout occurs or execution fails - RETRYABLE
   */
  private async executeWithTimeout(tool: Tool, input: unknown): Promise<unknown> {
    try {
      return await Promise.race([tool.execute(input), rejectAfter(this.policy.toolTimeoutMs)]);
    } catch (error: unknown) {
      // Check if it's a timeout error
      if (error instanceof Error && error.message.includes('timed out')) {
        throw new ToolExecutionError(tool.name, new Error('Tool execution timed out'));
      }
      // Re-throw as-is (will be wrapped in executeRound with context)
      throw error;
    }
  }

  /**
   * Convert a JSON Schema object to a Zod schema for runtime validation.
   * Supports a subset of JSON Schema sufficient for tool input validation.
   */
  private jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType<unknown> {
    // Handle basic object schema
    if (schema.type === 'object' && schema.properties) {
      const properties = schema.properties as Record<string, Record<string, unknown>>;

      const zodProperties: Record<string, z.ZodType<unknown>> = {};

      for (const [key, propSchema] of Object.entries(properties)) {
        zodProperties[key] = this.jsonSchemaToZod(propSchema);
      }

      return z.strictObject(zodProperties);
    }

    // Handle string type
    if (schema.type === 'string') {
      if (schema.enum) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      let stringSchema: z.ZodString = z.string();
      if (schema.minLength !== undefined) {
        stringSchema = stringSchema.min(schema.minLength as number);
      }
      if (schema.maxLength !== undefined) {
        stringSchema = stringSchema.max(schema.maxLength as number);
      }
      return stringSchema;
    }

    // Handle number type
    if (schema.type === 'number' || schema.type === 'integer') {
      let numberSchema: z.ZodNumber = schema.type === 'integer' ? z.number().int() : z.number();
      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum as number);
      }
      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum as number);
      }
      return numberSchema;
    }

    // Handle boolean type
    if (schema.type === 'boolean') {
      return z.boolean();
    }

    // Handle array type
    if (schema.type === 'array' && schema.items) {
      return z.array(this.jsonSchemaToZod(schema.items as Record<string, unknown>));
    }

    // Handle null type
    if (schema.type === 'null') {
      return z.null();
    }

    // Fallback: allow any value (shouldn't reach here for valid tool schemas)
    return z.any();
  }
}
