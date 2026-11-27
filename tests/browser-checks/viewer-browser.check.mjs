import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const viewerFixture = path.join(root, 'tests/fixtures/viewer');
const attackFixture = path.join(root, 'tests/fixtures/viewer-check');
const checker = path.join(root, 'viewer/check-viewer.mjs');

async function materializeCatalog(source, target) {
  await mkdir(target, { recursive: true });
  const files = await readdir(source);
  await Promise.all(files.filter((file) => file.endsWith('.fixture.json')).map((file) => copyFile(
    path.join(source, file),
    path.join(target, file.replace('.fixture.json', '.tokens.json')),
  )));
}

async function buildFixtureViewer(folder) {
  const catalog = path.join(folder, 'token_catalog');
  const generated = path.join(folder, 'generated/components');
  const viewer = path.join(folder, 'viewer');
  await materializeCatalog(viewerFixture, catalog);
  const generate = spawnSync(process.execPath, [
    path.join(root, 'scripts/generate-components.mjs'),
    '--catalog', catalog,
    '--templates', path.join(root, 'templates'),
    '--out', generated,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(generate.status, 0, generate.stderr || generate.stdout);
  const build = spawnSync(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--catalog', catalog,
    '--generated', generated,
    '--out', viewer,
    '--now', '2026-11-26T00:00:00.000Z',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  return viewer;
}

async function removeStateCards(viewer) {
  const index = path.join(viewer, 'index.html');
  const html = await readFile(index, 'utf8');
  await writeFile(index, html.replaceAll('data-state-card=', 'data-missing-state-card='));
}

async function runCase(entries, { withoutCards = false } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'viewer-browser-check-'));
  try {
    const viewer = await buildFixtureViewer(folder);
    if (withoutCards) await removeStateCards(viewer);
    const entryFile = path.join(folder, 'entries.json');
    const out = path.join(folder, 'results.json');
    await writeFile(entryFile, `${JSON.stringify(entries)}\n`);
    const result = spawnSync(process.execPath, [checker, '--entries', entryFile, '--out', out, '--viewer', viewer], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { result, results: JSON.parse(await readFile(out, 'utf8')) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function runAttack(entry, fixtureName) {
  const folder = await mkdtemp(path.join(tmpdir(), 'viewer-browser-attack-'));
  try {
    const viewer = path.join(folder, 'viewer');
    await mkdir(viewer, { recursive: true });
    await copyFile(path.join(attackFixture, fixtureName, 'index.fixture.html'), path.join(viewer, 'index.html'));
    const entryFile = path.join(folder, 'entries.json');
    const out = path.join(folder, 'results.json');
    await writeFile(entryFile, `${JSON.stringify([entry])}\n`);
    const result = spawnSync(process.execPath, [checker, '--entries', entryFile, '--out', out, '--viewer', viewer], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { result, results: JSON.parse(await readFile(out, 'utf8')) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('the real built fixture viewer passes Button', async () => {
  const run = await runCase(['controls.shared.Button']);

  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  assert.ok(run.results.entries[0].states.every((state) => state.shown && state.responding && state.named));
});

test('the real built fixture viewer names an entry with no cards', async () => {
  const run = await runCase(['controls.shared.Button'], { withoutCards: true });

  assert.equal(run.result.status, 1, `${run.result.stdout}\n${run.result.stderr}`);
  assert.match(run.result.stdout, /controls\.shared\.Button/);
});

for (const attack of [
  ['dead-entry', 'Attack.Dead', 'default'],
  ['click-only', 'Attack.ClickOnly', 'default'],
  ['partly-shown', 'Attack.PartlyShown', 'hover'],
  ['hidden-element', 'Attack.Hidden', 'default'],
  ['disabled-forwards', 'Attack.DisabledForwards', 'disabled'],
]) {
  const [fixtureName, entry, state] = attack;
  test(`the real driver refuses ${fixtureName}`, async () => {
    const run = await runAttack(entry, fixtureName);

    assert.equal(run.result.status, 1, `${run.result.stdout}\n${run.result.stderr}`);
    assert.match(run.result.stdout, new RegExp(entry.replaceAll('.', '\\.'), 'u'));
    assert.match(run.result.stdout, new RegExp(state, 'u'));
  });
}
