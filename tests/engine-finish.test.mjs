import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { defaultDeployReader, finishJob } from '../engine/lib/finish.mjs';
import {
  captureEngineOutputHashes, recomputeCrossJobEvidence, storeEngineOutputHashes, writeJobEvidence,
} from '../engine/lib/evidence.mjs';
import { pinApp } from '../engine/steps/pin-app.mjs';
import { runCodexStep } from '../engine/adapters/codex.mjs';
import { runJob } from '../engine/lib/run.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = path.join(repository, 'tests', 'fixtures', 'engine-finish');
const refusedModels = JSON.parse(readFileSync(path.join(repository, 'engine', 'refused-models.json'), 'utf8')).models;
const outputHashesName = 'output-hashes.json';

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

function deployRecord(work, commit = work.appBase) {
  return { id: commit.slice(0, 7) };
}

function storeOutputHashes(work, snapshot = captureEngineOutputHashes(work.job.finish)) {
  writeFileSync(path.join(work.jobFolder, outputHashesName), `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
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
  for (const name of ['behaviour-results.json', 'gate-results.json', 'integrate.json', 'tier-zero-report.json']) {
    cpSync(path.join(fixtureRoot, 'facts', name), path.join(jobFolder, name));
  }
  if (signoff) writeFileSync(path.join(jobFolder, 'signoff.json'), `${JSON.stringify(promoteRecord(undefined, id), null, 2)}\n`);
  writeFileSync(path.join(jobFolder, 'events.jsonl'), `${JSON.stringify({
    seq: 1, kind: 'node.enter', run_id: 'fixture-run', node: 'craft', step: 'craft',
    ts: '2026-11-26T09:00:00.000Z', model: 'fixture-allowed-model', model_source: 'run-setting',
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
      tierZeroReport: 'tier-zero-report.json',
      integrateResults: 'integrate.json',
    },
  };
  writeFileSync(path.join(jobFolder, 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  writeFileSync(path.join(jobFolder, 'chain.json'), `${JSON.stringify({
    chain, commit: designBase, steps: [{
      step: 'craft', kind: 'model', instructions: 'instructions.md', schema: 'schema.json',
      inputs: ['input.json'], outputs: ['output.json'], check: 'npm run check:catalog',
    }],
  }, null, 2)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = { root, designSystem, app, jobFolder, evidenceFolder, designBase, appBase, job };
  storeOutputHashes(work);
  return work;
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

function writeEvents(work, records) {
  writeFileSync(path.join(work.jobFolder, 'events.jsonl'), records.map((record, index) => JSON.stringify({
    seq: index + 1,
    kind: 'node.enter',
    run_id: 'fixture-run',
    node: record.node,
    ts: '2026-11-26T09:00:00.000Z',
    ...(record.model === undefined ? {} : {
      step: record.node, model: record.model, model_source: 'run-setting',
    }),
  })).join('\n') + (records.length ? '\n' : ''));
}

async function passingEvidence(work, { designCommit, appCommit = work.appBase, deploy } = {}) {
  const mergedDesign = designCommit || promoteFixture(work);
  return writeJobEvidence({
    jobFolder: work.jobFolder,
    evidenceFolder: work.evidenceFolder,
    snapshot: readJson(path.join(work.jobFolder, outputHashesName)),
    state: passingState(work, mergedDesign, { appMergeCommit: appCommit }),
    git: makeInterfaces(work).git,
    deployRecord: deploy || deployRecord(work, appCommit),
  });
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
    async listFilesAt({ folder, commit: target, directory }) {
      const output = command(folder, 'git', 'ls-tree', '-r', '--name-only', target, '--', directory);
      return output ? output.split('\n') : [];
    },
    async isAncestor({ folder, ancestor, commit: target }) {
      const resolved = spawnSync('git', ['rev-parse', '--verify', `${target}^{commit}`], {
        cwd: folder, encoding: 'utf8',
      });
      if (resolved.status !== 0) return false;
      return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, resolved.stdout.trim()], {
        cwd: folder, encoding: 'utf8',
      }).status === 0;
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
  const options = { ...interfaces, jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder };
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
  const appCommit = command(work.app, 'git', 'rev-parse', 'HEAD');
  interfaces.setDeploy(deployRecord(work, appCommit));
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
    design_system_check_run_ids: [101], app_check_run_ids: [202], deploy_record: deployRecord(work, appCommit),
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
    git: makeInterfaces(work).git, deployRecord: deployRecord(work),
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
    git: makeInterfaces(work).git, deployRecord: deployRecord(work),
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
    git: makeInterfaces(work).git, deployRecord: deployRecord(work, appCommit),
  });
  assert.equal(report.engine_output_edited_after_run, false);
  assert.equal(report.job_passed, true);
});

test('criterion: gate baseline is independently included in output editing', async (t) => {
  const work = makeWork(t);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  const designCommit = promoteFixture(work);
  writeFileSync(path.join(work.app, 'gate-baseline.json'), '{"edited":true}\n');
  const appCommit = commit(work.app, 'edit gate baseline');
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, designCommit, { appMergeCommit: appCommit }),
    git: makeInterfaces(work).git, deployRecord: deployRecord(work, appCommit),
  });
  assert.equal(report.engine_output_edited_after_run, true);
  assert.equal(report.job_passed, false);
});

test('criterion: contract recorded and index files are included in output editing', async (t) => {
  const work = makeWork(t);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  const designCommit = promoteFixture(work);
  writeFileSync(path.join(work.app, 'lib/taskgraph-client/recorded.ts'), 'export const recorded = "edited";\n');
  writeFileSync(path.join(work.app, 'lib/taskgraph-client/index.ts'), 'export const index = "edited";\n');
  const appCommit = commit(work.app, 'edit contract outputs');
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, designCommit, { appMergeCommit: appCommit }),
    git: makeInterfaces(work).git, deployRecord: deployRecord(work, appCommit),
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
    git: makeInterfaces(work).git, deployRecord: deployRecord(work),
  });
  assert.ok(refusedModels.includes(event.model));
  assert.equal(report.job_passed, false);
});

const [firstRefusedFamily, secondRefusedFamily] = refusedModels;
const refusedRecordedIds = [
  `x-${firstRefusedFamily.toLowerCase()}-4-5`,
  firstRefusedFamily,
  `${secondRefusedFamily.toLowerCase()}-1`,
  secondRefusedFamily.toUpperCase(),
  `${firstRefusedFamily.toLowerCase()}4`,
  `${firstRefusedFamily}4.5`,
  `${secondRefusedFamily.toLowerCase()}2`,
];

for (const [index, model] of refusedRecordedIds.entries()) {
  test(`E1: refused family variant ${index + 1} keeps job_passed false`, async (t) => {
    const work = makeWork(t);
    writeEvents(work, [{ node: 'craft', model }]);
    assert.equal((await passingEvidence(work)).job_passed, false);
  });
}

test('E1: family letters inside a longer token remain allowed', async (t) => {
  const work = makeWork(t);
  writeEvents(work, [{ node: 'craft', model: `pre${firstRefusedFamily.toLowerCase()}post-1` }]);
  assert.equal((await passingEvidence(work)).job_passed, true);
});

test('E2: a model step exit without a recorded model is named and fails the job', async (t) => {
  const work = makeWork(t);
  writeEvents(work, [{ node: 'craft' }]);
  const report = await passingEvidence(work);
  assert.deepEqual(report.model_steps_missing_records, ['craft']);
  assert.equal(report.job_passed, false);
});

test('E2: a missing event log names every unrecorded model step and fails the job', async (t) => {
  const work = makeWork(t);
  rmSync(path.join(work.jobFolder, 'events.jsonl'));
  const report = await passingEvidence(work);
  assert.deepEqual(report.model_steps_missing_records, ['craft']);
  assert.equal(report.job_passed, false);
});

test('E3: drafts are found in the merge catalog', async (t) => {
  const work = makeWork(t);
  const report = await passingEvidence(work, { designCommit: work.designBase });
  assert.equal(report.job_passed, false);
});

test('round 2: an undeclared tier catalog draft from this job fails finish', async (t) => {
  const work = makeWork(t);
  promoteFixture(work);
  const undeclared = 'token_catalog/03-undeclared.fixture.json';
  writeFileSync(path.join(work.designSystem, undeclared), `${JSON.stringify({
    patterns: {
      menu: {
        $extensions: {
          'app.caelos': { lifecycle: 'draft', draftedBy: work.job.id },
        },
      },
    },
  }, null, 2)}\n`);
  const designCommit = commit(work.designSystem, 'add undeclared tier draft');
  const report = await passingEvidence(work, { designCommit });
  assert.equal(report.job_passed, false);
  assert.deepEqual(report.draft_catalog_entries, [{ file: undeclared, id: 'patterns.menu' }]);
});

test('E4: the runner stores output hashes immediately before entering finish', async (t) => {
  const work = makeWork(t);
  const runnerRepository = path.join(work.root, 'runner-repository');
  cpSync(path.join(repository, 'engine'), path.join(runnerRepository, 'engine'), { recursive: true });
  mkdirSync(path.join(runnerRepository, 'scripts'));
  cpSync(
    path.join(repository, 'scripts', 'check-recipes.mjs'),
    path.join(runnerRepository, 'scripts', 'check-recipes.mjs'),
  );
  command(runnerRepository, 'git', 'init', '-q');
  commit(runnerRepository, 'runner fixture base');
  const { runJob: runRunnerJob } = await import(
    pathToFileURL(path.join(runnerRepository, 'engine', 'lib', 'run.mjs')).href,
  );
  rmSync(path.join(work.jobFolder, outputHashesName));
  rmSync(path.join(work.jobFolder, 'events.jsonl'));
  rmSync(path.join(work.jobFolder, 'chain.json'));
  const job = readJson(path.join(work.jobFolder, 'job.json'));
  job.chain = 'apply';
  writeFileSync(path.join(work.jobFolder, 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  const result = runRunnerJob(work.jobFolder, {
    model: 'fixture-allowed-model',
    harnessCheck() {},
    catalogCheck() {},
    stepRunner({ row }) {
      if (row.step === 'count-handlers') {
        writeFileSync(path.join(work.designSystem, 'generated/button.js'), 'export const button = "run complete";\n');
      }
      if (row.step === 'finish') {
        assert.equal(existsSync(path.join(work.jobFolder, outputHashesName)), true);
        const pause = new Error('waiting for merge');
        pause.exitCode = 75;
        throw pause;
      }
      return row.kind === 'model' ? { model: 'fixture-allowed-model' } : {};
    },
  });
  assert.equal(result.complete, false);
  assert.deepEqual(
    readJson(path.join(work.jobFolder, outputHashesName)),
    captureEngineOutputHashes(work.job.finish),
  );
});

test('E4: an edit made after the run snapshot but before finish is detected', async (t) => {
  const work = makeWork(t);
  writeFileSync(path.join(work.designSystem, 'generated/button.js'), 'export const button = "after run";\n');
  const designCommit = promoteFixture(work, 'edit after run and merge');
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder,
    evidenceFolder: work.evidenceFolder,
    snapshot: readJson(path.join(work.jobFolder, outputHashesName)),
    state: passingState(work, designCommit),
    git: makeInterfaces(work).git,
    deployRecord: deployRecord(work),
  });
  assert.equal(report.engine_output_edited_after_run, true);
  assert.equal(report.job_passed, false);
});

test('E4: finish reads the runner snapshot instead of recapturing edited outputs', async (t) => {
  const work = makeWork(t);
  writeFileSync(path.join(work.designSystem, 'generated/button.js'), 'export const button = "between run and finish";\n');
  commit(work.designSystem, 'edit between run and finish');
  const interfaces = makeInterfaces(work);
  const { options } = await advanceThroughPullRequests(work, interfaces);
  const appCommit = command(work.app, 'git', 'rev-parse', 'HEAD');
  interfaces.setDeploy(deployRecord(work, appCommit));
  assert.equal((await finishJob(options)).status, 'complete');
  const report = readJson(path.join(work.evidenceFolder, 'job-apply.json'));
  assert.equal(report.engine_output_edited_after_run, true);
  assert.equal(report.job_passed, false);
});

test('round 2: the run-end output hash snapshot cannot be rewritten on resume', (t) => {
  const work = makeWork(t);
  const snapshotFile = path.join(work.jobFolder, outputHashesName);
  const original = readJson(snapshotFile);
  writeFileSync(path.join(work.designSystem, 'generated/button.js'), 'export const button = "edited after run";\n');
  assert.deepEqual(storeEngineOutputHashes(work.jobFolder, work.job.finish), original);
  assert.deepEqual(readJson(snapshotFile), original);
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

test('B5: finish reads the gate and Expand tier-zero owners into system-faithful evidence', async (t) => {
  const first = makeWork(t);
  const second = makeWork(t, { chain: 'expand', id: 'job-expand' });
  promoteFixture(second);
  writeFileSync(path.join(first.jobFolder, 'gate-results.json'), JSON.stringify({
    errors: 0,
    namesNotReachingTier0: [{ name: '--app-local', file: 'app/page.css', line: 3, stopsAt: '7px' }],
  }));
  writeFileSync(path.join(second.jobFolder, 'tier-zero-report.json'), JSON.stringify({
    namesNotReachingTier0: [{
      name: 'controls.button', file: '02-controls.fixture.json', line: 0, stopsAt: '7px',
    }],
  }));
  writeFileSync(path.join(second.jobFolder, 'integrate.json'), '{"gaps":[{"entry":"invented.by.model","gapFill":"invented"}]}\n');
  await recomputeCrossJobEvidence({ jobFolders: [first.jobFolder, second.jobFolder], evidenceFolder: first.evidenceFolder });
  assert.deepEqual(readJson(path.join(first.evidenceFolder, 'signoffs.json')).jobs.map(({ job }) => job), ['job-apply', 'job-expand']);
  assert.equal(readJson(path.join(first.evidenceFolder, 'signoffs.json')).jobs_with_more_than_one_signoff, 0);
  assert.equal(readJson(path.join(first.evidenceFolder, 'gaps.json')).gaps.length, 2);
  assert.equal(readJson(path.join(first.evidenceFolder, 'gaps.json')).gaps_not_listed_at_signoff, 0);
  const report = readJson(path.join(first.evidenceFolder, 'system-faithful.json'));
  assert.deepEqual(report.jobs, ['job-apply', 'job-expand']);
  assert.deepEqual(report.names_not_reaching_tier_0, [
    { job: 'job-apply', name: '--app-local', file: 'app/page.css', line: 3, stopsAt: '7px' },
    { job: 'job-expand', name: 'controls.button', file: '02-controls.fixture.json', line: 0, stopsAt: '7px' },
  ]);
  assert.deepEqual(report.names_not_reaching_tier_0_source, [
    { job: 'job-apply', owner: 'enforcer gate', file: 'gate-results.json' },
    { job: 'job-expand', owner: 'lock build', file: 'tier-zero-report.json' },
  ]);
});

test('tier-zero owner: an entry in an unchanged app file has an empty job share', async (t) => {
  const work = makeWork(t);
  writeFileSync(path.join(work.jobFolder, 'gate-results.json'), JSON.stringify({
    errors: 0,
    namesNotReachingTier0: [{ name: '--local', file: 'app/globals.css', line: 1, stopsAt: '7px' }],
  }));
  writeFileSync(path.join(work.app, 'app/page.tsx'), 'export default function Page() { return "changed"; }\n');
  const appCommit = commit(work.app, 'change app output');
  storeOutputHashes(work);
  const report = await passingEvidence(work, { appCommit });
  assert.deepEqual(report.names_not_reaching_tier_0, []);
  assert.equal(report.job_passed, true);
});

test('tier-zero owner: an entry in a changed app file makes job_passed false', async (t) => {
  const work = makeWork(t);
  writeFileSync(path.join(work.jobFolder, 'gate-results.json'), JSON.stringify({
    errors: 0,
    namesNotReachingTier0: [{ name: '--local', file: 'app/page.tsx', line: 1, stopsAt: '7px' }],
  }));
  writeFileSync(path.join(work.app, 'app/page.tsx'), 'export default function Page() { return "changed"; }\n');
  const appCommit = commit(work.app, 'change app output');
  storeOutputHashes(work);
  const report = await passingEvidence(work, { appCommit });
  assert.deepEqual(report.names_not_reaching_tier_0, [
    { name: '--local', file: 'app/page.tsx', line: 1, stopsAt: '7px' },
  ]);
  assert.equal(report.job_passed, false);
});

test('tier-zero owner: an Expand report entry outside the signoff has an empty share', async (t) => {
  const work = makeWork(t, { chain: 'expand', id: 'job-expand' });
  writeFileSync(path.join(work.jobFolder, 'tier-zero-report.json'), JSON.stringify({
    namesNotReachingTier0: [{
      name: 'controls.shared.local', file: '02-controls.tokens.json', line: 0, stopsAt: '7px',
    }],
  }));
  const designCommit = promoteFixture(work);
  storeOutputHashes(work);
  const report = await passingEvidence(work, { designCommit });
  assert.deepEqual(report.names_not_reaching_tier_0, []);
  assert.equal(report.job_passed, true);
});

test('tier-zero owner: an Expand report entry in the signoff makes job_passed false', async (t) => {
  const work = makeWork(t, { chain: 'expand', id: 'job-expand' });
  writeFileSync(path.join(work.jobFolder, 'tier-zero-report.json'), JSON.stringify({
    namesNotReachingTier0: [{
      name: 'controls.button', file: '02-controls.fixture.json', line: 0, stopsAt: '7px',
    }],
  }));
  const report = await passingEvidence(work);
  assert.deepEqual(report.names_not_reaching_tier_0, [{
    name: 'controls.button', file: '02-controls.fixture.json', line: 0, stopsAt: '7px',
  }]);
  assert.equal(report.job_passed, false);
});

test('tier-zero owner: a missing Expand report throws with the job and file', async (t) => {
  const work = makeWork(t, { chain: 'expand', id: 'job-expand' });
  rmSync(path.join(work.jobFolder, 'tier-zero-report.json'));
  await assert.rejects(
    recomputeCrossJobEvidence({ jobFolders: [work.jobFolder], evidenceFolder: work.evidenceFolder }),
    /job-expand.*tier-zero-report\.json.*cannot be read/,
  );
});

test('attack: a gate owner without the tier-zero array is refused with the job and file', async (t) => {
  const work = makeWork(t);
  writeFileSync(path.join(work.jobFolder, 'gate-results.json'), '{"errors":0}\n');
  await assert.rejects(
    recomputeCrossJobEvidence({ jobFolders: [work.jobFolder], evidenceFolder: work.evidenceFolder }),
    /job-apply.*gate-results\.json.*no namesNotReachingTier0 array/,
  );
});

test('B6: a stale or unrelated deploy id fails the job', async (t) => {
  const work = makeWork(t);
  const report = await passingEvidence(work, { deploy: { id: work.designBase.slice(0, 7) } });
  assert.equal(report.deploy_matches_app_merge, false);
  assert.equal(report.job_passed, false);
});

test('B6: a deploy commit descended from the app merge commit is accepted', async (t) => {
  const work = makeWork(t);
  writeFileSync(path.join(work.app, 'app/page.tsx'), 'export default function Page() { return "deployed"; }\n');
  const deployedCommit = commit(work.app, 'deploy descendant');
  const report = await passingEvidence(work, {
    appCommit: work.appBase,
    deploy: { id: deployedCommit.slice(0, 7) },
  });
  assert.equal(report.deploy_matches_app_merge, true);
  assert.equal(report.job_passed, true);
});

test('B7: CLI aggregates every explicit job with non-zero cross-job counts', (t) => {
  const first = makeWork(t);
  const second = makeWork(t, { chain: 'expand', id: 'job-expand' });
  promoteFixture(second);
  writeFileSync(path.join(first.jobFolder, 'signoff-extra.json'), `${JSON.stringify(promoteRecord(undefined, first.job.id), null, 2)}\n`);
  writeFileSync(path.join(second.jobFolder, 'signoff.json'), `${JSON.stringify({
    ...promoteRecord(undefined, second.job.id), promoted: [],
  }, null, 2)}\n`);
  const result = spawnSync(process.execPath, [
    path.join(repository, 'engine', 'cli.mjs'), 'evidence',
    '--job', first.jobFolder, '--job', second.jobFolder, '--evidence', first.evidenceFolder,
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(first.evidenceFolder, 'signoffs.json')).jobs_with_more_than_one_signoff, 1);
  assert.equal(readJson(path.join(first.evidenceFolder, 'gaps.json')).gaps_not_listed_at_signoff, 1);
});

test('B7: CLI discovers every job beneath a jobs root', (t) => {
  const first = makeWork(t);
  const second = makeWork(t, { chain: 'expand', id: 'job-expand' });
  const jobsRoot = path.join(first.root, 'jobs');
  mkdirSync(jobsRoot);
  cpSync(first.jobFolder, path.join(jobsRoot, 'apply'), { recursive: true });
  cpSync(second.jobFolder, path.join(jobsRoot, 'expand'), { recursive: true });
  const result = spawnSync(process.execPath, [
    path.join(repository, 'engine', 'cli.mjs'), 'evidence',
    '--jobs-root', jobsRoot, '--evidence', first.evidenceFolder,
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readJson(path.join(first.evidenceFolder, 'signoffs.json')).jobs.map(({ job }) => job),
    ['job-apply', 'job-expand'],
  );
});

test('round 2: finish recomputes all cross-job files from every sibling job', async (t) => {
  const first = makeWork(t);
  const second = makeWork(t, { chain: 'expand', id: 'job-expand' });
  promoteFixture(second);
  cpSync(second.jobFolder, path.join(first.root, 'job-expand'), { recursive: true });
  const interfaces = makeInterfaces(first);
  const { options, appPull } = await advanceThroughPullRequests(first, interfaces);
  interfaces.setDeploy(deployRecord(first, appPull.mergeCommit));
  const result = await finishJob(options);
  assert.equal(result.status, 'complete');
  assert.deepEqual(
    readJson(path.join(first.evidenceFolder, 'signoffs.json')).jobs.map(({ job }) => job),
    ['job-apply', 'job-expand'],
  );
  assert.deepEqual(
    [...new Set(readJson(path.join(first.evidenceFolder, 'gaps.json')).gaps.map(({ job }) => job))],
    ['job-apply', 'job-expand'],
  );
  assert.deepEqual(
    readJson(path.join(first.evidenceFolder, 'system-faithful.json')).jobs,
    ['job-apply', 'job-expand'],
  );
});

for (const [label, output] of [['empty', ''], ['malformed', 'not-a-commit']]) {
  test(`deploy reader: ${label} output is rejected`, async (t) => {
    const original = process.env.CAELOS_DEPLOY_ID_COMMAND;
    process.env.CAELOS_DEPLOY_ID_COMMAND = JSON.stringify([process.execPath, '-e', `process.stdout.write(${JSON.stringify(output)})`]);
    t.after(() => {
      if (original === undefined) delete process.env.CAELOS_DEPLOY_ID_COMMAND;
      else process.env.CAELOS_DEPLOY_ID_COMMAND = original;
    });
    await assert.rejects(defaultDeployReader.read(), /short hexadecimal commit id/);
  });
}

test('round 2: finish waits for a matching deploy before writing evidence and resumes afterward', async (t) => {
  const work = makeWork(t);
  const interfaces = makeInterfaces(work);
  const { options, appPull } = await advanceThroughPullRequests(work, interfaces);
  assert.equal((await finishJob(options)).status, 'waiting-deploy');
  interfaces.setDeploy({ id: work.designBase.slice(0, 7) });
  assert.equal((await finishJob(options)).status, 'waiting-deploy');
  assert.equal(existsSync(path.join(work.evidenceFolder, 'job-apply.json')), false);
  assert.equal(Object.hasOwn(readJson(path.join(work.jobFolder, 'finish.json')), 'report'), false);
  interfaces.setDeploy(deployRecord(work, appPull.mergeCommit));
  const resumed = await finishJob(options);
  assert.equal(resumed.status, 'complete');
  assert.equal(readJson(path.join(work.evidenceFolder, 'job-apply.json')).job_passed, true);
});

test('attack: a promote record dated after the app merge yields job_passed false', async (t) => {
  const work = makeWork(t);
  writeFileSync(path.join(work.jobFolder, 'signoff.json'), `${JSON.stringify(promoteRecord('2026-11-27T00:00:00Z'), null, 2)}\n`);
  const snapshot = captureEngineOutputHashes(work.job.finish);
  const designCommit = promoteFixture(work);
  const report = await writeJobEvidence({
    jobFolder: work.jobFolder, evidenceFolder: work.evidenceFolder, snapshot,
    state: passingState(work, designCommit),
    git: makeInterfaces(work).git, deployRecord: deployRecord(work),
  });
  assert.equal(report.job_passed, false);
});

test('model record: the run setting is written before the model step and ignores stream content', (t) => {
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
  const expectedModel = 'fixture-run-model';
  let observedBeforeStep = false;
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
    model: expectedModel,
    harnessCheck() {},
    stepRunner({ row }) {
      const beforeStep = readFileSync(path.join(jobFolder, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      observedBeforeStep = beforeStep.some(({ kind, step, model, model_source: source }) => (
        kind === 'node.enter' && step === row.step && model === expectedModel && source === 'run-setting'
      ));
      return runCodexStep({
        gitRoot: source, baseCommit: base, jobFolder, step: row, command: harness,
        model: expectedModel,
      });
    },
    catalogCheck() {},
  });
  assert.equal(result.complete, true);
  assert.equal(observedBeforeStep, true);
  const events = readFileSync(path.join(jobFolder, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const record = events.find(({ kind }) => kind === 'node.enter');
  assert.deepEqual(
    { step: record.step, model: record.model, model_source: record.model_source },
    { step: 'model', model: expectedModel, model_source: 'run-setting' },
  );
});

test('runner refuses a model chain with no run setting before writing events', (t) => {
  const work = makeWork(t);
  rmSync(path.join(work.jobFolder, 'events.jsonl'));
  assert.throws(
    () => runJob(work.jobFolder, { harnessCheck() {}, catalogCheck() {}, stepRunner() {} }),
    /--model.*CAELOS_STEP_MODEL/,
  );
  assert.equal(existsSync(path.join(work.jobFolder, 'events.jsonl')), false);
});

test('runner uses CAELOS_STEP_MODEL when the CLI run setting is absent', (t) => {
  const work = makeWork(t);
  rmSync(path.join(work.jobFolder, 'events.jsonl'));
  const previous = process.env.CAELOS_STEP_MODEL;
  process.env.CAELOS_STEP_MODEL = 'fixture-env-model';
  t.after(() => {
    if (previous === undefined) delete process.env.CAELOS_STEP_MODEL;
    else process.env.CAELOS_STEP_MODEL = previous;
  });
  assert.equal(runJob(work.jobFolder, {
    harnessCheck() {}, catalogCheck() {}, stepRunner() {},
  }).complete, true);
  const events = readFileSync(path.join(work.jobFolder, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find(({ kind }) => kind === 'node.enter').model, 'fixture-env-model');
});

test('runner refuses a refused run setting before the harness or step can run', (t) => {
  const work = makeWork(t);
  rmSync(path.join(work.jobFolder, 'events.jsonl'));
  let started = false;
  assert.throws(() => runJob(work.jobFolder, {
    model: refusedModels[0],
    harnessCheck() { started = true; },
    catalogCheck() {},
    stepRunner() { started = true; },
  }), /refused model/i);
  assert.equal(started, false);
  assert.equal(existsSync(path.join(work.jobFolder, 'events.jsonl')), false);
});

test('finish skips a sibling without finish and writes the complete evidence set', async (t) => {
  const work = makeWork(t);
  const sibling = path.join(work.root, 'unfinished');
  mkdirSync(sibling);
  writeFileSync(path.join(sibling, 'job.json'), '{"id":"job-unfinished","chain":"apply"}\n');
  const interfaces = makeInterfaces(work);
  const { options, appPull } = await advanceThroughPullRequests(work, interfaces);
  interfaces.setDeploy(deployRecord(work, appPull.mergeCommit));
  assert.equal((await finishJob(options)).status, 'complete');
  for (const name of ['job-apply.json', 'signoffs.json', 'gaps.json', 'system-faithful.json']) {
    assert.equal(existsSync(path.join(work.evidenceFolder, name)), true);
  }
  for (const name of ['signoffs.json', 'gaps.json', 'system-faithful.json']) {
    assert.deepEqual(readJson(path.join(work.evidenceFolder, name)).skipped_jobs, [
      { job: 'job-unfinished', reason: 'job has not reached finish' },
    ]);
  }
});

test('finish writes no evidence file when a sibling read fails', async (t) => {
  const work = makeWork(t);
  const sibling = path.join(work.root, 'broken');
  mkdirSync(sibling);
  writeFileSync(path.join(sibling, 'job.json'), '{not json}\n');
  const interfaces = makeInterfaces(work);
  const { options, appPull } = await advanceThroughPullRequests(work, interfaces);
  interfaces.setDeploy(deployRecord(work, appPull.mergeCommit));
  await assert.rejects(finishJob(options), /job\.json is not valid JSON/);
  for (const name of ['job-apply.json', 'signoffs.json', 'gaps.json', 'system-faithful.json']) {
    assert.equal(existsSync(path.join(work.evidenceFolder, name)), false);
  }
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
