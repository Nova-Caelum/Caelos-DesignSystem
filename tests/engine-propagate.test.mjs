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
const tokenBuilder = path.join(root, 'style-dictionary.config.mjs');

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

function buildTokens(designSystem) {
  const catalog = path.join(designSystem, 'token_catalog');
  const sources = readdirSync(catalog)
    .filter((file) => /^0[0-5]-.*\.tokens\.json$/u.test(file))
    .sort()
    .map((file) => path.join(catalog, file));
  const result = spawnSync(process.execPath, [tokenBuilder], {
    cwd: designSystem,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAELOS_TOKEN_SOURCES: JSON.stringify(sources),
      CAELOS_TOKEN_OUTPUT: path.join(designSystem, 'generated'),
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function makeWork(t, {
  extraTierZeroChange = false,
  mixedUnmappedLine = false,
  modelCalls = 0,
  literalDependent = false,
  staleGenerated = false,
  staleOwnLines = false,
  stray = false,
  wrongAppPin = false,
} = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'engine-propagate-'));
  const designSystem = path.join(work, 'design-system');
  const app = path.join(work, 'app');
  const jobFolder = path.join(work, 'job');
  mkdirSync(designSystem);
  mkdirSync(app);
  mkdirSync(jobFolder);
  materializeCatalog(designSystem);
  mkdirSync(path.join(designSystem, 'generated'));
  buildTokens(designSystem);
  const oldCss = readFileSync(path.join(designSystem, 'generated', 'tokens.css'), 'utf8');
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
        { path: 'generated/tailwind-theme.css' },
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
  const events = [
    { seq: 1, kind: 'node.enter', node: 'apply-propagate-edit' },
    { seq: 2, kind: 'node.exit', node: 'apply-propagate-edit' },
  ];
  for (let index = 0; index < modelCalls; index += 1) {
    events.push({
      seq: events.length + 1,
      kind: 'node.enter',
      node: `model-${index}`,
      model_source: 'run-setting',
      model: 'fixture-model',
    });
  }
  writeFileSync(path.join(jobFolder, 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);

  const edit = applyPropagateEdit({ jobFolder });
  assert.equal(edit.token, 'base.space.medium');
  if (!staleGenerated) buildTokens(designSystem);
  let generatedCss = readFileSync(path.join(designSystem, 'generated', 'tokens.css'), 'utf8');
  if (mixedUnmappedLine) generatedCss = generatedCss.replace(/\}\s*$/u, '  --fixture-unknown: after;\n}\n');
  if (literalDependent) {
    generatedCss = generatedCss.replace(
      '--primitives-shared-inset-value: var(--base-space-medium);',
      '--primitives-shared-inset-value: 17px;',
    );
  }
  if (staleOwnLines) {
    generatedCss = oldCss.replace('--base-space-other: 8px;', '--base-space-other: 9px;');
  }
  if (extraTierZeroChange) {
    const tierFile = path.join(designSystem, 'token_catalog', '00-foundations.tokens.json');
    const tier = json(tierFile);
    tier.base.space.other.$value = '9px';
    writeFileSync(tierFile, `${JSON.stringify(tier, null, 2)}\n`);
    buildTokens(designSystem);
    generatedCss = readFileSync(path.join(designSystem, 'generated', 'tokens.css'), 'utf8');
  }
  writeFileSync(path.join(designSystem, 'generated', 'tokens.css'), generatedCss);
  const editFile = path.join(jobFolder, 'propagate-edit.json');
  const editRecord = json(editFile);
  editRecord.generated_outputs = ['generated/tokens.css', 'generated/tailwind-theme.css'];
  writeFileSync(editFile, `${JSON.stringify(editRecord, null, 2)}\n`);
  buildLock(designSystem);
  const expected = collectExpectedDependents({ jobFolder });
  writeFileSync(path.join(jobFolder, 'expected-dependents.json'), `${JSON.stringify(expected, null, 2)}\n`);
  if (staleGenerated) {
    writeFileSync(path.join(designSystem, 'generated', 'tokens.css'), oldCss);
  }
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
    if (wrongAppPin) {
      const packageFile = path.join(app, 'package.json');
      const packageDocument = json(packageFile);
      packageDocument.dependencies['@fixture/design-system'] = 'github:fixture/design-system#wrong-commit';
      writeFileSync(packageFile, `${JSON.stringify(packageDocument, null, 2)}\n`);
      appCommit = commit(app, 'record wrong design-system pin');
    }
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
    'base.space.medium', 'controls.shared.button', 'primitives.shared.inset',
    'primitives.shared.inset.value',
  ];
  assert.deepEqual(report.expected_dependents, fixtureDependents);
  assert.deepEqual(report.actual_dependents, fixtureDependents);
  assert.equal(report.dependents_missed, 0);
  assert.equal(report.model_calls, 0);
  assert.deepEqual(report.non_dependents_changed, []);
});

test('mutation actual-from-expected: a rebuilt lock with stale generated CSS misses every dependent', async (t) => {
  const work = await makeWork(t, { staleGenerated: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.deepEqual(report.actual_dependents, []);
  assert.equal(report.dependents_missed, report.expected_dependents.length);
  assert.deepEqual(report.missed_dependents, report.expected_dependents);
});

test('condition (a): editing the catalog without rerunning the real token build misses every dependent', async (t) => {
  const work = await makeWork(t, { staleGenerated: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.deepEqual(report.actual_dependents, []);
  assert.deepEqual(report.missed_dependents, report.expected_dependents);
});

test('condition (b): a dependent changed to a literal no longer resolves through built CSS', async (t) => {
  const work = await makeWork(t, { literalDependent: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.ok(report.missed_dependents.includes('primitives.shared.inset'));
  assert.ok(report.missed_dependents.includes('primitives.shared.inset.value'));
});

test('built-chain source: the lock stays dependent when built CSS severs its var chain', async (t) => {
  const work = await makeWork(t, { literalDependent: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.ok(report.expected_dependents.includes('primitives.shared.inset.value'));
  assert.ok(!report.actual_dependents.includes('primitives.shared.inset.value'));
});

test('regression: the report step exits nonzero after writing a report with missed dependents', async (t) => {
  const work = await makeWork(t, { staleGenerated: true });
  const result = spawnSync(process.execPath, [
    path.join(root, 'engine', 'lib', 'propagate-report.mjs'),
    'write-propagate-report', '--job', work.jobFolder,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /dependent.*missed/i);
  assert.ok(json(path.join(work.jobFolder, 'propagate.json')).dependents_missed > 0);
});

test('mutation missed-empty: stale generated CSS produces a nonzero missed count', async (t) => {
  const work = await makeWork(t, { staleGenerated: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.ok(report.dependents_missed > 0);
  assert.ok(report.missed_dependents.length > 0);
});

test('B3: a second rebuilt tier-0 value is named as a non-dependent change', async (t) => {
  const work = await makeWork(t, { extraTierZeroChange: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.ok(report.non_dependents_changed.includes('design-system:base.space.other'));
});

test('B3: the report command fails after naming a second rebuilt tier-0 value', async (t) => {
  const work = await makeWork(t, { extraTierZeroChange: true });
  const result = spawnSync(process.execPath, [
    path.join(root, 'engine', 'lib', 'propagate-report.mjs'),
    'write-propagate-report', '--job', work.jobFolder,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /base\.space\.other/);
});

test('mutation all-outputs-per-dependent: a changed foreign line leaves own-line dependents missed', async (t) => {
  const work = await makeWork(t, { staleOwnLines: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.deepEqual(report.actual_dependents, []);
  assert.deepEqual(report.missed_dependents, report.expected_dependents);
  assert.ok(report.non_dependents_changed.includes('design-system:base.space.other'));
});

test('a mapped line cannot hide an unmapped declaration in the same output file', async (t) => {
  const work = await makeWork(t, { mixedUnmappedLine: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.ok(report.non_dependents_changed.includes('design-system:generated/tokens.css'));
});

test('mutation model-count-zero: one recorded model entry is counted', async (t) => {
  const work = await makeWork(t, { modelCalls: 1 });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.equal(report.model_calls, 1);
});

test('mutation app-pin-check-off: a wrong app pin is a missed dependent', async (t) => {
  const work = await makeWork(t, { wrongAppPin: true });
  const report = await writePropagateReport({ jobFolder: work.jobFolder });
  assert.equal(report.dependents_missed, 1);
  assert.deepEqual(report.missed_dependents, [
    'app:package.json#dependencies.@fixture/design-system',
  ]);
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
  assert.equal(tier.base.space.medium.$value, '17px');
  const jobFile = path.join(work.jobFolder, 'job.json');
  const job = json(jobFile);
  job.propagate.token = 'base.color.missing';
  writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`);
  assert.throws(() => applyPropagateEdit({ jobFolder: work.jobFolder }), /token .* does not exist/i);
});

test('ruling 3: the tier-0 edit changes only the selected value bytes', async (t) => {
  const work = await makeWork(t);
  const tierFile = path.join(work.designSystem, 'token_catalog', '00-foundations.tokens.json');
  command(work.designSystem, 'git', 'checkout', work.designBase, '--', 'token_catalog/00-foundations.tokens.json');
  const before = readFileSync(tierFile, 'utf8');
  applyPropagateEdit({ jobFolder: work.jobFolder });
  assert.equal(
    readFileSync(tierFile, 'utf8'),
    before.replace('"16px"', '"17px"'),
  );
});

test('ruling 4: a value that does not match the token type is refused without an edit', async (t) => {
  const work = await makeWork(t);
  const tierFile = path.join(work.designSystem, 'token_catalog', '00-foundations.tokens.json');
  command(work.designSystem, 'git', 'checkout', work.designBase, '--', 'token_catalog/00-foundations.tokens.json');
  const before = readFileSync(tierFile, 'utf8');
  const jobFile = path.join(work.jobFolder, 'job.json');
  const job = json(jobFile);
  job.propagate.token = 'base.space.medium';
  job.propagate.value = 'fixture-colour';
  writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`);
  assert.throws(() => applyPropagateEdit({ jobFolder: work.jobFolder }), /dimension.*value|value.*dimension/i);
  assert.equal(readFileSync(tierFile, 'utf8'), before);
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
