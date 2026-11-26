import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../scripts/check-ratchet.mjs', import.meta.url));
const exceptions = 'token_catalog/tier-line.exceptions.json';
const original = 'overlays.shared.notice.foreground';

function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-ratchet-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (name, data) => writeFileSync(path.join(cwd, name), JSON.stringify(data));
  mkdirSync(path.join(cwd, 'token_catalog'));
  write(exceptions, [original]);
  write('gate-baseline.json', { 'app/page.ts': { 'raw-style': 2 } });
  git('init', '-q');
  git('add', '.');
  const base = git('write-tree');
  return { cwd, write, git, run: (...args) => spawnSync(process.execPath, [checker, '--base', base, ...args], {
    cwd, encoding: 'utf8',
  }) };
}

test('(c) refuses an addition to the paint exceptions list', (t) => {
  const { write, run } = fixture(t);
  write(exceptions, [original, 'units.chat.notice.foreground']);
  const result = run();
  assert.equal(result.status, 1, `expected paint exceptions addition to fail, got ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /units\.chat\.notice\.foreground.*added/);
});

test('(g) fails loudly when a required input file is missing', (t) => {
  const { run } = fixture(t);
  const result = run('--baseline', 'missing.json');
  assert.equal(result.status, 1, `expected missing baseline to fail, got ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /missing\.json.*(cannot read|missing)/i);
});

test('accepts shrinking lists and rejects increases, new rules and new files', (t) => {
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

test('fails when the base tree lacks the exceptions input', (t) => {
  const { cwd, git } = fixture(t);
  git('update-index', '--force-remove', '--', exceptions);
  const base = git('write-tree');
  const result = spawnSync(process.execPath, [checker, '--base', base], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /tier-line\.exceptions\.json at base.*cannot read input/);
});
