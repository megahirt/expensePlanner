// Flat config (eslint 10). Replaces the former .eslintrc.cjs.
//
// Linting is scoped to TypeScript sources only — the same surface the old
// `--ext .ts,.tsx` covered — so the Node scripts in scripts/*.mjs and the
// generated dist/ are left alone rather than being checked with browser globals.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'release/'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      // Ported verbatim from the previous config.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
