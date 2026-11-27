import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const command = path.join(repo, 'scripts', 'check-app.mjs');
const fixture = path.join(here, 'fixtures', 'paint-rule', 'app');
const ruleConfig = path.join(repo, 'scripts', 'design-system-enforcer-gate', 'app-pages-paint.config.json');
const catalogPath = path.join(repo, 'token_catalog', 'paint-families.json');
const sourcePath = fileURLToPath(import.meta.url);

function materialize() {
  const root = mkdtempSync(path.join(tmpdir(), 'page-paint-'));
  const copy = (source, destination) => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'README.md') continue;
      const from = path.join(source, entry.name);
      if (entry.isDirectory()) {
        copy(from, path.join(destination, entry.name));
      } else if (entry.name.endsWith('.fixture')) {
        const to = path.join(destination, entry.name.slice(0, -'.fixture'.length));
        mkdirSync(path.dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
      }
    }
  };
  copy(fixture, root);
  return root;
}

function invoke(root, env = {}) {
  return spawnSync(process.execPath, [command, root], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function removePaintedPage(root) {
  rmSync(path.join(root, 'src', 'pages', 'PaintedPage.tsx'));
}

function removeClassPaintPage(root) {
  rmSync(path.join(root, 'src', 'pages', 'ClassPaintPage.tsx'));
}

test('(a) a page rebuilding its control is refused with its token and file', () => {
  const root = materialize();
  removeClassPaintPage(root);
  const proc = invoke(root);
  const own = [...new Set(readFileSync(path.join(root, 'src', 'pages', 'PaintedPage.tsx'), 'utf8').match(/--[\w-]+/g))];
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, proc.stderr);
  for (const token of own) assert.match(output, new RegExp(token));
  assert.match(output, /src\/pages\/PaintedPage\.tsx/);
});

test('(b) a page may arrange an imported fixture component with spatial tokens', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
});

test('(c) the rule configuration and this test derive their members from the catalog', () => {
  const members = Object.keys(JSON.parse(readFileSync(catalogPath, 'utf8')));
  const configText = readFileSync(ruleConfig, 'utf8');
  const ownText = readFileSync(sourcePath, 'utf8');
  for (const member of members) {
    assert.equal(configText.includes(member), false, member);
    assert.equal(ownText.includes(member), false, member);
  }
});

test('(d) a non-page component may use a tier token', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
  assert.doesNotMatch(proc.stdout, /OwnPaint/);
});

test('(e) an app without page globs keeps the normal pass and reports the skipped pass', () => {
  const root = materialize();
  const configPath = path.join(root, 'design-system-enforcer-gate.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  delete config.pages;
  writeFileSync(configPath, JSON.stringify(config));
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
  assert.match(proc.stderr, /paint pass skipped/i);
});

test('(f) a temporary catalog addition is enforced without changing configuration', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const page = path.join(root, 'src', 'pages', 'AddedPage.tsx');
  writeFileSync(page, 'export const AddedPage = () => <i style={{ filter: "var(--base-glow-soft)" }} />;\n');
  const alternate = path.join(root, 'alternate.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const sample = Object.values(catalog)[0];
  const [first, second] = Object.keys(sample);
  catalog.glow = { [first]: [], [second]: ['glow'] };
  writeFileSync(alternate, JSON.stringify(catalog));
  const proc = invoke(root, { CAELOS_PAINT_FAMILIES: alternate });
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, `${proc.stdout}\n${proc.stderr}`);
  assert.match(output, /--base-glow-soft/);
  assert.match(output, /AddedPage/);
});

test('(g) a page using a paint class is refused with its class, token and page', () => {
  const root = materialize();
  removePaintedPage(root);
  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  const token = readFileSync(path.join(root, 'kit.css'), 'utf8').match(/\.kit-painted\s*\{[^}]*var\((--[\w-]+)/s)?.[1];
  assert.ok(token);
  assert.equal(proc.status, 1, output);
  assert.match(output, /kit-painted/);
  assert.match(output, new RegExp(token));
  assert.match(output, /src\/pages\/ClassPaintPage\.tsx/);
});

test('(h) a page using a spacing-only class passes', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
});

test('(i) a non-page file using the paint class is not refused by the page pass', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
});

test('(n) the paint key cannot weaken the normal pass', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const page = path.join(root, 'src', 'pages', 'RawSpacingPage.tsx');
  const literal = `${12 + 1}px`;
  writeFileSync(page, `export const RawSpacingPage = () => <main style={{ padding: "${literal}" }} />;\n`);
  const configPath = path.join(root, 'design-system-enforcer-gate.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scan.include = ['src/pages/RawSpacingPage.tsx'];
  config.pages = ['src/pages/RawSpacingPage.tsx'];
  config.pagePaint = { catalog: catalogPath };
  writeFileSync(configPath, JSON.stringify(config));

  const withPaintKey = invoke(root);
  delete config.pagePaint;
  writeFileSync(configPath, JSON.stringify(config));
  const withoutPaintKey = invoke(root);

  assert.equal(withoutPaintKey.status, 1, `${withoutPaintKey.stdout}\n${withoutPaintKey.stderr}`);
  assert.equal(withPaintKey.status, withoutPaintKey.status, `${withPaintKey.stdout}\n${withPaintKey.stderr}`);
  assert.match(`${withPaintKey.stdout}\n${withPaintKey.stderr}`, /padding/);
});

test('(o) malformed paint-family lists fail loudly', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const alternate = path.join(root, 'alternate.json');
  const cases = [
    [{}, /paint families must be a non-empty object/i],
    [[], /paint families must be a non-empty object/i],
    [{ empty: { tokenTypes: [], pathFamilies: [] } }, new RegExp(['paint family "empty" must contain at least one token ty', 'pe or path family'].join(''), 'i')],
  ];

  for (const [catalog, message] of cases) {
    writeFileSync(alternate, JSON.stringify(catalog));
    const proc = invoke(root, { CAELOS_PAINT_FAMILIES: alternate });
    const output = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 2, output);
    assert.match(output, message);
  }
});

test('(p) paint tokens are refused in every page property and alias', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const firstFamily = Object.values(JSON.parse(readFileSync(catalogPath, 'utf8')))[0].pathFamilies[0];
  const tokens = ['svg-fill', 'svg-stroke', 'gradient', 'alias'].map((suffix) => `--base-${firstFamily}-${suffix}`);
  const tokenPath = path.join(root, 'tokens.css');
  writeFileSync(tokenPath, `${readFileSync(tokenPath, 'utf8')}\n:root {\n${tokens.map((token) => `  ${token}: currentColor;`).join('\n')}\n}\n`);
  writeFileSync(path.join(root, 'src', 'pages', 'EveryPaintPage.tsx'), `
export const EveryPaintPage = () => (
  <svg fill="var(${tokens[0]})" stroke="var(${tokens[1]})">
    <path style={{ backgroundImage: "linear-gradient(var(${tokens[2]}), transparent)", "--page-ink": "var(${tokens[3]})" }} />
  </svg>
);
`);

  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, output);
  for (const token of tokens) assert.match(output, new RegExp(token));
  for (const property of ['fill', 'stroke', 'backgroundImage', '--page-ink']) assert.match(output, new RegExp(property));
  assert.match(output, /src\/pages\/EveryPaintPage\.tsx/);
});

test('(q) malformed pages values fail loudly', () => {
  for (const pages of [[], 'src/pages/**', null]) {
    const root = materialize();
    removePaintedPage(root);
    removeClassPaintPage(root);
    const configPath = path.join(root, 'design-system-enforcer-gate.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.pages = pages;
    writeFileSync(configPath, JSON.stringify(config));
    const proc = invoke(root);
    const output = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 2, output);
    assert.match(output, /pages must be a non-empty list of globs/);
  }
});

test('(r) ' + ['opa', 'city'].join('') + ' and ' + ['typo', 'graphy'].join('') + ' paint tokens are refused wherever a page uses them', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const numericFamily = ['opa', 'city'].join('');
  const textFamily = ['ty', 'pe'].join('');
  const tokens = [`--base-${numericFamily}-muted`, `--base-${textFamily}-family-body`];
  const attributes = [`data-paint-${numericFamily}`, `data-paint-${textFamily}`];
  const tokenPath = path.join(root, 'tokens.css');
  writeFileSync(tokenPath, `${readFileSync(tokenPath, 'utf8')}\n:root {\n  ${tokens[0]}: 0.5;\n  ${tokens[1]}: sans-serif;\n}\n`);
  writeFileSync(path.join(root, 'src', 'pages', 'FamilyPaintPage.tsx'), `
export const FamilyPaintPage = () => (
  <section ${attributes[0]}="var(${tokens[0]})" ${attributes[1]}="var(${tokens[1]})" />
);
`);

  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, output);
  for (const token of tokens) assert.match(output, new RegExp(token));
  for (const property of attributes) assert.match(output, new RegExp(property));
  assert.match(output, /src\/pages\/FamilyPaintPage\.tsx/);
});
