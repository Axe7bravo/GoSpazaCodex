import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
import next from 'eslint-config-next/core-web-vitals';

export default [
  { ignores: ['**/node_modules/**', '**/.next/**', '**/.medusa/**', '**/dist/**', '**/coverage/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  ...next.map((config) => ({ ...config, files: ['apps/{customer,merchant,driver,admin}/**/*.{ts,tsx,js,mjs}'] })),
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  { settings: { next: { rootDir: ['apps/customer', 'apps/merchant', 'apps/driver', 'apps/admin'] } } },
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
];

