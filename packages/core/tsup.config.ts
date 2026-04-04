import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'testing/mock-provider': 'src/testing/mock-provider.ts',
  },
  splitting: false,
  clean: true,
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  tsconfig: 'tsconfig.json',
});
