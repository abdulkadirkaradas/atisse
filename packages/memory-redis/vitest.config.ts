import { defineConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.config.js';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
