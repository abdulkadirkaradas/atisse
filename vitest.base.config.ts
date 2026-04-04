import { defineConfig } from 'vitest/config';

export const baseConfig = defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
    }
  },
});