import type { Tool, ToolCall, ToolResult, ToolPolicy, Logger } from './interfaces.js';
import {
  ToolNotFoundError,
  ToolValidationError,
  ToolExecutionError,
  OrchestratorError,
  TimeoutExceededError,
} from './errors.js';
import { withTimeout } from './policies.js';
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
        // Timeout errors are retryable — wrap in ToolExecutionError
        if (error instanceof TimeoutExceededError) {
          throw new ToolExecutionError(toolCall.name, error);
        }
        // Already a typed OrchestratorError — propagate as-is (preserves retryability)
        if (error instanceof OrchestratorError) {
          throw error;
        }
        // Unknown errors — wrap as retryable for safety
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
   * Errors propagate to executeRound for wrapping decisions.
   */
  private async executeWithTimeout(tool: Tool, input: unknown): Promise<unknown> {
    return withTimeout(tool.execute(input), this.policy.toolTimeoutMs);
  }

  /**
   * Convert JSON Schema object type to Zod strict object schema.
   * Honors the `required` array — properties not listed are wrapped in `.optional()`.
   * When `properties` is absent, returns `z.strictObject({})`.
   */
  private zodFromObject(schema: Record<string, unknown>): z.ZodType<unknown> {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const zodProperties: Record<string, z.ZodType<unknown>> = {};

    if (properties) {
      const requiredFields = Array.isArray(schema.required) ? (schema.required as string[]) : [];

      for (const [key, propSchema] of Object.entries(properties)) {
        let zodProp = this.jsonSchemaToZod(propSchema);
        if (!requiredFields.includes(key)) {
          zodProp = zodProp.optional();
        }
        zodProperties[key] = zodProp;
      }
    }

    return z.strictObject(zodProperties);
  }

  /**
   * Convert JSON Schema enum to Zod enum.
   * Returns null if schema has no enum or if enum is invalid.
   */
  private zodFromEnum(schema: Record<string, unknown>): z.ZodType<unknown> | null {
    if (!Array.isArray(schema.enum)) return null;
    if (schema.enum.length === 0) return null;
    if (!schema.enum.every((v) => typeof v === 'string')) return null;

    return z.enum(schema.enum as [string, ...string[]]);
  }

  /**
   * Convert JSON Schema string type to Zod string schema.
   * Supports enum, minLength, and maxLength constraints.
   */
  private zodFromString(schema: Record<string, unknown>): z.ZodType<unknown> {
    // Enum — requires at least one string value
    const enumResult = this.zodFromEnum(schema);
    if (enumResult) return enumResult;

    let stringSchema: z.ZodString = z.string();

    if (typeof schema.minLength === 'number' && Number.isFinite(schema.minLength)) {
      stringSchema = stringSchema.min(schema.minLength);
    }

    if (typeof schema.maxLength === 'number' && Number.isFinite(schema.maxLength)) {
      stringSchema = stringSchema.max(schema.maxLength);
    }

    return stringSchema;
  }

  /**
   * Convert JSON Schema number/integer type to Zod number schema.
   * Supports minimum and maximum constraints.
   */
  private zodFromNumber(schema: Record<string, unknown>): z.ZodType<unknown> {
    const isInteger = schema.type === 'integer';
    let numberSchema: z.ZodNumber = isInteger ? z.number().int() : z.number();

    if (typeof schema.minimum === 'number' && Number.isFinite(schema.minimum)) {
      numberSchema = numberSchema.min(schema.minimum);
    }

    if (typeof schema.maximum === 'number' && Number.isFinite(schema.maximum)) {
      numberSchema = numberSchema.max(schema.maximum);
    }

    return numberSchema;
  }

  /**
   * Convert JSON Schema array type to Zod array schema.
   */
  private zodFromArray(schema: Record<string, unknown>): z.ZodType<unknown> {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      return z.array(this.jsonSchemaToZod(items));
    }
    this.logger.warn('Array schema without items — array elements are unvalidated');
    return z.array(z.unknown());
  }

  /**
   * Convert JSON Schema composition keywords (anyOf, oneOf, allOf) to Zod schemas.
   * Returns null when no composition keyword is present.
   */
  private zodFromComposition(schema: Record<string, unknown>): z.ZodType<unknown> | null {
    // anyOf → z.union([...])
    const anyOf = this.zodFromUnion(schema, 'anyOf');
    if (anyOf) return anyOf;

    // oneOf → z.union([...])
    const oneOf = this.zodFromUnion(schema, 'oneOf');
    if (oneOf) return oneOf;

    // allOf → z.intersection(...)
    const allOf = this.zodFromIntersection(schema);
    if (allOf) return allOf;

    return null;
  }

  /**
   * Convert JSON Schema anyOf/oneOf to a Zod union.
   */
  private zodFromUnion(
    schema: Record<string, unknown>,
    key: 'anyOf' | 'oneOf',
  ): z.ZodType<unknown> | null {
    const items = schema[key];
    if (!Array.isArray(items) || items.length === 0) return null;

    const zodSchemas = (items as Record<string, unknown>[]).map((item) =>
      this.jsonSchemaToZod(item),
    );

    // z.union with a single element works at runtime (returns the schema directly)
    return z.union(zodSchemas as [z.ZodType<unknown>, z.ZodType<unknown>, ...z.ZodType<unknown>[]]);
  }

  /**
   * Convert JSON Schema allOf to a Zod intersection.
   */
  private zodFromIntersection(schema: Record<string, unknown>): z.ZodType<unknown> | null {
    const items = schema.allOf;
    if (!Array.isArray(items) || items.length === 0) return null;

    const zodSchemas = (items as Record<string, unknown>[]).map((item) =>
      this.jsonSchemaToZod(item),
    );

    // Reduce intersection: schema1 & schema2 & schema3 ...
    return zodSchemas.reduce((acc, subSchema) => z.intersection(acc, subSchema));
  }

  /**
   * Convert a JSON Schema object to a Zod schema for runtime validation.
   * Supports a subset of JSON Schema sufficient for tool input validation.
   * Composition keywords (anyOf, oneOf, allOf) are checked first, then type dispatch.
   */
  private jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType<unknown> {
    // Check composition keywords first (they may appear without a top-level type)
    const compositionResult = this.zodFromComposition(schema);
    if (compositionResult) return compositionResult;

    const typeName = typeof schema.type === 'string' ? schema.type : '';

    if (typeName === 'object') return this.zodFromObject(schema);
    if (typeName === 'string') return this.zodFromString(schema);
    if (typeName === 'number') return this.zodFromNumber(schema);
    if (typeName === 'integer') return this.zodFromNumber(schema);
    if (typeName === 'boolean') return z.boolean();
    if (typeName === 'array') return this.zodFromArray(schema);
    if (typeName === 'null') return z.null();

    // Unrecognized or absent type — reject all input instead of silently accepting
    this.logger.warn('Unsupported JSON Schema type — rejecting all input', {
      schemaType: schema.type,
    });
    return z.never();
  }
}
