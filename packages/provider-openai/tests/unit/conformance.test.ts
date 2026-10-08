import { runProviderConformanceTests } from '@atisse/core/testing';

import { OpenAIProvider } from '../../src/index.js';

runProviderConformanceTests('OpenAIProvider', () => new OpenAIProvider({ apiKey: 'test-key' }));
