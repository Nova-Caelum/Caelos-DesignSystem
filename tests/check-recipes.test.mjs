import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = path.join(root, 'scripts/check-recipes.mjs');
const catalog = 'token_catalog';
const pattern = 'patterns.shared.notice';

function fixture(t, { paint = false } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-recipe-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (file, value) => writeFileSync(path.join(cwd, file), JSON.stringify(value));
  function entry(fields = {}, description) {
    const notice = { $extensions: { 'app.caelos': { lifecycle: 'promoted', ...fields } } };
    if (description) notice.$description = description;
    if (paint) {
      notice.ink = {
        $type: 'color', $value: '{primitives.shared.ink.default}',
        $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      };
    }
    write(`${catalog}/04-patterns.tokens.json`, { patterns: { shared: { notice } } });
  }
  mkdirSync(path.join(cwd, catalog));
  for (const file of ['recipe.schema.json', 'paint-families.json']) {
    copyFileSync(path.join(root, catalog, file), path.join(cwd, catalog, file));
  }
  write(`${catalog}/tier-line.exceptions.json`, []);
  write(`${catalog}/01-primitives.tokens.json`, {
    primitives: { shared: { ink: {
      $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      default: {
        $type: 'color', $value: '{sys.color.default}',
        $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      },
    } } },
  });
  entry();
  git('init', '-q');
  git('add', '.');
  const base = git('write-tree');
  return { cwd, entry, write, run: (...args) => spawnSync(process.execPath, [checker, '--base', base, ...args], {
    cwd, encoding: 'utf8',
  }) };
}

function refused(result, rule) {
  assert.equal(result.status, 1, `expected refusal for ${rule}, got ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, new RegExp(`patterns\\.shared\\.notice.*${rule}`));
}

test('(a) refuses tier 4 colour paint and names the entry', (t) => {
  const { run } = fixture(t, { paint: true });
  refused(run(), 'paint enters only at tiers 0 to 2');
});

test('(b) refuses a present madeOf name without a lower-tier entry', (t) => {
  const { entry, run } = fixture(t);
  entry({ madeOf: ['primitives.shared.missing'] });
  refused(run(), 'madeOf.*lower-tier entry');
});

test('(d) passes an existing incomplete recipe while unchanged', (t) => {
  const { entry, run } = fixture(t);
  entry({ lifecycle: 'draft' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test('(e) refuses the same incomplete recipe after a material change', (t) => {
  const { entry, run } = fixture(t);
  entry({}, 'Changed recipe');
  refused(run(), 'requires madeOf');
});

test('(f) refuses the same incomplete recipe when paired', (t) => {
  const { write, run } = fixture(t);
  write('match.json', { notice: pattern });
  refused(run('--paired', 'match.json'), 'requires madeOf');
});

test('reads required fields from the template and accepts a completed recipe', (t) => {
  const { cwd, entry, run } = fixture(t);
  const templates = path.join(cwd, 'templates');
  mkdirSync(templates);
  writeFileSync(path.join(templates, 'notice.mjs'), 'export const requiredFields = ["tone"];\n');
  const record = { kind: 'notice', madeOf: ['primitives.shared.ink'] };
  entry(record);
  refused(run(), 'template requires tone');
  entry({ ...record, tone: 'Choose a color from the page' });
  refused(run(), 'uses prose as a source');
  entry({ ...record, tone: 'neutral' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});
