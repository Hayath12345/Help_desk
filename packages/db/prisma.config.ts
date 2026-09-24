import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer auto-loads .env; every app shares the repo-root .env. Node's own loader keeps
// variables that are already set (e.g. NODE_ENV from `pnpm db:seed`) and is skipped when there is
// no .env (CI, Docker builds). Not the `dotenv` package: its CLI would shadow dotenv-cli's
// `dotenv` binary that the db scripts use.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // process.env (not env()) so `prisma generate` works where DATABASE_URL is unset (CI, Docker build).
    url: process.env.DATABASE_URL,
  },
});
