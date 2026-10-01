// Image build helper (apps/api/Dockerfile): trims a `pnpm deploy` tree.
//
// API / worker tree (`--drop-peers`): `@prisma/client` declares `prisma` (the CLI) and `typescript` as
// optional peer dependencies, and the workspace lockfile resolves both, so even a production-only
// deploy installs the whole Prisma CLI (Prisma Studio, the schema engine's tooling, TypeScript, ...)
// next to the API. A running API never uses them, and "the Prisma CLI is not in the runtime images"
// is a packaging rule: the two peer links are removed.
//
// Migrate tree (`--keep-dev=prisma,tsx`): `pnpm deploy` of @loons/db installs all of its dev
// dependencies (eslint, vitest, TypeScript, ...); only the Prisma CLI and tsx (for the seed) are
// kept next to the production dependencies.
//
// Either way every package of node_modules/.pnpm that is no longer reachable from the tree's direct
// dependencies is then deleted.
//
//   node scripts/prune-store.ts <deployed-dir> [--drop-peers] [--keep-dev=a,b]
//   (run with Node's built-in TypeScript support)
//
// Imports only Node built-ins. The result is proved by the images starting and doing their job in
// the smoke test (scripts/smoke-prod.sh); scripts/prune-store.test.ts covers the logic on a fake tree.
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Packages whose links to `names` are dropped (with `dropPeers`) before unreachable ones go. */
export const PEER_LINKS_TO_DROP = [
  { dependent: '@prisma+client@', names: ['prisma', 'typescript'] },
] as const;

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The links (and scope folders' links) directly inside a `node_modules` folder. */
function linksIn(modulesDir: string): string[] {
  const found: string[] = [];
  for (const name of entries(modulesDir)) {
    if (name === '.bin' || name === '.pnpm' || name.startsWith('.')) continue;
    const path = join(modulesDir, name);
    if (name.startsWith('@') && lstatSync(path).isDirectory()) {
      for (const inner of entries(path)) found.push(join(path, inner));
    } else {
      found.push(path);
    }
  }
  return found;
}

/** Folder name in `.pnpm` that a real path lives in (`<id>`), or null when it is outside it. */
function storeId(storeDir: string, realPath: string): string | null {
  const rel = relative(storeDir, realPath);
  if (rel.startsWith('..') || rel === '') return null;
  return rel.split(sep)[0] ?? null;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null; // a dangling link
  }
}

export interface PruneOptions {
  /** Cut the @prisma/client peer links to the Prisma CLI and TypeScript (the API / worker trees). */
  dropPeers?: boolean;
  /**
   * Keep only the package's own `dependencies` plus these dev dependencies as direct
   * dependencies (the migrate tree: the Prisma CLI and tsx, without eslint, vitest, ...).
   */
  keepDev?: string[];
}

export interface PruneResult {
  droppedLinks: string[];
  removedDirect: string[];
  removedPackages: string[];
}

/** Drops unwanted direct dependencies and peer links, then what nothing reaches any more. */
export function pruneStore(deployedDir: string, options: PruneOptions = {}): PruneResult {
  const modulesDir = join(deployedDir, 'node_modules');
  const storeDir = join(modulesDir, '.pnpm');
  if (!existsSync(storeDir)) throw new Error(`${storeDir} not found: is this a pnpm deploy tree?`);
  const realStore = realpathSync(storeDir);

  const removedDirect: string[] = [];
  if (options.keepDev) {
    const manifest = JSON.parse(readFileSync(join(deployedDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const keep = new Set([...Object.keys(manifest.dependencies ?? {}), ...options.keepDev]);
    for (const link of linksIn(modulesDir)) {
      const name = relative(modulesDir, link).split(sep).join('/');
      if (keep.has(name)) continue;
      rmSync(link, { recursive: true, force: true });
      removedDirect.push(name);
    }
  }

  const droppedLinks: string[] = [];
  for (const id of options.dropPeers ? entries(storeDir) : []) {
    const rule = PEER_LINKS_TO_DROP.find((r) => id.startsWith(r.dependent));
    if (!rule) continue;
    for (const name of rule.names) {
      const link = join(storeDir, id, 'node_modules', name);
      if (lstatSync(link, { throwIfNoEntry: false })) {
        unlinkSync(link);
        droppedLinks.push(`${id}/node_modules/${name}`);
      }
    }
  }

  // Reachability from the direct dependencies through the links inside each package folder.
  const reachable = new Set<string>();
  const queue: string[] = [];
  const visit = (link: string): void => {
    const real = safeRealpath(link);
    const id = real === null ? null : storeId(realStore, real);
    if (id !== null && id !== 'node_modules' && !reachable.has(id)) {
      reachable.add(id);
      queue.push(id);
    }
  };
  for (const link of linksIn(modulesDir)) visit(link);
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const link of linksIn(join(storeDir, id, 'node_modules'))) visit(link);
  }

  const removedPackages: string[] = [];
  for (const id of entries(storeDir)) {
    if (id === 'node_modules' || id.startsWith('.') || reachable.has(id)) continue;
    rmSync(join(storeDir, id), { recursive: true, force: true });
    removedPackages.push(id);
  }

  // What the removal left dangling: pnpm's hoisted links, and the .bin entries (symlinks on some
  // platforms, shell shims that name a .pnpm folder on others).
  const hoisted = join(storeDir, 'node_modules');
  for (const path of linksIn(hoisted)) {
    if (lstatSync(path, { throwIfNoEntry: false }) && safeRealpath(path) === null) {
      rmSync(path, { force: true });
    }
  }
  const shims = join(modulesDir, '.bin');
  for (const name of entries(shims)) {
    const path = join(shims, name);
    let dangling = safeRealpath(path) === null;
    if (!dangling) {
      const target = /\.pnpm\/([^/"'\s]+)\//.exec(readShim(path));
      dangling = target !== null && !existsSync(join(storeDir, target[1]!));
    }
    if (dangling) rmSync(path, { force: true });
  }
  return { droppedLinks, removedDirect, removedPackages };
}

function readShim(path: string): string {
  try {
    return lstatSync(path).size < 65_536 ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

if (import.meta.main) {
  const [target, ...flags] = process.argv.slice(2);
  const dropPeers = flags.includes('--drop-peers');
  const keepDevFlag = flags.find((flag) => flag.startsWith('--keep-dev='));
  if (!target || flags.some((flag) => flag !== '--drop-peers' && flag !== keepDevFlag)) {
    console.error(
      'usage: node scripts/prune-store.ts <deployed-dir> [--drop-peers] [--keep-dev=a,b]',
    );
    process.exit(2);
  }
  const keepDev = keepDevFlag?.slice('--keep-dev='.length).split(',').filter(Boolean);
  const { droppedLinks, removedDirect, removedPackages } = pruneStore(target, {
    dropPeers,
    ...(keepDev ? { keepDev } : {}),
  });
  process.stdout.write(
    `prune-store: dropped ${droppedLinks.length} peer link(s) and ${removedDirect.length} direct dependency link(s), removed ${removedPackages.length} package folder(s)
`,
  );
  for (const id of removedPackages)
    process.stdout.write(`  - ${id.split('_')[0]}
`);
}
