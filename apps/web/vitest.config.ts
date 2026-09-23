import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // `import 'server-only'` throws outside the Next.js server bundle; tests use Next's no-op.
      {
        find: /^server-only$/,
        replacement: fromHere('./node_modules/next/dist/compiled/server-only/empty.js'),
      },
      { find: /^@\//, replacement: fromHere('./') },
    ],
  },
  test: {
    name: 'web',
    environment: 'node',
    include: ['{app,lib,components}/**/*.test.{ts,tsx}', '*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
  },
});
