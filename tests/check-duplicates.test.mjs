import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = path.join(root, 'scripts/check-duplicates.mjs');
const builder = path.join(root, 'scripts/build-lock.mjs');
const fixtures = path.join(root, 'tests/fixtures/duplicates');

function run(args, cwd = root) {
  return spawnSync(process.execPath, [checker, ...args], { cwd, encoding: 'utf8' });
}

function fixture(name) {
  return path.join(fixtures, name);
}

function materializedReuseCatalog(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-duplicates-test-'));
  const catalog = path.join(cwd, 'token_catalog');
  cpSync(path.join(fixtures, 'reuse/token_catalog'), catalog, { recursive: true });
  for (const name of readdirSync(catalog)) {
    if (name.endsWith('.fixture.json')) {
      const source = path.join(catalog, name);
      cpSync(source, path.join(catalog, name.replace('.fixture.json', '.tokens.json')));
    }
  }
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, catalog, lock: path.join(catalog, 'versions.lock.json') };
}

function materializedLockCatalog(t, name) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-duplicates-lock-test-'));
  const catalog = path.join(cwd, 'token_catalog');
  cpSync(path.join(fixtures, 'records/token_catalog'), catalog, { recursive: true });
  for (const file of readdirSync(catalog)) {
    if (file.endsWith('.fixture.json')) {
      cpSync(path.join(catalog, file), path.join(catalog, file.replace('.fixture.json', '.tokens.json')));
    }
  }
  cpSync(fixture(`${name}.lock.json`), path.join(catalog, 'versions.lock.json'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, lock: path.join(catalog, 'versions.lock.json') };
}

test('(g) two leaf tokens with the same fingerprint are not reported', (t) => {
  const work = materializedReuseCatalog(t);
  const build = spawnSync(process.execPath, [
    builder, '--catalog', work.catalog, '--schema', path.join(work.catalog, 'recipe.schema.json'), '--out', work.lock,
  ], { cwd: work.cwd, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const entries = JSON.parse(readFileSync(work.lock, 'utf8')).entries;
  assert.equal(entries['primitives.shared.surface.fill'].fingerprint, entries['primitives.shared.surface.reused-fill'].fingerprint);
  const result = run(['--lock', work.lock], work.cwd);
  assert.equal(result.status, 0, result.stderr);
});

test('(a) a new entry with the same resolved content is refused, naming both entries', (t) => {
  const work = materializedReuseCatalog(t);
  const primitivesPath = path.join(work.catalog, '01-primitives.tokens.json');
  const primitives = JSON.parse(readFileSync(primitivesPath, 'utf8'));
  primitives.primitives.shared.rebuilt = structuredClone(primitives.primitives.shared.surface);
  writeFileSync(primitivesPath, `${JSON.stringify(primitives, null, 2)}\n`);
  const build = spawnSync(process.execPath, [
    builder, '--catalog', work.catalog, '--schema', path.join(work.catalog, 'recipe.schema.json'), '--out', work.lock,
  ], { cwd: work.cwd, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const result = run(['--lock', work.lock], work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /primitives\.shared\.surface/u);
  assert.match(result.stderr, /primitives\.shared\.rebuilt/u);
});

test('(b) an entry composed through madeOf has a different lock fingerprint and passes', (t) => {
  const work = materializedReuseCatalog(t);
  const build = spawnSync(process.execPath, [
    builder, '--catalog', work.catalog, '--schema', path.join(work.catalog, 'recipe.schema.json'), '--out', work.lock,
  ], { cwd: work.cwd, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const entries = JSON.parse(readFileSync(work.lock, 'utf8')).entries;
  assert.notEqual(entries['primitives.shared.surface'].fingerprint, entries['controls.shared.composed-surface'].fingerprint);
  const result = run(['--lock', work.lock], work.cwd);
  assert.equal(result.status, 0, result.stderr);
});

test('(c) two variants with the same fingerprint are refused, naming both variants', (t) => {
  const work = materializedLockCatalog(t, 'exact-variants');
  const result = run([], work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /controls\.shared\.alpha#size=compact/u);
  assert.match(result.stderr, /controls\.shared\.beta#size=compact/u);
});

test('(d) a near duplicate is advisory JSON and exits zero', (t) => {
  const work = materializedLockCatalog(t, 'near');
  const result = run([], work.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{
    entries: ['primitives.shared.alpha', 'primitives.shared.beta'],
    kind: 'entry',
  }]);
});

test('(e) a missing lock exits 2 and names the problem', () => {
  const result = run(['--lock', fixture('missing.lock.json')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing\.lock\.json/u);
});

test('the --near file receives advisory JSON instead of stdout', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'caelos-near-test-'));
  const near = path.join(directory, 'near.json');
  const work = materializedLockCatalog(t, 'near');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = run(['--near', near], work.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(readFileSync(near, 'utf8')), [{
    entries: ['primitives.shared.alpha', 'primitives.shared.beta'],
    kind: 'entry',
  }]);
});

test('a malformed fingerprint field exits 2', () => {
  const result = run(['--lock', fixture('malformed-fingerprint.lock.json')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /fingerprint/u);
});

test('check:catalog configures the duplicate check', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['check:duplicates'], 'node scripts/check-duplicates.mjs');
  assert.match(packageJson.scripts['check:catalog'], /\bcheck:duplicates\b/u);
});
