import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceChecker = path.join(root, 'scripts/check-recipes.mjs');

function aggregateFixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'catalog-aggregate-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, 'scripts'));
  mkdirSync(path.join(cwd, 'bin'));
  copyFileSync(sourceChecker, path.join(cwd, 'scripts/check-recipes.mjs'));
  const log = path.join(cwd, 'calls.log');
  writeFileSync(path.join(cwd, 'bin/npm'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "if (process.argv[3] === process.env.FAIL_CHECK) process.exit(7);",
  ].join('\n'));
  chmodSync(path.join(cwd, 'bin/npm'), 0o755);
  writeFileSync(path.join(cwd, 'scripts/drift.mjs'), [
    "import { appendFileSync, lstatSync } from 'node:fs';",
    "import path from 'node:path';",
    "appendFileSync(process.env.CALL_LOG, JSON.stringify(['drift', ...process.argv.slice(2)]) + '\\n');",
    "if (process.env.REFUSE_SNAPSHOT_LINK) {",
    "  try { lstatSync(path.join(process.argv[2], 'cache-link')); process.exit(9); } catch (error) { if (error.code !== 'ENOENT') throw error; }",
    "}",
  ].join('\n'));
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(cwd, 'scripts/check-recipes.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(cwd, 'bin')}${path.delimiter}${process.env.PATH}`, CALL_LOG: log, ...extra },
  });
  return { cwd, log, run };
}

test('H accepts three checks, forwards candidate arguments, and scopes paired and baseline', (t) => {
  const { cwd, log, run } = aggregateFixture(t);
  const candidate = path.join(cwd, 'candidate');
  mkdirSync(candidate);
  const result = run([
    '--catalog', 'scripts/drift.mjs', 'check:recipes', 'check:other', 'check:ratchet', '--',
    '--base', 'base-ref', '--candidate', candidate, '--git-root', cwd,
    '--paired', 'paired.json', '--baseline', 'baseline.json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['drift', candidate]);
  assert.deepEqual(calls[1], ['run', 'check:recipes', '--', '--base', 'base-ref', '--candidate', candidate, '--git-root', cwd, '--paired', 'paired.json']);
  assert.deepEqual(calls[2], ['run', 'check:other', '--', '--base', 'base-ref', '--candidate', candidate, '--git-root', cwd]);
  assert.deepEqual(calls[3], ['run', 'check:ratchet', '--', '--base', 'base-ref', '--candidate', candidate, '--git-root', cwd, '--baseline', 'baseline.json']);
});

test('H stops at the first failing configured check and returns its status', (t) => {
  const { cwd, log, run } = aggregateFixture(t);
  const candidate = path.join(cwd, 'candidate');
  mkdirSync(candidate);
  const result = run([
    '--catalog', 'scripts/drift.mjs', 'check:one', 'check:two', 'check:three', '--',
    '--base', 'base-ref', '--candidate', candidate,
  ], { FAIL_CHECK: 'check:two' });
  assert.equal(result.status, 7, result.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((call) => call[1]).filter(Boolean), [candidate, 'check:one', 'check:two']);
});

test('H snapshot mode skips an untracked symlink instead of copying it', (t) => {
  const { cwd, run } = aggregateFixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), 'catalog-link-target-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(cwd, 'cache-link'));
  let result = spawnSync('git', ['init', '-q'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync('git', ['add', 'scripts', 'bin'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = run(['--catalog', 'scripts/drift.mjs', 'check:one', '--', '--base', 'base-ref'], {
    REFUSE_SNAPSHOT_LINK: '1',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('H snapshot mode refuses a tracked symlink to a directory', (t) => {
  const { cwd, run } = aggregateFixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), 'catalog-tracked-link-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(cwd, 'linked-directory'));
  let result = spawnSync('git', ['init', '-q'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync('git', ['add', 'scripts', 'bin', 'linked-directory'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = run(['--catalog', 'scripts/drift.mjs', 'check:one', '--', '--base', 'base-ref']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /linked-directory.*tracked symlinked directory.*replace/i);
});
