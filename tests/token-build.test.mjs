import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const config = join(root, 'style-dictionary.config.mjs');
const fixtures = join(root, 'tests', 'fixtures', 'token-build');

function execute(sources) {
  const dir = mkdtempSync(join(tmpdir(), 'caelos-token-test-'));
  const result = spawnSync(process.execPath, [config], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAELOS_TOKEN_SOURCES: JSON.stringify(sources),
      CAELOS_TOKEN_OUTPUT: dir,
    },
  });
  return { ...result, output: result.stdout + result.stderr, dir };
}

function run(fixture) {
  const source = fixture
    ? join(fixtures, fixture)
    : join(mkdtempSync(join(tmpdir(), 'caelos-token-test-')), 'does-not-exist.json');
  return execute([source]);
}

function real() {
  const dir = mkdtempSync(join(tmpdir(), 'caelos-token-test-'));
  const result = spawnSync(process.execPath, [config], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAELOS_TOKEN_OUTPUT: dir },
  });
  return { ...result, output: result.stdout + result.stderr, dir };
}

let configModule;
let importOutput;
async function importConfig() {
  if (configModule) return configModule;
  const previousOutput = process.env.CAELOS_TOKEN_OUTPUT;
  importOutput = mkdtempSync(join(tmpdir(), 'caelos-token-import-'));
  process.env.CAELOS_TOKEN_OUTPUT = importOutput;
  try {
    configModule = await import(pathToFileURL(config).href);
  } finally {
    if (previousOutput === undefined) delete process.env.CAELOS_TOKEN_OUTPUT;
    else process.env.CAELOS_TOKEN_OUTPUT = previousOutput;
  }
  return configModule;
}

test('no sources fails with its guard message', () => {
  const r = execute([]);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /No source files specified/);
});

test('missing source fails with its guard message', () => {
  const r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.output, /Cannot read or parse source .*does-not-exist\.json/);
});

test('zero tokens fails with its guard message', () => {
  const r = run('zero-tokens.fixture.json');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /Source files contain no tokens/);
});

test('unresolved reference fails naming the broken reference', () => {
  const r = run('unresolved-reference.fixture.json');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /\{base\.bad\} tries to reference \{base\.missing\}/);
});

test('different-value collision fails before writing output', () => {
  const r = run('collision-different-value.fixture.json');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /Collision --base-x-y: base\.x-y = "1px", base\.x\.y = "2px"\./);
  assert.equal(existsSync(join(r.dir, 'tokens.css')), false);
});

test('same-value collision fails before writing output', () => {
  const r = run('collision-same-value.fixture.json');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /Collision --base-x-y: /);
  assert.equal(existsSync(join(r.dir, 'tokens.css')), false);
});

test('empty theme output fails with its guard message', () => {
  const r = run('empty-theme.fixture.json');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /Empty or invalid output file/);
});

test('checkOutput rejects repeated CSS property names', async () => {
  const { checkOutput } = await importConfig();
  assert.equal(existsSync(join(importOutput, 'tokens.css')), false, 'import must not run the build');
  assert.throws(
    () => checkOutput({ css: ':root {\n  --base-a: 1px;\n  --base-a: 1px;\n}\n', theme: '@theme {\n  --spacing-a: var(--base-a);\n}\n', input: 2 }),
    /repeated CSS property names/,
  );
});

test('checkOutput rejects a token count mismatch', async () => {
  const { checkOutput } = await importConfig();
  assert.throws(
    () => checkOutput({ css: ':root {\n  --base-a: 1px;\n}\n', theme: '@theme {\n  --spacing-a: var(--base-a);\n}\n', input: 2 }),
    /Token count mismatch: tokens in 2, written 1/,
  );
});

test('checkOutput rejects empty CSS output', async () => {
  const { checkOutput } = await importConfig();
  assert.throws(
    () => checkOutput({ css: '', theme: '@theme {\n  --spacing-a: var(--base-a);\n}\n', input: 0 }),
    /Empty or invalid output file/,
  );
});

test('real catalog build exits zero with matching token counts', () => {
  const r = real();
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /Collision/);
  const counts = /tokens in (\d+), written (\d+)/.exec(r.output);
  assert.ok(counts, r.output);
  assert.equal(counts[1], counts[2]);
});

test('@theme values parse as var references only, with no literal values', () => {
  const r = real();
  assert.equal(r.status, 0, r.output);
  const css = readFileSync(join(r.dir, 'tailwind-theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const block = /^@theme\s*\{([\s\S]*)\}\s*$/.exec(css);
  assert.ok(block, 'expected one @theme block');
  const declarations = block[1].split(';').map(s => s.trim()).filter(Boolean);
  assert.ok(declarations.length);
  for (const declaration of declarations) assert.match(declaration, /^--[\w-]+\s*:\s*var\(--[\w-]+\)$/u, declaration);
});

test('rebuilding twice is byte-identical', () => {
  const a = real();
  const b = real();
  assert.equal(a.status, 0, a.output);
  assert.equal(b.status, 0, b.output);
  for (const file of ['tokens.css', 'tailwind-theme.css']) {
    assert.deepEqual(readFileSync(join(a.dir, file)), readFileSync(join(b.dir, file)));
  }
});
