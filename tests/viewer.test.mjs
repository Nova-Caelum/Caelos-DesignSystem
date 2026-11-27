import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = path.join(root, 'tests/fixtures/viewer');
let workspace;
let result;
let html = '';
let css = '';

function materializeFixtures(source, target) {
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(source).filter((name) => name.endsWith('.fixture.json')).sort()) {
    copyFileSync(path.join(source, file), path.join(target, file.replace('.fixture.json', '.tokens.json')));
  }
}

function countLifecycleDrafts(value) {
  if (!value || typeof value !== 'object') return 0;
  const own = value.$extensions?.['app.caelos']?.lifecycle === 'draft' ? 1 : 0;
  return own + Object.values(value).reduce((sum, child) => sum + countLifecycleDrafts(child), 0);
}

before(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'caelos-viewer-test-'));
  const catalog = path.join(workspace, 'token_catalog');
  const generated = path.join(workspace, 'generated/components');
  const out = path.join(workspace, 'dist');
  materializeFixtures(fixtureRoot, catalog);

  const generation = spawnSync(process.execPath, [
    path.join(root, 'scripts/generate-components.mjs'),
    '--catalog', catalog,
    '--templates', path.join(root, 'templates'),
    '--out', generated,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(generation.status, 0, generation.stderr);

  result = spawnSync(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--catalog', catalog,
    '--generated', generated,
    '--out', out,
    '--now', '2026-11-26T00:00:00.000Z',
  ], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    html = readFileSync(path.join(out, 'index.html'), 'utf8');
    css = readFileSync(path.join(out, 'app.css'), 'utf8');
  }
});

after(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function assertBuildPassed() {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('(a) the built viewer has one page per tier file', () => {
  assertBuildPassed();
  const expected = readdirSync(fixtureRoot)
    .filter((name) => name.endsWith('.fixture.json'))
    .map((name) => name.replace('.fixture.json', '.tokens.json'))
    .sort();
  const actual = [...html.matchAll(/data-tier-file="([^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(actual, expected);
});

test('(b) Button has a live attributed button for every state', () => {
  assertBuildPassed();
  const family = html.match(/<section[^>]+data-family="controls\.shared\.Button"[\s\S]*?<\/section>/u)?.[0] ?? '';
  const states = [...family.matchAll(/data-state-card="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(states, ['default', 'hover', 'pressed', 'success', 'focus', 'disabled']);
  assert.equal((family.match(/<button\b[^>]*data-entry="controls\.shared\.Button"/gu) ?? []).length, states.length);
});

test('(c) every Button card lists token path, value and tier', () => {
  assertBuildPassed();
  const family = html.match(/<section[^>]+data-family="controls\.shared\.Button"[\s\S]*?<\/section>/u)?.[0] ?? '';
  const cards = family.split(/data-state-card=/u).slice(1);
  assert.equal(cards.length, 6);
  for (const card of cards) {
    assert.match(card, /data-token-path="controls\.shared\.Button\.foreground"/u);
    assert.match(card, /data-token-value="\{base\.color\.ink\}"/u);
    assert.match(card, /data-token-tier="2"/u);
  }
});

test('(d) the first screen counts lifecycle drafts, never status drafts', () => {
  assertBuildPassed();
  const expected = readdirSync(fixtureRoot)
    .filter((name) => name.endsWith('.fixture.json'))
    .map((name) => JSON.parse(readFileSync(path.join(fixtureRoot, name), 'utf8')))
    .reduce((sum, document) => sum + countLifecycleDrafts(document), 0);
  const button = html.match(/<section[^>]+data-family="controls\.shared\.Button"[\s\S]*?<\/section>/u)?.[0] ?? '';
  assert.match(html, new RegExp(`data-draft-count="${expected}"`, 'u'));
  assert.match(button, /data-lifecycle="promoted"/u);
  assert.doesNotMatch(button, /data-lifecycle="draft"/u);
});

test('(e) the first screen shows the oldest age and all generator gaps', () => {
  assertBuildPassed();
  assert.match(html, /data-oldest-draft-days="56"/u);
  assert.match(html, /data-gap-count="2"/u);
});

test('(f) state cards wrap after five columns', () => {
  assertBuildPassed();
  const rule = css.match(/\.state-cards\s*\{([^}]*)\}/su)?.[1] ?? '';
  assert.equal(rule.match(/minmax\(var\(--sys-space-grid-column-min\), auto\)/gu)?.length, 5);
});

test('(g) skipped live entries are named with generator reasons', () => {
  assertBuildPassed();
  assert.match(html, /not generated: missing required field &quot;layerOrder&quot;/u);
  assert.match(html, /not generated: no template for kind &quot;viewer-fixture-unknown&quot;/u);
});

test('(attack) a family without $extensions builds as an incomplete record', () => {
  assertBuildPassed();
  assert.match(html, /data-family="overlays\.shared\.IncompleteRecord"[\s\S]*?incomplete record/u);
});
