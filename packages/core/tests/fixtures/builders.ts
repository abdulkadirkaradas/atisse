import type { OrchestratorConfig, OrchestratorProfile, Tool } from '../../src/interfaces.js';
import { MockProvider } from '../../src/testing/mock-provider.js';

export const buildConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  provider: new MockProvider(),
  retry: { maxAttempts: 1, baseDelayMs: 0, jitter: false },
  ...overrides,
});

export const buildTool = (overrides?: Partial<Tool>): Tool => ({
  name: 'test-tool',
  description: 'Test tool',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    return input;
  },
  ...overrides,
});

export const buildProfile = (overrides?: Partial<OrchestratorProfile>): OrchestratorProfile => ({
  name: 'test-profile',
  ...overrides,
});
