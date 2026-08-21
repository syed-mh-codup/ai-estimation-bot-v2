import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'apps/*/src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript already resolves identifiers (incl. DOM/Node lib globals like
      // React, process, Request). core's no-undef doesn't understand them and
      // reports false positives — typescript-eslint recommends disabling it.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Root-level ESM scripts. Without this block they match no `files` glob, so
    // they fall through to bare js.configs.recommended — which leaves `no-undef`
    // on with no globals declared, and reported `process` and `console` as
    // undefined. They are real code, so lint them properly rather than ignore
    // them.
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    // src/generated is Prisma's emitted client — machine-written, not ours to lint.
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/src/generated/**'],
  },
];
