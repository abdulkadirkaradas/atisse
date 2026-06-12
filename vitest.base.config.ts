import { defineConfig } from 'vitest/config';

export const baseCoverage = {
  provider: 'v8' as const,
  reporter: ['text', 'html', 'json-summary'],
  thresholds: {
    lines: 60,
  },
};

export const baseConfig = defineConfig({
  test: {
    passWithNoTests: true,
    coverage: baseCoverage,
  },
});