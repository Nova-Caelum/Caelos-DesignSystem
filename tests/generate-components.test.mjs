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

function invoke({ cwd, catalog, output, templates = path.join(root, 'templates') }) {
  return spawnSync(process.execPath, [
    generator, '--catalog', catalog, '--templates', templates, '--out', output,
  ], { cwd, encoding: 'utf8' });
}

function updateJson(file, update) {
  const document = JSON.parse(readFileSync(file, 'utf8'));
  update(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
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

test('(f) a safe composite owns its root identity while parts retain their identities', (t) => {
  const work = workspace(t);
  const templates = path.join(work.cwd, 'templates');
  mkdirSync(templates);
  copyFileSync(path.join(root, 'templates', 'button.mjs'), path.join(templates, 'button.mjs'));
  writeFileSync(path.join(templates, 'span.mjs'), `
export const requiredFields = ['kind', 'layerOrder'];
export const interactiveElement = null;
export function render(model) {
  return {
    tsx: \`import type { HTMLAttributes, ReactNode } from 'react';
export type \${model.componentName}Props = HTMLAttributes<HTMLSpanElement> & { children?: ReactNode; variant?: string };
export function \${model.componentName}({ children, variant = 'default', ...props }: \${model.componentName}Props) {
  return <span {...props} data-entry=\${JSON.stringify(model.name)} data-variant={variant}>{children}</span>;
}\`,
    css: '',
  };
}
`);
  updateJson(path.join(work.catalog, '02-controls.tokens.json'), (document) => {
    document.controls.shared.LeadingPart.$extensions['app.caelos'].kind = 'span';
    document.controls.shared.TrailingPart.$extensions['app.caelos'].kind = 'span';
  });
  const output = path.join(work.cwd, 'generated');
  const result = invoke({ ...work, output, templates });
  assert.equal(result.status, 0, result.stderr);
  const source = readFileSync(path.join(output, 'CompositeButton.tsx'), 'utf8');
  const css = readFileSync(path.join(output, 'CompositeButton.css'), 'utf8');
  assert.match(source, /import \{ LeadingPart \} from '\.\/LeadingPart';/u);
  assert.match(source, /import \{ TrailingPart \} from '\.\/TrailingPart';/u);
  assert.ok(source.indexOf('<LeadingPart') < source.indexOf('<TrailingPart'));
  assert.deepEqual(declarations(css), []);
  assert.match(source, /<button\b[^>]*data-entry="overlays\.shared\.CompositeButton"[^>]*data-variant=\{variant\}/su);
  assert.match(source, /<LeadingPart\b[^>]*variant=\{variant\}/u);
  assert.match(source, /<TrailingPart\b[^>]*variant=\{variant\}/u);
  assert.doesNotMatch(source, /<LeadingPart\b[^>]*data-entry=/u);
  assert.doesNotMatch(source, /<TrailingPart\b[^>]*data-entry=/u);
  assert.match(readFileSync(path.join(output, 'LeadingPart.tsx'), 'utf8'),
    /data-entry="controls\.shared\.LeadingPart"[^>]*data-variant=\{variant\}/u);
  assert.match(readFileSync(path.join(output, 'TrailingPart.tsx'), 'utf8'),
    /data-entry="controls\.shared\.TrailingPart"[^>]*data-variant=\{variant\}/u);
});

test('(f2) a composite that would nest an interactive element of the same kind is refused by entry name', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /overlays\.shared\.CompositeButton[^\n]*interactive[^\n]*button/u);
  assert.ok(!readdirSync(result.output).some((file) => file.startsWith('CompositeButton.')));
});

test('(f3) a tier-0 non-paint madeOf reference resolves without becoming a rendered part', (t) => {
  const work = workspace(t);
  updateJson(path.join(work.catalog, '03-overlays.tokens.json'), (document) => {
    document.overlays.shared.TokenComposite = {
      $extensions: { 'app.caelos': {
        lifecycle: 'draft', recipeInStaging: true, kind: 'button',
        madeOf: ['base.space.md'], layerOrder: ['base.space.md'],
      } },
    };
  });
  const output = path.join(work.cwd, 'generated');
  const result = invoke({ ...work, output });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /TokenComposite[^\n]*missing entry/u);
  const source = readFileSync(path.join(output, 'TokenComposite.tsx'), 'utf8');
  assert.doesNotMatch(source, /BaseSpaceMd|base\.space\.md/u);
});

test('(f4) templates are discovered recursively like the recipe checker', (t) => {
  const work = workspace(t);
  const templates = path.join(work.cwd, 'templates');
  mkdirSync(path.join(templates, 'controls'), { recursive: true });
  copyFileSync(path.join(root, 'templates', 'button.mjs'), path.join(templates, 'controls', 'button.mjs'));
  const output = path.join(work.cwd, 'generated');
  const result = invoke({ ...work, output, templates });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readdirSync(output).includes('Button.tsx'), result.stdout);
  assert.doesNotMatch(result.stdout, /controls\.shared\.Button[^\n]*template/u);
});

test('(f4a) duplicate template kinds are refused', (t) => {
  const work = workspace(t);
  const templates = path.join(work.cwd, 'templates');
  mkdirSync(path.join(templates, 'first'), { recursive: true });
  mkdirSync(path.join(templates, 'second'), { recursive: true });
  copyFileSync(path.join(root, 'templates', 'button.mjs'), path.join(templates, 'first', 'button.mjs'));
  copyFileSync(path.join(root, 'templates', 'button.mjs'), path.join(templates, 'second', 'button.mjs'));
  const output = path.join(work.cwd, 'generated');
  const result = invoke({ ...work, output, templates });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /duplicate template kind "button"/u);
  assert.match(result.stderr, /first\/button\.mjs/u);
  assert.match(result.stderr, /second\/button\.mjs/u);
});

test('(f4b) a transitive same-kind interactive part is refused with its path', (t) => {
  const work = workspace(t);
  const templates = path.join(work.cwd, 'templates');
  mkdirSync(templates);
  copyFileSync(path.join(root, 'templates', 'button.mjs'), path.join(templates, 'button.mjs'));
  writeFileSync(path.join(templates, 'span.mjs'), `
export const requiredFields = ['kind', 'layerOrder'];
export const interactiveElement = null;
export function render(model) {
  return { tsx: \`export function \${model.componentName}() { return <span />; }\`, css: '' };
}
`);
  updateJson(path.join(work.catalog, '03-overlays.tokens.json'), (document) => {
    delete document.overlays.shared.CompositeButton;
    document.overlays.shared.NonInteractiveGroup = {
      $extensions: { 'app.caelos': {
        lifecycle: 'draft', recipeInStaging: true, kind: 'span',
        madeOf: ['controls.shared.LeadingPart'], layerOrder: ['controls.shared.LeadingPart'],
      } },
    };
  });
  const transitiveCatalog = {
    patterns: {
      shared: {
        TransitiveComposite: { $extensions: { 'app.caelos': {
          lifecycle: 'draft', recipeInStaging: true, kind: 'button',
          madeOf: ['overlays.shared.NonInteractiveGroup'], layerOrder: ['overlays.shared.NonInteractiveGroup'],
        } } },
      },
    },
  };
  writeFileSync(path.join(work.catalog, '04-patterns.tokens.json'), `${JSON.stringify(transitiveCatalog, null, 2)}\n`);
  const output = path.join(work.cwd, 'generated');
  const result = invoke({ ...work, output, templates });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /patterns\.shared\.TransitiveComposite[^\n]*interactive[^\n]*button/u);
  assert.match(result.stdout, /patterns\.shared\.TransitiveComposite → overlays\.shared\.NonInteractiveGroup → controls\.shared\.LeadingPart/u);
  assert.ok(!readdirSync(output).some((file) => file.startsWith('TransitiveComposite.')));
});

test('(f5) empty generator inputs are refused with the entry and field, and never render', async (t) => {
  const cases = [
    {
      name: 'madeOf item', entry: 'overlays.shared.EmptyMadeOf', field: 'madeOf', output: 'EmptyMadeOf',
      mutate(document) {
        document.overlays.shared.EmptyMadeOf = { $extensions: { 'app.caelos': {
          lifecycle: 'draft', recipeInStaging: true, kind: 'button', madeOf: [''], layerOrder: ['content'],
        } } };
      },
      file: '03-overlays.tokens.json',
    },
    {
      name: 'variant value', entry: 'controls.shared.Button', field: 'variants.tone', output: 'Button',
      mutate(document) { document.controls.shared.Button.$extensions['app.caelos'].variants = { tone: [''] }; },
      file: '02-controls.tokens.json',
    },
    {
      name: 'required field', entry: 'controls.shared.EmptyKind', field: 'kind', output: 'EmptyKind',
      mutate(document) {
        document.controls.shared.EmptyKind = { $extensions: { 'app.caelos': {
          lifecycle: 'draft', recipeInStaging: true, kind: '', layerOrder: ['content'],
        } } };
      },
      file: '02-controls.tokens.json',
    },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, (inner) => {
      const work = workspace(inner);
      updateJson(path.join(work.catalog, fixtureCase.file), fixtureCase.mutate);
      const output = path.join(work.cwd, 'generated');
      const result = invoke({ ...work, output });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`${fixtureCase.entry.replaceAll('.', '\\.') }[^\\n]*${fixtureCase.field.replace('.', '\\.')}`, 'u'));
      assert.match(result.stdout, new RegExp(`${fixtureCase.entry.replaceAll('.', '\\.') }[^\\n]*empty|required`, 'u'));
      assert.ok(!readdirSync(output).some((file) => file.startsWith(`${fixtureCase.output}.`)));
    });
  }
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
