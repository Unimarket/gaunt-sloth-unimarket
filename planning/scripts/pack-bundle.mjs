#!/usr/bin/env node
// Packs a checkout of the Gaunt Sloth fork into versioned tarballs a consumer installs as file: dependencies.
//
// The five lock-step packages (core, agent, review, batch and the gaunt-sloth app) are packed with
// `pnpm pack`, then each packed copy gets the version "<upstream>-<suffix>" and its exact
// @gaunt-sloth/* dependency pins rewritten to match. The fork's sources are never modified, so
// rebasing on a new upstream release cannot conflict on version fields.
//
// Usage:
//   node planning/scripts/pack-bundle.mjs --fork <checkout> --suffix fork.1 [--out vendor] [--skip-build]
//
// Requires Node 24 and pnpm 11 on the PATH, and an installed fork checkout (`pnpm install`).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const LOCK_STEP_DIRS = ['core', 'agent', 'review', 'batch', 'app'];
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'peerDependencies',
  'devDependencies',
  'optionalDependencies',
];

const { values } = parseArgs({
  options: {
    fork: { type: 'string' },
    suffix: { type: 'string' },
    out: { type: 'string', default: 'vendor' },
    'skip-build': { type: 'boolean', default: false },
  },
});

if (!values.fork || !values.suffix) {
  console.error(
    'Usage: node planning/scripts/pack-bundle.mjs --fork <checkout> --suffix <label.n> [--out vendor] [--skip-build]'
  );
  process.exit(2);
}
if (!/^[0-9A-Za-z.-]+$/.test(values.suffix)) {
  console.error(`Invalid suffix "${values.suffix}": use letters, digits, dots and hyphens only.`);
  process.exit(2);
}

const forkDir = resolve(values.fork);
const outDir = resolve(values.out);
const packagesDir = join(forkDir, 'packages');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

if (!existsSync(join(packagesDir, 'core', 'package.json'))) {
  console.error(
    `${forkDir} does not look like a Gaunt Sloth checkout (no packages/core/package.json).`
  );
  process.exit(2);
}

const upstreamVersion = readJson(join(packagesDir, 'core', 'package.json')).version;
const newVersion = `${upstreamVersion}-${values.suffix}`;
const lockStepNames = new Set(
  LOCK_STEP_DIRS.map((dir) => readJson(join(packagesDir, dir, 'package.json')).name)
);

if (!values['skip-build']) {
  console.log('Building the workspace');
  run('pnpm', ['run', 'build'], forkDir);
}

const work = mkdtempSync(join(tmpdir(), 'pack-gth-'));
mkdirSync(outDir, { recursive: true });
try {
  for (const dir of LOCK_STEP_DIRS) {
    const packageDir = join(packagesDir, dir);
    const packed = join(work, `packed-${dir}`);
    mkdirSync(packed);
    run('pnpm', ['pack', '--pack-destination', packed], packageDir);
    const tarball = readdirSync(packed).find((name) => name.endsWith('.tgz'));
    if (!tarball) {
      throw new Error(`pnpm pack produced no tarball for packages/${dir}`);
    }
    run('tar', ['-xzf', join(packed, tarball), '-C', packed], packed);

    const manifestPath = join(packed, 'package', 'package.json');
    const manifest = readJson(manifestPath);
    manifest.version = newVersion;
    for (const section of DEPENDENCY_SECTIONS) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (lockStepNames.has(name)) {
          manifest[section][name] = newVersion;
        }
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const fileBase = manifest.name.replace(/^@/, '').replace('/', '-');
    const staleTarball = new RegExp(
      `^${fileBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d.*\\.tgz$`
    );
    for (const stale of readdirSync(outDir).filter((name) => staleTarball.test(name))) {
      rmSync(join(outDir, stale));
    }
    // --ignore-scripts: the packed manifest keeps the fork's lifecycle scripts, which must not run here.
    run(
      'npm',
      ['pack', '--ignore-scripts', '--silent', '--pack-destination', outDir],
      join(packed, 'package')
    );
    console.log(`  ${manifest.name}@${newVersion}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`Wrote ${LOCK_STEP_DIRS.length} tarballs to ${outDir}`);
console.log(
  "List all five as direct file: dependencies in the consumer's package.json, for example:"
);
for (const dir of LOCK_STEP_DIRS) {
  const name = readJson(join(packagesDir, dir, 'package.json')).name;
  const fileBase = name.replace(/^@/, '').replace('/', '-');
  console.log(`  "${name}": "file:vendor/${fileBase}-${newVersion}.tgz"`);
}
