import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));
const launcher = path.join(repository, 'scripts', 'check-engine.mjs');
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repository,
    encoding: 'utf8',
    env: environment,
    ...options,
  });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

// The candidate is a plain-file copy of this tree, as the CI job exports it. A copy, not
// `git archive HEAD`, so the test also runs where the repository has no commit yet.
function unpackCandidate(folder) {
  const candidate = path.join(folder, 'candidate');
  const skipped = new Set(['.git', 'node_modules']);
  cpSync(repository, candidate, {
    recursive: true,
    filter: (source) => !skipped.has(path.basename(source)),
  });
  return candidate;
}

// The CI job passes a real base commit. Where this repository has no commit yet (the
// tier-proof harness runs the suite in one), a throwaway repository supplies that base.
function baseArguments(folder, candidate) {
  const head = run('git', ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.status === 0) return ['--base', head.stdout.trim()];
  const base = path.join(folder, 'base');
  cpSync(candidate, base, { recursive: true });
  const git = (...args) => {
    const result = run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: base });
    assert.equal(result.status, 0, output(result));
    return result.stdout.trim();
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return ['--base', git('rev-parse', 'HEAD'), '--git-root', base];
}

function plantCandidate(candidate, marker, evilMarker) {
  writeFileSync(path.join(candidate, 'index.js'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
  ].join('\n'));
  const tests = path.join(candidate, 'tests');
  mkdirSync(tests, { recursive: true });
  writeFileSync(path.join(tests, 'engine-evil.test.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(evilMarker)}, 'ran\\n');`,
  ].join('\n'));
}

function createPlantedCandidate() {
  const folder = mkdtempSync(path.join(tmpdir(), 'check-engine-forwarding-'));
  const candidate = unpackCandidate(folder);
  const marker = path.join(folder, 'marker');
  const evilMarker = path.join(folder, 'evil-marker');
  plantCandidate(candidate, marker, evilMarker);
  return { folder, candidate, marker, evilMarker };
}

test('catalog CI shape does not execute files planted in the candidate', (t) => {
  const work = createPlantedCandidate();
  t.after(() => rmSync(work.folder, { recursive: true, force: true }));
  const result = run('npm', [
    'run', 'check:catalog', '--', '--candidate', work.candidate, ...baseArguments(work.folder, work.candidate),
  ]);
  assert.equal(result.status, 0, `BAILOUT: check:catalog could not pass:\n${output(result)}`);
  assert.equal(existsSync(work.marker), false, output(result));
  assert.equal(existsSync(work.evilMarker), false, output(result));
});

test('check:engine ignores directly forwarded arguments', (t) => {
  const work = createPlantedCandidate();
  t.after(() => rmSync(work.folder, { recursive: true, force: true }));

  const result = run('npm', [
    'run', 'check:engine', '--', '--base', 'HEAD', '--candidate', work.candidate,
  ]);
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /(?:#|ℹ) pass [1-9]\d*/);
  assert.equal(existsSync(work.marker), false, output(result));
  assert.equal(existsSync(work.evilMarker), false, output(result));
});

test('check:engine finds its own repository root when run from another cwd', (t) => {
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'check-engine-cwd-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [launcher], { cwd: elsewhere, encoding: 'utf8', env: environment });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /(?:#|ℹ) pass [1-9]\d*/);
});

test('check:engine refuses a root without engine tests', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'check-engine-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts');
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  mkdirSync(scripts);
  copyFileSync(launcher, path.join(scripts, 'check-engine.mjs'));

  const result = spawnSync(process.execPath, [path.join(scripts, 'check-engine.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no engine tests found/i);
});
