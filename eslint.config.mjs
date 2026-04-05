import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['**/*.config.ts'],
  },
  {
    files: ['**/src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
      // Node.js globals - AbortSignal is available in Node 15+
      globals: {
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        Promise: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        Symbol: 'readonly',
        Array: 'readonly',
        Object: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Boolean: 'readonly',
        JSON: 'readonly',
        Math: 'readonly',
        Date: 'readonly',
        Error: 'readonly',
        RangeError: 'readonly',
        TypeError: 'readonly',
        ReferenceError: 'readonly',
        SyntaxError: 'readonly',
        URIError: 'readonly',
        AggregateError: 'readonly',
        encodeURI: 'readonly',
        decodeURI: 'readonly',
        encodeURIComponent: 'readonly',
        decodeURIComponent: 'readonly',
        isNaN: 'readonly',
        isFinite: 'readonly',
        parseInt: 'readonly',
        parseFloat: 'readonly',
        eval: 'readonly',
        globalThis: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...tseslint.configs['recommended-type-checked'].rules,
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  prettier,
];
