import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  splitting: false,
  clean: true,
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  tsconfig: 'tsconfig.json',
  external: ['vitest'],
});
