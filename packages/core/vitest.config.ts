import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { baseConfig } from '../../vitest.base.config.js';

export default defineConfig({
  ...baseConfig,
  plugins: [tsconfigPaths()],
  test: {
    ...baseConfig.test,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
