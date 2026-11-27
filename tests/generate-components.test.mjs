import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const generator = path.join(root, 'scripts/generate-components.mjs');
const fixtureCatalog = path.join(root, 'tests/fixtures/generator/token_catalog');

function workspace(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-component-test-'));
  const catalog = path.join(cwd, 'token_catalog');
  mkdirSync(catalog);
  for (const file of readdirSync(fixtureCatalog).filter((name) => name.endsWith('.fixture.json')).sort()) {
    copyFileSync(path.join(fixtureCatalog, file), path.join(catalog, file.replace('.fixture.json', '.tokens.json')));
  }
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, catalog };
}

function run(t, { job, outputName = 'generated' } = {}) {
  const { cwd, catalog } = workspace(t);
  const output = path.join(cwd, outputName);
  const args = [generator, '--catalog', catalog, '--templates', path.join(root, 'templates'), '--out', output];
  if (job) args.push('--job', job);
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return { ...result, cwd, catalog, output };
}

function declarations(css) {
  return [...css.matchAll(/(?:^|[;{])\s*[a-z-]+\s*:\s*([^;{}]+);/gmu)].map((match) => match[1].trim());
}

function snapshot(directory) {
  return readdirSync(directory).sort().map((file) => [file, readFileSync(path.join(directory, file), 'utf8')]);
}

test('(a) a complete Button emits variable-only CSS and attributed elements', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  const source = readFileSync(path.join(result.output, 'Button.tsx'), 'utf8');
  const css = readFileSync(path.join(result.output, 'Button.css'), 'utf8');
  const values = declarations(css);
  assert.ok(values.length > 0, 'fixture should exercise at least one CSS declaration');
  for (const value of values) assert.match(value, /^var\(--[a-z0-9-]+\)$/u);
  const elements = [...source.matchAll(/<(?:button|span)\b[^>]*>/gu)].map((match) => match[0]);
  assert.ok(elements.length > 0, 'fixture should emit elements');
  for (const element of elements) {
    assert.match(element, /\bdata-entry=/u);
    assert.match(element, /\bdata-variant=/u);
  }
});

test('(b) two runs are byte-identical', (t) => {
  const first = run(t, { outputName: 'first' });
  const second = run(t, { outputName: 'second' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(snapshot(first.output), snapshot(second.output));
});

test('(c) an entry without a template is listed and not written', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /controls\.shared\.UnknownKind/u);
  assert.match(result.stdout, /template/u);
  assert.ok(!readdirSync(result.output).some((file) => file.startsWith('UnknownKind.')));
});

test('(d) an entry missing a declared field is listed with that field', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /controls\.shared\.MissingLayer[^\n]*layerOrder/u);
  assert.ok(!readdirSync(result.output).some((file) => file.startsWith('MissingLayer.')));
});

test('(e) job mode returns both recipe gaps as structured data', (t) => {
  const result = run(t, { job: 'fixture-job' });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.job, 'fixture-job');
  assert.ok(Array.isArray(response.gaps));
  assert.ok(response.gaps.some((gap) => gap.entry === 'controls.shared.UnknownKind' && /template/u.test(gap.reason)));
  assert.ok(response.gaps.some((gap) => gap.entry === 'controls.shared.MissingLayer' && gap.field === 'layerOrder'));
  assert.ok(response.gaps.every((gap) => !Object.hasOwn(gap, 'error')));
});

test('(f) an entry above tier 2 imports madeOf parts in layer order without paint', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  const source = readFileSync(path.join(result.output, 'CompositeButton.tsx'), 'utf8');
  const css = readFileSync(path.join(result.output, 'CompositeButton.css'), 'utf8');
  assert.match(source, /import \{ LeadingPart \} from '\.\/LeadingPart';/u);
  assert.match(source, /import \{ TrailingPart \} from '\.\/TrailingPart';/u);
  assert.ok(source.indexOf('<LeadingPart') < source.indexOf('<TrailingPart'));
  assert.deepEqual(declarations(css), []);
});

test('(attack) a missing madeOf entry is listed without writing a broken import', (t) => {
  const { cwd, catalog } = workspace(t);
  const catalogFile = path.join(catalog, '03-overlays.tokens.json');
  const document = JSON.parse(readFileSync(catalogFile, 'utf8'));
  document.overlays.shared.MissingPartComposite = {
    $extensions: {
      'app.caelos': {
        lifecycle: 'draft',
        recipeInStaging: true,
        kind: 'button',
        madeOf: ['controls.shared.AbsentPart'],
        layerOrder: ['controls.shared.AbsentPart'],
      },
    },
  };
  writeFileSync(catalogFile, JSON.stringify(document));
  const output = path.join(cwd, 'generated');
  const result = spawnSync(process.execPath, [
    generator,
    '--catalog', catalog,
    '--templates', path.join(root, 'templates'),
    '--out', output,
  ], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /overlays\.shared\.MissingPartComposite[^\n]*controls\.shared\.AbsentPart/u);
  assert.ok(!readdirSync(output).some((file) => file.startsWith('MissingPartComposite.')));
});
