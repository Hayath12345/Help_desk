import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PEER_LINKS_TO_DROP, pruneStore } from './prune-store.ts';

let root: string;
const store = () => join(root, 'node_modules', '.pnpm');

/** A package folder in the virtual store with one file. */
function pkg(id: string, name: string): string {
  const dir = join(store(), id, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), 'module.exports = 1');
  return dir;
}
/** A directory link (junction on Windows, which needs no privilege). */
function link(from: string, to: string): void {
  mkdirSync(dirname(from), { recursive: true });
  symlinkSync(to, from, 'junction');
}
const exists = (id: string) => existsSync(join(store(), id));
const gone = (path: string) => lstatSync(path, { throwIfNoEntry: false }) === undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loons-prune-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { fastify: '5', '@prisma/client': '7' } }),
  );
  // Direct dependencies of the deployed app.
  link(join(root, 'node_modules', 'fastify'), pkg('fastify@5', 'fastify'));
  link(
    join(root, 'node_modules', '@prisma', 'client'),
    pkg('@prisma+client@7_peers', '@prisma/client'),
  );
  // fastify <-> pino depend on each other (cycles must not hang the walk).
  link(join(store(), 'fastify@5', 'node_modules', 'pino'), pkg('pino@10', 'pino'));
  link(
    join(store(), 'pino@10', 'node_modules', 'fastify'),
    join(store(), 'fastify@5', 'node_modules', 'fastify'),
  );
  // @prisma/client and its real runtime dependency, plus the two peers pnpm resolved from the workspace.
  link(
    join(store(), '@prisma+client@7_peers', 'node_modules', '@prisma', 'client-runtime-utils'),
    pkg('@prisma+client-runtime-utils@7', '@prisma/client-runtime-utils'),
  );
  link(
    join(store(), '@prisma+client@7_peers', 'node_modules', 'prisma'),
    pkg('prisma@7_deadbeef', 'prisma'),
  );
  link(
    join(store(), '@prisma+client@7_peers', 'node_modules', 'typescript'),
    pkg('typescript@6', 'typescript'),
  );
  // What only the CLI needs.
  link(join(store(), 'prisma@7_deadbeef', 'node_modules', 'effect'), pkg('effect@3', 'effect'));
  link(
    join(store(), 'prisma@7_deadbeef', 'node_modules', 'typescript'),
    join(store(), 'typescript@6', 'node_modules', 'typescript'),
  );
  // pnpm's hoisted links, and .bin entries: a shim that names a folder in the store and a symlink.
  link(
    join(store(), 'node_modules', 'effect'),
    join(store(), 'effect@3', 'node_modules', 'effect'),
  );
  link(join(store(), 'node_modules', 'pino'), join(store(), 'pino@10', 'node_modules', 'pino'));
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '.bin', 'prisma'),
    '#!/bin/sh\nexec node "$basedir/../.pnpm/prisma@7_deadbeef/node_modules/prisma/index.js" "$@"\n',
  );
  writeFileSync(
    join(root, 'node_modules', '.bin', 'fastify'),
    '#!/bin/sh\nexec node "$basedir/../.pnpm/fastify@5/node_modules/fastify/index.js" "$@"\n',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pruneStore with dropPeers (API / worker tree)', () => {
  it('removes the Prisma CLI, TypeScript and everything only they needed', () => {
    const result = pruneStore(root, { dropPeers: true });
    expect(result.droppedLinks.sort()).toEqual([
      '@prisma+client@7_peers/node_modules/prisma',
      '@prisma+client@7_peers/node_modules/typescript',
    ]);
    expect(result.removedPackages.sort()).toEqual([
      'effect@3',
      'prisma@7_deadbeef',
      'typescript@6',
    ]);
    for (const id of ['prisma@7_deadbeef', 'typescript@6', 'effect@3']) {
      expect(exists(id), id).toBe(false);
    }
  });

  it('keeps what the application reaches, including through cycles', () => {
    pruneStore(root, { dropPeers: true });
    for (const kept of [
      'fastify@5',
      'pino@10',
      '@prisma+client@7_peers',
      '@prisma+client-runtime-utils@7',
    ]) {
      expect(exists(kept), kept).toBe(true);
    }
    expect(existsSync(join(root, 'node_modules', 'fastify', 'index.js'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', '@prisma', 'client', 'index.js'))).toBe(true);
    expect(existsSync(join(store(), 'fastify@5', 'node_modules', 'pino', 'index.js'))).toBe(true);
    expect(
      existsSync(
        join(
          store(),
          '@prisma+client@7_peers',
          'node_modules',
          '@prisma',
          'client-runtime-utils',
          'index.js',
        ),
      ),
    ).toBe(true);
  });

  it('cleans up what the removal left dangling: hoisted links and .bin shims', () => {
    pruneStore(root, { dropPeers: true });
    expect(gone(join(store(), 'node_modules', 'effect'))).toBe(true);
    expect(gone(join(root, 'node_modules', '.bin', 'prisma'))).toBe(true);
    expect(existsSync(join(store(), 'node_modules', 'pino', 'index.js'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', '.bin', 'fastify'))).toBe(true);
  });

  it('without dropPeers nothing of the Prisma CLI is touched', () => {
    expect(pruneStore(root)).toEqual({ droppedLinks: [], removedDirect: [], removedPackages: [] });
    expect(exists('prisma@7_deadbeef')).toBe(true);
  });

  it('is idempotent and refuses a folder that is not a pnpm tree', () => {
    pruneStore(root, { dropPeers: true });
    expect(pruneStore(root, { dropPeers: true })).toEqual({
      droppedLinks: [],
      removedDirect: [],
      removedPackages: [],
    });
    expect(() => pruneStore(join(root, 'nope'))).toThrow(/is this a pnpm deploy tree/);
  });

  it('only the documented peer links are cut', () => {
    expect(PEER_LINKS_TO_DROP).toEqual([
      { dependent: '@prisma+client@', names: ['prisma', 'typescript'] },
    ]);
  });
});

describe('pruneStore with keepDev (migrate tree)', () => {
  it('keeps dependencies plus the named dev dependencies and drops other direct ones', () => {
    // eslint is a dev dependency nobody asked to keep; prisma is.
    link(join(root, 'node_modules', 'eslint'), pkg('eslint@9', 'eslint'));
    link(
      join(root, 'node_modules', 'prisma'),
      join(store(), 'prisma@7_deadbeef', 'node_modules', 'prisma'),
    );
    const result = pruneStore(root, { keepDev: ['prisma'] });
    expect(result.removedDirect).toEqual(['eslint']);
    expect(result.removedPackages).toEqual(['eslint@9']);
    expect(exists('prisma@7_deadbeef')).toBe(true);
    expect(exists('effect@3')).toBe(true); // reached through the Prisma CLI
    expect(exists('fastify@5')).toBe(true);
    expect(gone(join(root, 'node_modules', 'eslint'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', 'prisma', 'index.js'))).toBe(true);
  });
});
