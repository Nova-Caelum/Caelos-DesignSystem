import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = path.join(root, 'scripts/check-ratchet.mjs');
const fixtureRoot = path.join(root, 'tests/fixtures/check-ratchet');
const exceptions = 'token_catalog/tier-line.exceptions.json';
const original = 'overlays.shared.notice.foreground';

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CI;
  return env;
}

function countsFixture(name) {
  return JSON.parse(readFileSync(path.join(fixtureRoot, `${name}.json.fixture`), 'utf8'));
}

function fixture(t, { commit = true } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'catalog-ratchet-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (name, data) => {
    const destination = path.join(cwd, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify(data));
  };
  mkdirSync(path.join(cwd, 'token_catalog'));
  for (const file of ['recipe.schema.json', 'paint-families.json']) {
    copyFileSync(path.join(root, 'token_catalog', file), path.join(cwd, 'token_catalog', file));
  }
  write(exceptions, [original]);
  write('token_catalog/00-foundations.tokens.json', {
    base: { shared: { ink: { $type: 'color', $value: `#${'0'.repeat(6)}` } } },
  });
  write('gate-baseline.json', { 'app/page.ts': { 'raw-style': 2 } });
  git('init', '-q');
  git('config', 'user.email', 'catalog-test@example.invalid');
  git('config', 'user.name', 'Catalog test');
  let base;
  if (commit) {
    git('add', '.');
    git('commit', '-qm', 'base');
    base = git('rev-parse', 'HEAD^{tree}');
  }
  const run = (...args) => spawnSync(process.execPath, [
    checker, '--base', base ?? 'none', '--candidate', cwd, '--git-root', cwd, ...args,
  ], { cwd: root, encoding: 'utf8', env: cleanEnv() });
  return { base, cwd, write, git, run };
}

test('A1 reads the exceptions list from the candidate', (t) => {
  const { write, run } = fixture(t);
  write(exceptions, [original, 'units.chat.notice.foreground']);
  const result = run();
  assert.equal(result.status, 1, `expected paint exceptions addition to fail, got ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /units\.chat\.notice\.foreground.*added/);
});

test('A3 validates candidate schema data in full ratchet mode', (t) => {
  const { run, write } = fixture(t);
  write('token_catalog/recipe.schema.json', {
    type: 'object', required: ['lifecycle'], properties: { lifecycle: { type: 'string', const: 'promoted' } },
  });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /const.*lifecycle.*does not implement/);
});

test('A4 refuses a symlinked exceptions input', (t) => {
  const { cwd, run } = fixture(t);
  const outside = path.join(path.dirname(cwd), `${path.basename(cwd)}-exceptions.json`);
  t.after(() => rmSync(outside, { force: true }));
  writeFileSync(outside, '[]');
  unlinkSync(path.join(cwd, exceptions));
  symlinkSync(outside, path.join(cwd, exceptions));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlink.*replace the symlink with a regular file/i);
});

test('G fails when the base tree lacks the exceptions input', (t) => {
  const { cwd, git } = fixture(t);
  git('update-index', '--force-remove', '--', exceptions);
  const base = git('write-tree');
  const result = spawnSync(process.execPath, [
    checker, '--base', base, '--candidate', cwd, '--git-root', cwd,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /tier-line\.exceptions\.json at base.*cannot read input/);
});

test('ratchet fails loudly when a requested baseline is missing', (t) => {
  const { run } = fixture(t);
  const result = run('--baseline', 'missing.json');
  assert.equal(result.status, 1, `expected missing baseline to fail, got ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /missing\.json.*(cannot read|missing)/i);
});

test('ratchet accepts shrinking counts and rejects increases, new rules and new files', (t) => {
  const { write, run } = fixture(t);
  const file = 'gate-baseline.json';
  write(exceptions, []);
  write(file, { 'app/page.ts': { 'raw-style': 1 } });
  const smaller = run('--baseline', file);
  assert.equal(smaller.status, 0, smaller.stderr);
  write(file, { 'app/page.ts': { 'raw-style': 3, 'unknown-token': 1 }, 'app/next.ts': { 'raw-style': 1 } });
  const larger = run('--baseline', file);
  assert.equal(larger.status, 1, larger.stderr);
  assert.match(larger.stderr, /count rose from 2 to 3/);
  assert.match(larger.stderr, /rule unknown-token was added/);
  assert.match(larger.stderr, /file app\/next\.ts was added/);
});

test('app gate baseline passes when current per-file rule counts shrink', (t) => {
  const { run, write } = fixture(t);
  write('gate-baseline.json', countsFixture('gate-baseline'));
  write('gate-actual.json', countsFixture('gate-actual-shrink'));
  const result = run('--mode', 'baseline', '--baseline', 'gate-baseline.json', '--actual', 'gate-actual.json');
  assert.equal(result.status, 0, result.stderr);
});

test('app gate baseline fails when a per-file rule count rises', (t) => {
  const { run, write } = fixture(t);
  write('gate-baseline.json', countsFixture('gate-baseline'));
  write('gate-actual.json', countsFixture('gate-actual-increase'));
  const result = run('--mode', 'baseline', '--baseline', 'gate-baseline.json', '--actual', 'gate-actual.json');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /count rose from 2 to 3/);
});

test('app gate baseline fails when findings appear in a new file', (t) => {
  const { run, write } = fixture(t);
  write('gate-baseline.json', countsFixture('gate-baseline'));
  write('gate-actual.json', countsFixture('gate-actual-new-file'));
  const result = run('--mode', 'baseline', '--baseline', 'gate-baseline.json', '--actual', 'gate-actual.json');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /file app\/new-page\.tsx was added/);
});

test('F refuses base none in a repository with commits', (t) => {
  const { cwd } = fixture(t);
  const result = spawnSync(process.execPath, [checker, '--base', 'none', '--git-root', cwd], {
    cwd, encoding: 'utf8', env: cleanEnv({ CAELOS_CATALOG_GIT_ROOT: cwd }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--base none is only for a repository's first commit/);
});

test('F accepts base none only in a marked repository with no commits', (t) => {
  const { cwd } = fixture(t, { commit: false });
  const result = spawnSync(process.execPath, [checker, '--base', 'none', '--git-root', cwd], {
    cwd, encoding: 'utf8', env: cleanEnv({ CAELOS_CATALOG_GIT_ROOT: cwd }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no base given: ratchet comparison skipped/);
});

test('I baseline mode reads no catalog or exceptions data and works outside the trusted root', (t) => {
  const gitRoot = mkdtempSync(path.join(tmpdir(), 'catalog-baseline-git-'));
  const candidate = mkdtempSync(path.join(tmpdir(), 'catalog-baseline-candidate-'));
  const runner = mkdtempSync(path.join(tmpdir(), 'catalog-baseline-runner-'));
  t.after(() => {
    rmSync(gitRoot, { recursive: true, force: true });
    rmSync(candidate, { recursive: true, force: true });
    rmSync(runner, { recursive: true, force: true });
  });
  writeFileSync(path.join(gitRoot, 'gate.json'), JSON.stringify({ file: { rule: 2 } }));
  let result = spawnSync('git', ['init', '-q'], { cwd: gitRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync('git', ['add', '.'], { cwd: gitRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync('git', ['write-tree'], { cwd: gitRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const base = result.stdout.trim();
  writeFileSync(path.join(candidate, 'gate.json'), JSON.stringify({ file: { rule: 1 } }));
  result = spawnSync(process.execPath, [
    checker, '--mode', 'baseline', '--baseline', 'gate.json', '--base', base,
    '--candidate', candidate, '--git-root', gitRoot,
  ], { cwd: runner, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Shrink-only catalog ratchet passed/);
});
