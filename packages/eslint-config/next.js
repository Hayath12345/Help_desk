import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';
import loons from './plugin.js';

/** Flat config for the Next.js app: Next rules + design-token / RTL guards. */
export default [
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...nextVitals,
  ...nextTs,
  {
    plugins: { loons },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    rules: {
      'loons/no-physical-direction-classes': 'error',
      'loons/no-hex-colors': 'error',
    },
  },
  prettier,
];
