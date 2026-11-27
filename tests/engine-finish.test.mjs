import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { finishJob } from '../engine/lib/finish.mjs';
import {
  captureEngineOutputHashes, recomputeCrossJobEvidence, writeJobEvidence,
} from '../engine/lib/evidence.mjs';
import { pinApp } from '../engine/steps/pin-app.mjs';
import { runCodexStep } from '../engine/adapters/codex.mjs';
import { runJob } from '../engine/lib/run.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = path.join(repository, 'tests', 'fixtures', 'engine-finish');
const refusedModels = JSON.parse(readFileSync(path.join(repository, 'engine', 'refused-models.json'), 'utf8')).models;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function command(cwd, ...args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd, message) {
  command(cwd, 'git', 'add', '-A');
  command(cwd, 'git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', message);
  return command(cwd, 'git', 'rev-parse', 'HEAD');
}

function makeRepository(source, target) {
  cpSync(source, target, { recursive: true });
  command(target, 'git', 'init', '-q');
  return commit(target, 'fixture base');
}

function promoteRecord(signedAt = '2026-11-26T10:00:00.000Z', jobId = 'job-apply') {
  return {
    jobId, status: 'promoted', signedAt, signerWords: 'approved',
    promoted: [{ file: '02-controls.fixture.json', id: 'controls.button', gapFill: 'reference' }],
    skipped: [],
  };
}

function makeWork(t, { signoff = true, chain = 'apply', id = 'job-apply' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'engine-finish-'));
  const designSystem = path.join(root, 'design-system');
  const app = path.join(root, 'app');
  const jobFolder = path.join(root, 'job');
  const evidenceFolder = path.join(root, 'evidence');
  mkdirSync(jobFolder);
  mkdirSync(evidenceFolder);
  const designBase = makeRepository(path.join(fixtureRoot, 'design-system'), designSystem);
  const appBase = makeRepository(path.join(fixtureRoot, 'app'), app);
  for (const name of ['behaviour-results.json', 'gate-results.json', 'system-faithful.json', 'integrate.json']) {
    cpSync(path.join(fixtureRoot, 'facts', name), path.join(jobFolder, name));
  }
  if (signoff) writeFileSync(path.join(jobFolder, 'signoff.json'), `${JSON.stringify(promoteRecord(undefined, id), null, 2)}\n`);
  writeFileSync(path.join(jobFolder, 'events.jsonl'), `${JSON.stringify({
    seq: 1, kind: 'node.exit', run_id: 'fixture-run', node: 'craft',
    ts: '2026-11-26T09:00:00.000Z', model: 'fixture-allowed-model',
  })}\n`);
  const job = {
    id, chain,
    finish: {
      evidenceFile: chain === 'expand' ? 'job-expand.json' : 'job-apply.json',
      designSystem: {
        folder: designSystem, repository: 'fixture/design-system', base: 'main', head: 'job-apply-ds',
        baseCommit: designBase,
        outputs: [
          { path: 'token_catalog/02-controls.fixture.json', tierFile: true },
          { path: 'generated/button.js' },
        ],
      },
      app: {
        folder: app, repository: 'fixture/app', base: 'main', head: 'job-apply-app',
        baseCommit: appBase, dependency: '@caelos/design-system',
        outputs: [
          { path: 'app/page.tsx' }, { path: 'package.json' }, { path: 'package-lock.json' },
          { path: 'gate-baseline.json' },
          { path: 'lib/taskgraph-client/recorded.ts' },
          { path: 'lib/taskgraph-client/index.ts' },
        ],
      },
      behaviourResults: 'behaviour-results.json', gateResults: 'gate-results.json',
      systemFaithfulResults: 'system-faithful.json', integrateResults: 'integrate.json',
      draftFiles: [{ repository: 'designSystem', path: 'token_catalog/02-controls.fixture.json' }],
    },
  };
  writeFileSync(path.join(jobFolder, 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, designSystem, app, jobFolder, evidenceFolder, designBase, appBase, job };
}

function promoteFixture(work, message = 'promote fixture lifecycle') {
  const tierFile = path.join(work.designSystem, 'token_catalog', '02-controls.fixture.json');
  const tier = readJson(tierFile);
  tier.controls.button.$extensions['app.caelos'].lifecycle = 'promoted';
  tier.controls.button.$extensions['app.caelos'].draftedBy = work.job.id;
  writeFileSync(tierFile, `${JSON.stringify(tier, null, 2)}\n`);
  return commit(work.designSystem, message);
}

function passingState(work, designSystemMergeCommit, overrides = {}) {
  return {
    designSystemMergeCommit,
    appMergeCommit: work.appBase,
    designSystemCheckRunIds: [{ id: 101, conclusion: 'success' }],
    appCheckRunIds: [{ id: 202, conclusion: 'success' }],
    appMergedAt: '2026-11-26T12:00:00Z',
    ...overrides,
  };
}

function makeInterfaces(work) {
  const calls = [];
  const pullRequests = new Map();
  let nextNumber = 1;
  let deployRecord = null;
  const github = {
    async openPullRequest(input) {
      calls.push(['open', input.repository]);
      const pullRequest = { number: nextNumber++, repository: input.repository, mergeCommit: null, mergedAt: null };
      pullRequests.set(input.repository, pullRequest);
      return { number: pullRequest.number };
    },
    async getPullRequest({ repository: name }) {
      calls.push(['read', name]);
      return { ...pullRequests.get(name) };
    },
    async getCheckRuns({ repository: name }) {
      calls.push(['checks', name]);
      return name.endsWith('/app') ? [{ id: 202, conclusion: 'success' }] : [{ id: 101, conclusion: 'success' }];
    },
  };
  const git = {
    async push({ folder }) { calls.push(['push', folder]); },
    async changedFiles({ folder, baseCommit, commit: target }) {
      const output = command(folder, 'git', 'diff', '--name-only', baseCommit, target);
      return output ? output.split('\n') : [];
    },
    async readFileAt({ folder, commit: target, file }) {
      return execFileSync('git', ['show', `${target}:${file}`], { cwd: folder });
    },
  };
  const pin = async (options) => pinApp({
    ...options,
    reinstall: async ({ appFolder }) => {
      calls.push(['reinstall', appFolder]);
      writeFileSync(path.join(appFolder, 'package-lock.json'), '{"name":"fixture-app","lockfileVersion":3,"pinned":true}\n');
    },
    git: {
      async commit({ appFolder }) {
        calls.push(['commit', appFolder]);
        return commit(appFolder, 'pin design system');
      },
    },
  });
  return {
    calls, pullRequests, github, git, pin,
    deployReader: { async read() { calls.push(['deploy']); return deployRecord; } },
    setDeploy(value) { deployRecord = value; },
  };
}

async function advanceThroughPullRequests(work, interfaces) {
  const options = { ...interfaces, jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, jobFolders: [work.jobFolder] };
  const first = await finishJob(options);
  const designPull = interfaces.pullRequests.get('fixture/design-system');
  designPull.mergeCommit = promoteFixture(work, 'design merge');
  designPull.mergedAt = '2026-11-26T11:00:00.000Z';
  const second = await finishJob(options);
  const appPull = interfaces.pullRequests.get('fixture/app');
  appPull.mergeCommit = command(work.app, 'git', 'rev-parse', 'HEAD');
  appPull.mergedAt = '2026-11-26T12:00:00.000Z';
  return { options, first, second, designPull, appPull };
}

test('criterion: finish refuses every pull request when no promote record exists', async (t) => {
  const work = makeWork(t, { signoff: false });
  const interfaces = makeInterfaces(work);
  await assert.rejects(
    finishJob({ ...interfaces, jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, jobFolders: [work.jobFolder] }),
    /promote record/i,
  );
  assert.deepEqual(interfaces.calls.filter(([kind]) => kind === 'open'), []);
});

test('criterion: two pull requests open in order with the pin between them and the runner never merges', async (t) => {
  const work = makeWork(t);
  const interfaces = makeInterfaces(work);
  const { first, second } = await advanceThroughPullRequests(work, interfaces);
  assert.equal(first.status, 'waiting-design-system-merge');
  assert.equal(second.status, 'waiting-app-merge');
  const sequence = interfaces.calls.filter(([kind]) => ['open', 'reinstall', 'commit'].includes(kind));
  assert.deepEqual(sequence.map(([kind, target]) => [kind, path.basename(target)]), [
    ['open', 'design-system'], ['reinstall', 'app'], ['commit', 'app'], ['open', 'app'],
  ]);
  assert.equal(Object.hasOwn(interfaces.github, 'mergePullRequest'), false);
});

test('criterion: the job report carries every owned fact and reads deploy through the injected reader', async (t) => {
  const work = makeWork(t);
  const interfaces = makeInterfaces(work);
  const { options } = await advanceThroughPullRequests(work, interfaces);
  interfaces.setDeploy({ id: 'abc1234' });
  const result = await finishJob(options);
  assert.equal(result.status, 'complete');
  const report = readJson(path.join(work.evidenceFolder, 'job-apply.json'));
  assert.deepEqual({
    job_passed: report.job_passed,
    behaviours_failed: report.behaviours_failed,
    backend_files_changed: report.backend_files_changed,
    engine_output_edited_after_run: report.engine_output_edited_after_run,
    design_system_merge_commit: report.design_system_merge_commit,
    app_merge_commit: report.app_merge_commit,
    design_system_check_run_ids: report.design_system_check_run_ids,
    app_check_run_ids: report.app_check_run_ids,
    deploy_record: report.deploy_record,
  }, {
    job_passed: true, behaviours_failed: 0, backend_files_changed: 0,
    engine_output_edited_after_run: false,
    design_system_merge_commit: command(work.designSystem, 'git', 'rev-parse', 'HEAD'),
    app_merge_commit: command(work.app, 'git', 'rev-parse', 'HEAD'),
    design_system_check_run_ids: [101], app_check_run_ids: [202], deploy_record: { id: 'abc1234' },
  });
  assert.ok(interfaces.calls.some(([kind]) => kind === 'deploy'));
});

test('criterion: an edited engine-written file is detected and fails the job', async (t) => {
  const work = makeWork(t);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  promoteFixture(work);
  writeFileSync(path.join(work.designSystem, 'generated/button.js'), 'export const button = "edited";\n');
  const designCommit = commit(work.designSystem, 'edit generated output');
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, designCommit),
    git: makeInterfaces(work).git, deployRecord: { id: 'abc1234' },
  });
  assert.equal(report.engine_output_edited_after_run, true);
  assert.equal(report.job_passed, false);
});

test('criterion: an unpromoted draft keeps job_passed false', async (t) => {
  const work = makeWork(t);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, work.designBase),
    git: makeInterfaces(work).git, deployRecord: { id: 'abc1234' },
  });
  assert.equal(report.job_passed, false);
});

test('criterion: lifecycle plus app package and lock rewrites are excluded from output editing', async (t) => {
  const work = makeWork(t);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  const designCommit = promoteFixture(work, 'promote lifecycle');
  const packageFile = path.join(work.app, 'package.json');
  const pkg = readJson(packageFile);
  pkg.dependencies['@caelos/design-system'] = `git+https://example.invalid/design-system.git#${designCommit}`;
  writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(path.join(work.app, 'package-lock.json'), '{"pinned":true}\n');
  const appCommit = commit(work.app, 'pin package');
  writeFileSync(path.join(work.jobFolder, 'signoff.json'), `${JSON.stringify(promoteRecord(), null, 2)}\n`);
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, designCommit, { appMergeCommit: appCommit }),
    git: makeInterfaces(work).git, deployRecord: { id: 'abc1234' },
  });
  assert.equal(report.engine_output_edited_after_run, false);
  assert.equal(report.job_passed, true);
});

test('criterion: gate baseline and contract recorded and index files are included in output editing', async (t) => {
  const work = makeWork(t);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  const designCommit = promoteFixture(work);
  writeFileSync(path.join(work.app, 'gate-baseline.json'), '{"edited":true}\n');
  writeFileSync(path.join(work.app, 'lib/taskgraph-client/recorded.ts'), 'export const recorded = "edited";\n');
  writeFileSync(path.join(work.app, 'lib/taskgraph-client/index.ts'), 'export const index = "edited";\n');
  const appCommit = commit(work.app, 'edit included app outputs');
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, designCommit, { appMergeCommit: appCommit }),
    git: makeInterfaces(work).git, deployRecord: { id: 'abc1234' },
  });
  assert.equal(report.engine_output_edited_after_run, true);
  assert.equal(report.job_passed, false);
});

test('criterion: a refused model recorded in events makes job_passed false', async (t) => {
  const work = makeWork(t);
  const event = readJson(path.join(fixtureRoot, 'refused-model-event.json'));
  writeFileSync(path.join(work.jobFolder, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  const designCommit = promoteFixture(work);
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, designCommit),
    git: makeInterfaces(work).git, deployRecord: { id: 'abc1234' },
  });
  assert.ok(refusedModels.includes(event.model));
  assert.equal(report.job_passed, false);
});

test('criterion: pin moves the dependency, reinstalls, and commits the app branch', async (t) => {
  const work = makeWork(t);
  const calls = [];
  const result = await pinApp({
    appFolder: work.app, designSystemCommit: '1234567890abcdef', dependency: '@caelos/design-system',
    reinstall: async () => calls.push('reinstall'),
    git: { async commit() { calls.push('commit'); return 'app-pin-commit'; } },
  });
  assert.match(readJson(path.join(work.app, 'package.json')).dependencies['@caelos/design-system'], /#1234567890abcdef$/);
  assert.deepEqual(calls, ['reinstall', 'commit']);
  assert.equal(result.commit, 'app-pin-commit');
});

test('criterion: pin and app pull request are refused without a design-system merge commit', async (t) => {
  const work = makeWork(t);
  const interfaces = makeInterfaces(work);
  await finishJob({ ...interfaces, jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, jobFolders: [work.jobFolder] });
  const result = await finishJob({ ...interfaces, jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, jobFolders: [work.jobFolder] });
  assert.equal(result.status, 'waiting-design-system-merge');
  assert.equal(interfaces.calls.some(([kind]) => kind === 'reinstall'), false);
  assert.equal(interfaces.calls.some(([kind, repo]) => kind === 'open' && repo === 'fixture/app'), false);
});

test('criterion: app pull request is refused before the injected pin deployment step has run', async (t) => {
  const work = makeWork(t);
  const interfaces = makeInterfaces(work);
  await finishJob({ ...interfaces, jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, jobFolders: [work.jobFolder] });
  const designPull = interfaces.pullRequests.get('fixture/design-system');
  designPull.mergeCommit = work.designBase;
  designPull.mergedAt = '2026-11-26T11:00:00Z';
  const failingPin = async () => { throw new Error('pin deployment step has not run'); };
  await assert.rejects(
    finishJob({ ...interfaces, pin: failingPin, jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, jobFolders: [work.jobFolder] }),
    /pin deployment step/,
  );
  assert.equal(interfaces.calls.some(([kind, repo]) => kind === 'open' && repo === 'fixture/app'), false);
});

test('criterion: signoffs, gaps, and system-faithful are recomputed from every given job folder', async (t) => {
  const first = makeWork(t);
  const second = makeWork(t, { chain: 'expand', id: 'job-expand' });
  promoteFixture(second);
  writeFileSync(path.join(second.jobFolder, 'integrate.json'), '{"gaps":[{"entry":"invented.by.model","gapFill":"invented"}]}\n');
  await recomputeCrossJobEvidence({ jobFolders: [first.jobFolder, second.jobFolder], evidenceFolder: first.evidenceFolder });
  assert.deepEqual(readJson(path.join(first.evidenceFolder, 'signoffs.json')).jobs.map(({ job }) => job), ['job-apply', 'job-expand']);
  assert.equal(readJson(path.join(first.evidenceFolder, 'signoffs.json')).jobs_with_more_than_one_signoff, 0);
  assert.equal(readJson(path.join(first.evidenceFolder, 'gaps.json')).gaps.length, 2);
  assert.equal(readJson(path.join(first.evidenceFolder, 'gaps.json')).gaps_not_listed_at_signoff, 0);
  assert.equal(readJson(path.join(first.evidenceFolder, 'system-faithful.json')).names_not_reaching_tier_0, 0);
});

test('criterion: finish waits for the post-merge deploy record before writing evidence', async (t) => {
  const work = makeWork(t);
  const interfaces = makeInterfaces(work);
  const { options } = await advanceThroughPullRequests(work, interfaces);
  const result = await finishJob(options);
  assert.equal(result.status, 'waiting-deploy');
  assert.equal(existsSync(path.join(work.evidenceFolder, 'job-apply.json')), false);
});

test('attack: a promote record dated after the app merge yields job_passed false', async (t) => {
  const work = makeWork(t);
  writeFileSync(path.join(work.jobFolder, 'signoff.json'), `${JSON.stringify(promoteRecord('2026-11-27T00:00:00Z'), null, 2)}\n`);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  const designCommit = promoteFixture(work);
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, designCommit),
    git: makeInterfaces(work).git, deployRecord: { id: 'abc1234' },
  });
  assert.equal(report.job_passed, false);
});

test('model record: the harness reply model is written to node.exit in events.jsonl', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'engine-model-record-'));
  const source = path.join(root, 'source');
  const jobFolder = path.join(root, 'job');
  mkdirSync(source);
  mkdirSync(jobFolder);
  cpSync(path.join(repository, 'tests', 'fixtures', 'engine-adapter', 'instructions.md'), path.join(source, 'instructions.md'));
  cpSync(path.join(repository, 'tests', 'fixtures', 'engine-adapter', 'output.schema.json'), path.join(source, 'output.schema.json'));
  const harness = path.join(root, 'codex');
  cpSync(path.join(fixtureRoot, 'stub-codex.mjs'), harness);
  chmodSync(harness, 0o755);
  command(source, 'git', 'init', '-q');
  const base = commit(source, 'model fixture base');
  const expectedModel = readJson(path.join(fixtureRoot, 'refused-model-event.json')).model;
  writeFileSync(path.join(jobFolder, 'input.json'), '{}\n');
  writeFileSync(path.join(jobFolder, 'job.json'), '{"chain":"fixture-model-record"}\n');
  writeFileSync(path.join(jobFolder, 'chain.json'), `${JSON.stringify({
    chain: 'fixture-model-record', commit: base, steps: [{
      step: 'model', kind: 'model', instructions: 'instructions.md',
      schema: 'output.schema.json', inputs: ['input.json'], outputs: ['result.json'],
      check: 'npm run check:catalog',
    }],
  }, null, 2)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runJob(jobFolder, {
    harnessCheck() {},
    stepRunner({ row }) {
      return runCodexStep({
        gitRoot: source, baseCommit: base, jobFolder, step: row, command: harness,
      });
    },
    catalogCheck() {},
  });
  assert.equal(result.complete, true);
  const events = readFileSync(path.join(jobFolder, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const exit = events.find(({ kind }) => kind === 'node.exit');
  assert.equal(exit.model, expectedModel);
});

test('runner wiring: a paused finish step is resumed instead of recorded as complete', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'engine-finish-pause-'));
  const runnerRepository = path.join(root, 'repository');
  const jobFolder = path.join(root, 'job');
  const bin = path.join(root, 'bin');
  cpSync(path.join(repository, 'engine'), path.join(runnerRepository, 'engine'), { recursive: true });
  mkdirSync(path.join(runnerRepository, 'scripts'));
  cpSync(
    path.join(repository, 'scripts', 'check-recipes.mjs'),
    path.join(runnerRepository, 'scripts', 'check-recipes.mjs'),
  );
  mkdirSync(path.join(runnerRepository, 'tests', 'fixtures', 'engine-finish'), { recursive: true });
  cpSync(
    path.join(fixtureRoot, 'pause-step.mjs'),
    path.join(runnerRepository, 'tests', 'fixtures', 'engine-finish', 'pause-step.mjs'),
  );
  mkdirSync(jobFolder);
  mkdirSync(bin);
  const npm = path.join(bin, 'npm');
  writeFileSync(npm, '#!/bin/sh\nexit 0\n');
  chmodSync(npm, 0o755);
  writeFileSync(path.join(runnerRepository, 'engine', 'chains', 'fixture-finish-pause.chain.json'), `${JSON.stringify({
    chain: 'fixture-finish-pause', steps: [{
      step: 'finish', kind: 'script', script: 'tests/fixtures/engine-finish/pause-step.mjs',
      inputs: ['job.json'], outputs: ['finish.json'], check: 'npm run check:catalog',
    }],
  }, null, 2)}\n`);
  command(runnerRepository, 'git', 'init', '-q');
  const base = commit(runnerRepository, 'runner fixture base');
  writeFileSync(path.join(jobFolder, 'job.json'), '{"chain":"fixture-finish-pause"}\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invoke = () => spawnSync(
    process.execPath, [path.join(runnerRepository, 'engine', 'cli.mjs'), 'run', '--job', jobFolder],
    { cwd: runnerRepository, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } },
  );
  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readJson(path.join(jobFolder, 'chain.json')).commit, base);
  const second = invoke();
  assert.equal(second.status, 0, second.stderr);
  const events = readFileSync(path.join(jobFolder, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(({ kind }) => kind === 'run.pause').length, 2);
  assert.equal(events.some(({ kind }) => kind === 'node.exit'), false);
});
