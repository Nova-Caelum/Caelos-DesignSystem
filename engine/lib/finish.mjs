import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readEngineOutputHashes, recomputeCrossJobEvidence, writeJobEvidence,
} from './evidence.mjs';
import { pinApp } from '../steps/pin-app.mjs';

const stateName = 'finish-state.json';

function json(file, label = file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} cannot be read as JSON: ${error.message}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function commandJson(command, args, cwd) {
  return JSON.parse(execFileSync(command, args, { cwd, encoding: 'utf8' }));
}

const defaultGithub = {
  async openPullRequest({ repository, base, head, title }) {
    const url = execFileSync('gh', [
      'pr', 'create', '--repo', repository, '--base', base, '--head', head,
      '--title', title, '--body', 'Opened by the Caelos engine finish step.',
    ], { encoding: 'utf8' }).trim();
    const number = Number(url.split('/').at(-1));
    if (!Number.isInteger(number)) throw new Error(`GitHub did not return a pull request number: ${url}`);
    return { number };
  },
  async getPullRequest({ repository, number }) {
    const value = commandJson('gh', ['pr', 'view', String(number), '--repo', repository, '--json', 'number,mergeCommit,mergedAt']);
    return { number: value.number, mergeCommit: value.mergeCommit?.oid || null, mergedAt: value.mergedAt || null };
  },
  async getCheckRuns({ repository, commit }) {
    return commandJson('gh', ['api', `repos/${repository}/commits/${commit}/check-runs`]).check_runs
      .map(({ id, conclusion }) => ({ id, conclusion }));
  },
};

const defaultGit = {
  async push({ folder, head }) {
    execFileSync('git', ['push', '-u', 'origin', head], { cwd: folder, stdio: 'inherit' });
  },
  async changedFiles({ folder, baseCommit, commit }) {
    const text = execFileSync('git', ['diff', '--name-only', baseCommit, commit], { cwd: folder, encoding: 'utf8' }).trim();
    return text ? text.split('\n') : [];
  },
  async readFileAt({ folder, commit, file }) {
    return execFileSync('git', ['show', `${commit}:${file}`], { cwd: folder });
  },
  async isAncestor({ folder, ancestor, commit }) {
    try {
      const resolved = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
        cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      execFileSync('git', ['merge-base', '--is-ancestor', ancestor, resolved], {
        cwd: folder, stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  },
};

export const defaultDeployReader = {
  async read() {
    let argv;
    try {
      argv = JSON.parse(process.env.CAELOS_DEPLOY_ID_COMMAND || 'null');
    } catch {
      throw new Error('CAELOS_DEPLOY_ID_COMMAND must be a JSON array containing a command and its arguments');
    }
    if (!Array.isArray(argv) || !argv.length || !argv.every((part) => typeof part === 'string')) {
      throw new Error('set CAELOS_DEPLOY_ID_COMMAND to a JSON command array before reading the deploy record');
    }
    const id = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' }).trim();
    if (!/^[0-9a-f]{7,}$/i.test(id)) throw new Error('the configured deploy reader did not return a short hexadecimal commit id');
    return { id };
  },
};

function successful(checks) {
  return checks.length > 0 && checks.every(({ conclusion }) => conclusion === 'success');
}

function result(jobFolder, state, status) {
  const value = { status, ...state };
  writeJson(path.join(jobFolder, 'finish.json'), value);
  return value;
}

function requirePromoteRecord(jobFolder) {
  const file = path.join(jobFolder, 'signoff.json');
  if (!existsSync(file)) throw new Error('finish refuses to open a pull request until the job folder holds a promote record');
  const record = json(file, 'signoff.json');
  if (record.status !== 'promoted') throw new Error('finish refuses to open a pull request until the promote record is complete');
  return record;
}

export async function finishJob({
  jobFolder, evidenceFolder, jobFolders = [jobFolder], github = defaultGithub, git = defaultGit,
  deployReader = defaultDeployReader, pin = pinApp,
}) {
  const job = json(path.join(jobFolder, 'job.json'), 'job.json');
  if (!job.finish || !job.finish.designSystem) throw new Error('job.json must contain finish.designSystem configuration');
  requirePromoteRecord(jobFolder);
  const evidence = evidenceFolder || job.finish.evidenceFolder;
  if (!evidence) throw new Error('finish requires an evidence folder argument or job.finish.evidenceFolder');
  const outputHashes = readEngineOutputHashes(jobFolder);
  const stateFile = path.join(jobFolder, stateName);
  const state = existsSync(stateFile) ? json(stateFile, stateName) : {};
  const save = () => writeJson(stateFile, state);
  const design = job.finish.designSystem;

  if (!state.designSystemPullRequest) {
    await git.push({ folder: design.folder, head: design.head });
    const opened = await github.openPullRequest({
      repository: design.repository, base: design.base, head: design.head,
      title: `${job.id}: design-system outputs`,
    });
    state.designSystemPullRequest = opened.number;
    save();
    return result(jobFolder, state, 'waiting-design-system-merge');
  }

  const designPull = await github.getPullRequest({
    repository: design.repository, number: state.designSystemPullRequest,
  });
  if (!designPull.mergeCommit) return result(jobFolder, state, 'waiting-design-system-merge');
  state.designSystemMergeCommit = designPull.mergeCommit;
  const designChecks = await github.getCheckRuns({ repository: design.repository, commit: designPull.mergeCommit });
  if (!successful(designChecks)) return result(jobFolder, state, 'waiting-design-system-checks');
  state.designSystemCheckRunIds = designChecks;
  save();

  if (!job.finish.app) {
    const report = await writeJobEvidence({
      jobFolder, evidenceFolder: evidence, snapshot: outputHashes, state, git, deployRecord: null,
    });
    await recomputeCrossJobEvidence({ jobFolders, evidenceFolder: evidence });
    state.report = report;
    save();
    return result(jobFolder, state, 'complete');
  }

  const app = job.finish.app;
  if (!state.pinCommit) {
    const pinned = await pin({
      appFolder: app.folder, designSystemCommit: state.designSystemMergeCommit,
      dependency: app.dependency,
    });
    if (!pinned?.commit) throw new Error('pin deployment step did not return an app commit; the app pull request is refused');
    state.pinCommit = pinned.commit;
    save();
  }
  if (!state.appPullRequest) {
    await git.push({ folder: app.folder, head: app.head });
    const opened = await github.openPullRequest({
      repository: app.repository, base: app.base, head: app.head,
      title: `${job.id}: app integration`,
    });
    state.appPullRequest = opened.number;
    save();
    return result(jobFolder, state, 'waiting-app-merge');
  }

  const appPull = await github.getPullRequest({ repository: app.repository, number: state.appPullRequest });
  if (!appPull.mergeCommit) return result(jobFolder, state, 'waiting-app-merge');
  state.appMergeCommit = appPull.mergeCommit;
  state.appMergedAt = appPull.mergedAt;
  const appChecks = await github.getCheckRuns({ repository: app.repository, commit: appPull.mergeCommit });
  if (!successful(appChecks)) return result(jobFolder, state, 'waiting-app-checks');
  state.appCheckRunIds = appChecks;
  const deployRecord = await deployReader.read({ appMergeCommit: state.appMergeCommit });
  if (!deployRecord) {
    save();
    return result(jobFolder, state, 'waiting-deploy');
  }
  state.deployRecord = deployRecord;
  const report = await writeJobEvidence({
    jobFolder, evidenceFolder: evidence, snapshot: outputHashes, state, git, deployRecord,
  });
  await recomputeCrossJobEvidence({ jobFolders, evidenceFolder: evidence });
  state.report = report;
  save();
  return result(jobFolder, state, 'complete');
}

async function main() {
  const jobIndex = process.argv.indexOf('--job');
  const evidenceIndex = process.argv.indexOf('--evidence');
  const jobFolder = jobIndex >= 0 ? process.argv[jobIndex + 1] : null;
  const evidenceFolder = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
  if (!jobFolder) throw new Error('usage: finish <name> --job <folder> [--evidence <folder>]');
  const value = await finishJob({ jobFolder, evidenceFolder });
  if (value.status !== 'complete') process.exitCode = 75;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  });
}
