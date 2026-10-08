import { runProviderConformanceTests } from '@atisse/core/testing';

import { AnthropicProvider } from '../../src/index.js';

runProviderConformanceTests(
  'AnthropicProvider',
  () => new AnthropicProvider({ apiKey: 'test-key' }),
);
