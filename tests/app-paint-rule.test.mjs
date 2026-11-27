import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  cpSync(fixture, root, { recursive: true });
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
