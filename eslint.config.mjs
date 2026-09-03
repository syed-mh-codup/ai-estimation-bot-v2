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
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      // Prisma's emitted client — machine-written, not ours to lint.
      '**/src/generated/**',
      // Local agent-harness config, all of it gitignored and none of it ours:
      // graft drops a hooks/statusline .cjs into several of these. They are
      // CommonJS with Node globals, so they fell through to bare
      // js.configs.recommended and reported `process` as undefined — 14 errors
      // that made `pnpm lint` useless as a signal locally. CI never saw them
      // (clean checkout), which is the worst version of the problem: red for
      // you, green for everyone else.
      '**/.claude/**',
      '**/.commandcode/**',
      '**/.cursor/**',
      '**/.gemini/**',
      '**/.kiro/**',
    ],
  },
];
