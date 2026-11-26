import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const config = join(root, 'style-dictionary.config.mjs');
const fixtures = join(root, 'tests', 'fixtures', 'token-build');
// A fixture is a file in tests/fixtures/token-build; no fixture means the source path does not exist.
function run(fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'caelos-token-test-'));
  const source = fixture ? join(fixtures, fixture) : join(dir, 'does-not-exist.json');
  const result = spawnSync(process.execPath, [config], { cwd: root, encoding: 'utf8', env: { ...process.env, CAELOS_TOKEN_SOURCES: JSON.stringify([source]), CAELOS_TOKEN_OUTPUT: dir } });
  return { ...result, output: result.stdout + result.stderr, dir };
}
function real() {
  const dir = mkdtempSync(join(tmpdir(), 'caelos-token-test-'));
  const result = spawnSync(process.execPath, [config], { cwd: root, encoding: 'utf8', env: { ...process.env, CAELOS_TOKEN_OUTPUT: dir } });
  return { ...result, output: result.stdout + result.stderr, dir };
}
test('unresolved reference fails naming the token', () => {
  const r = run('unresolved-reference.fixture.json');
  assert.notEqual(r.status, 0); assert.match(r.output, /base\.bad/);
});
test('empty or wrong source path fails', () => {
  const r = run(); assert.notEqual(r.status, 0); assert.match(r.output, /source|input/i);
});
test('same-value collision warns and writes one property', () => {
  const r = run('collision-same-value.fixture.json');
  assert.equal(r.status, 0, r.output); assert.match(r.output, /base\.x-y.*base\.x\.y|base\.x\.y.*base\.x-y/); assert.match(r.output, /duplicates 1/);
  assert.equal((readFileSync(join(r.dir, 'tokens.css'), 'utf8').match(/--base-x-y\s*:/g) || []).length, 1);
});
test('different-value collision fails naming both tokens and values', () => {
  const r = run('collision-different-value.fixture.json');
  assert.notEqual(r.status, 0); assert.match(r.output, /base\.x-y/); assert.match(r.output, /base\.x\.y/); assert.match(r.output, /1/); assert.match(r.output, /2/);
});
test('real catalog build exits zero', () => { const r = real(); assert.equal(r.status, 0, r.output); });
test('@theme values parse as var references only, with no literal values', () => {
  const r = real(); assert.equal(r.status, 0, r.output);
  const css = readFileSync(join(r.dir, 'tailwind-theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const block = /^@theme\s*\{([\s\S]*)\}\s*$/.exec(css); assert.ok(block, 'expected one @theme block');
  const declarations = block[1].split(';').map(s => s.trim()).filter(Boolean); assert.ok(declarations.length);
  for (const declaration of declarations) assert.match(declaration, /^--[\w-]+\s*:\s*var\(--[\w-]+\)$/, declaration);
});
test('rebuilding twice is byte-identical', () => {
  const a = real(), b = real(); assert.equal(a.status, 0, a.output); assert.equal(b.status, 0, b.output);
  for (const file of ['tokens.css', 'tailwind-theme.css']) assert.deepEqual(readFileSync(join(a.dir, file)), readFileSync(join(b.dir, file)));
});
