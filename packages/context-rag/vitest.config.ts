import { defineConfig } from 'vitest/config';
import { baseConfig, baseCoverage } from '../../vitest.base.config.js';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      ...baseCoverage,
      thresholds: { lines: 50 },
    },
  },
});
