import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateChain } from '../engine/lib/chain.mjs';
import { pinApp } from '../engine/steps/pin-app.mjs';
import {
  applyPropagateEdit, collectExpectedDependents, writePropagateReport,
} from '../engine/lib/propagate-report.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = path.join(root, 'tests', 'fixtures', 'engine-propagate');
const lockBuilder = path.join(root, 'scripts', 'build-lock.mjs');

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function command(cwd, ...args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' }).trim();
}

function commit(folder, message) {
  command(folder, 'git', 'add', '-A');
  command(folder, 'git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', message);
  return command(folder, 'git', 'rev-parse', 'HEAD');
}

function materializeCatalog(folder) {
  const catalog = path.join(folder, 'token_catalog');
  mkdirSync(catalog, { recursive: true });
  cpSync(path.join(root, 'token_catalog', 'recipe.schema.json'), path.join(catalog, 'recipe.schema.json'));
  for (const file of readdirSync(path.join(fixtures, 'token_catalog'))) {
    cpSync(
      path.join(fixtures, 'token_catalog', file),
      path.join(catalog, file.replace('.fixture.json', '.tokens.json')),
    );
  }
  return catalog;
}

function buildLock(designSystem) {
  const catalog = path.join(designSystem, 'token_catalog');
  const result = spawnSync(process.execPath, [
    lockBuilder, '--catalog', catalog,
    '--schema', path.join(catalog, 'recipe.schema.json'),
    '--out', path.join(catalog, 'versions.lock.json'),
  ], { cwd: designSystem, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function makeWork(t, { stray = false } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'engine-propagate-'));
  const designSystem = path.join(work, 'design-system');
  const app = path.join(work, 'app');
  const jobFolder = path.join(work, 'job');
  mkdirSync(designSystem);
  mkdirSync(app);
  mkdirSync(jobFolder);
  materializeCatalog(designSystem);
  mkdirSync(path.join(designSystem, 'generated'));
  writeFileSync(path.join(designSystem, 'generated', 'tokens.css'), ':root{--fixture:old}\n');
  buildLock(designSystem);
  command(designSystem, 'git', 'init', '-q');
  const designBase = commit(designSystem, 'fixture design base');

  cpSync(path.join(fixtures, 'app', 'package.fixture.json'), path.join(app, 'package.json'));
  cpSync(path.join(fixtures, 'app', 'package-lock.fixture.json'), path.join(app, 'package-lock.json'));
  command(app, 'git', 'init', '-q');
  const appBase = commit(app, 'fixture app base');

  const job = json(path.join(fixtures, 'job.fixture.json'));
  job.finish = {
    evidenceFolder: jobFolder,
    designSystem: {
      folder: designSystem,
      baseCommit: designBase,
      outputs: [
        { path: 'token_catalog/00-foundations.tokens.json', tierFile: true },
        { path: 'token_catalog/versions.lock.json' },
        { path: 'generated/tokens.css' },
      ],
    },
    app: {
      folder: app,
      baseCommit: appBase,
      dependency: '@fixture/design-system',
      outputs: [{ path: 'package.json' }, { path: 'package-lock.json' }],
    },
  };
  writeFileSync(path.join(jobFolder, 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  writeFileSync(path.join(jobFolder, 'events.jsonl'), [
    { seq: 1, kind: 'node.enter', node: 'apply-propagate-edit' },
    { seq: 2, kind: 'node.exit', node: 'apply-propagate-edit' },
  ].map(JSON.stringify).join('\n') + '\n');

  const edit = applyPropagateEdit({ jobFolder });
  assert.equal(edit.token, 'base.color.primary');
  writeFileSync(path.join(designSystem, 'generated', 'tokens.css'), ':root{--fixture:updated}\n');
  buildLock(designSystem);
  const expected = collectExpectedDependents({ jobFolder });
  writeFileSync(path.join(jobFolder, 'expected-dependents.json'), `${JSON.stringify(expected, null, 2)}\n`);
  if (stray) writeFileSync(path.join(designSystem, 'generated', 'stray.js'), 'export const stray = true;\n');
  const designCommit = commit(designSystem, 'propagate fixture edit');

  let appCommit;
  const pin = pinApp({
    appFolder: app,
    designSystemCommit: designCommit,
    dependency: '@fixture/design-system',
    reinstall: async ({ appFolder }) => {
      writeFileSync(path.join(appFolder, 'package-lock.json'), '{"name":"fixture-app","lockfileVersion":3,"pinned":true}\n');
    },
    git: {
      async commit({ appFolder }) {
        appCommit = commit(appFolder, 'pin fixture design system');
        return appCommit;
      },
    },
  });
  writeFileSync(path.join(jobFolder, 'finish.json'), `${JSON.stringify({
    designSystemMergeCommit: designCommit,
    appMergeCommit: null,
    deployRecord: { id: 'fixture-deploy' },
  }, null, 2)}\n`);
  t.after(() => rmSync(work, { recursive: true, force: true }));
  return pin.then(() => {
    const stateFile = path.join(jobFolder, 'finish.json');
    const state = json(stateFile);
    state.appMergeCommit = appCommit;
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    return { work, designSystem, app, jobFolder, designBase, appBase, designCommit, appCommit };
  });
}

test('criterion 1: one tier-0 edit misses no dependent, calls no model, and changes no non-dependent', async (t) => {
  const work = await makeWork(t);
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  const fixtureDependents = [
    'base.color.primary', 'controls.shared.button', 'primitives.shared.surface',
    'primitives.shared.surface.fill',
  ];
  assert.deepEqual(report.expected_dependents, fixtureDependents);
  assert.deepEqual(report.actual_dependents, fixtureDependents);
  assert.equal(report.dependents_missed, 0);
  assert.equal(report.model_calls, 0);
  assert.deepEqual(report.non_dependents_changed, []);
});

test('criterion 2: a generated file outside the dependent set is reported as a non-dependent', async (t) => {
  const work = await makeWork(t, { stray: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.ok(report.non_dependents_changed.includes('design-system:generated/stray.js'));
});

test('criterion 3: the app dependency line and lock change are expected, not non-dependent', async (t) => {
  const work = await makeWork(t);
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.ok(report.expected_changes.includes('app:package.json#dependencies.@fixture/design-system'));
  assert.ok(report.expected_changes.includes('app:package-lock.json'));
  assert.deepEqual(new Set(report.changed.app), new Set(['package.json', 'package-lock.json']));
  assert.ok(!report.non_dependents_changed.some((name) => name.startsWith('app:')));
  assert.equal(report.app_design_system_commit, work.designCommit);
});

test('criterion 4: the first step applies fixture job.json and refuses a missing token', async (t) => {
  const work = await makeWork(t);
  const tier = json(path.join(work.designSystem, 'token_catalog', '00-foundations.tokens.json'));
  assert.equal(tier.base.color.primary.$value, 'fixture-updated');
  const jobFile = path.join(work.jobFolder, 'job.json');
  const job = json(jobFile);
  job.propagate.token = 'base.color.missing';
  writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`);
  assert.throws(() => applyPropagateEdit({ jobFolder: work.jobFolder }), /token .* does not exist/i);
});

test('criterion 5: the Propagate chain declares only script steps', () => {
  const chain = validateChain(json(path.join(root, 'engine', 'chains', 'propagate.chain.json')));
  assert.ok(chain.steps.length > 0);
  assert.ok(chain.steps.every(({ kind }) => kind === 'script'));
  assert.equal(chain.steps[0].step, 'apply-propagate-edit');
  assert.equal(chain.steps.at(-1).step, 'write-propagate-report');
  assert.ok(chain.steps.some(({ step, script }) => step === 'finish' && script === 'engine/lib/finish.mjs'));
});

test('attack: a prototype-path token name is refused without changing the catalog', async (t) => {
  const work = await makeWork(t);
  const tierFile = path.join(work.designSystem, 'token_catalog', '00-foundations.tokens.json');
  const before = readFileSync(tierFile, 'utf8');
  const jobFile = path.join(work.jobFolder, 'job.json');
  const job = json(jobFile);
  job.propagate.token = '__proto__.polluted';
  writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`);
  assert.throws(() => applyPropagateEdit({ jobFolder: work.jobFolder }), /token .* does not exist/i);
  assert.equal(readFileSync(tierFile, 'utf8'), before);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});
