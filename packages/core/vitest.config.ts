import { defineConfig } from 'vitest/config';
import { baseConfig, baseCoverage } from '../../vitest.base.config.js';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    coverage: {
      ...baseCoverage,
      thresholds: {
        lines: 70,
        branches: 70,
      },
    },
  },
  cacheDir: '../../.vite/core',
});
