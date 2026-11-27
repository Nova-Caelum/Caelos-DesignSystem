import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCatalogCase, loadProofCaseFile } from './prove-tier-drift.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--case') options.caseFile = path.resolve(argv[++index] ?? '');
    else if (argument === '--used-cases') options.usedCases = path.resolve(argv[++index] ?? '');
    else if (argument === '--evidence') options.evidence = path.resolve(argv[++index] ?? '');
    else throw new Error(`unknown argument: ${argument}`);
  }
  assert.ok(options.caseFile, '--case is required');
  return options;
}

function command(bin, args, cwd = project) {
  return spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}

function readUsed(filename) {
  if (!filename) return { shape: 'object', names: [] };
  const parsed = JSON.parse(readFileSync(filename, 'utf8'));
  const names = Array.isArray(parsed) ? parsed : parsed?.used;
  assert.ok(Array.isArray(names) && names.every((name) => typeof name === 'string' && name.length > 0), `${filename}: used cases must be an array of names`);
  return { shape: Array.isArray(parsed) ? 'array' : 'object', names };
}

function writeUsed(filename, used, caseName) {
  const names = [...used.names, caseName];
  const value = used.shape === 'array' ? names : { used: names };
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function waitForExpectedFailure(prNumber, expectedCheck) {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = command('gh', ['pr', 'checks', String(prNumber), '--json', 'name,bucket,link,state']);
    if (response.status === 0 || response.status === 1) {
      const checks = JSON.parse(response.stdout || '[]');
      const check = checks.find((entry) => entry.name === expectedCheck);
      if (check && check.bucket === 'fail') {
        return { ...check, runId: check.link?.match(/\/runs\/(\d+)/u)?.[1] ?? null };
      }
      if (check && ['pass', 'cancel', 'skipping'].includes(check.bucket)) {
        throw new Error(`${expectedCheck} did not fail; observed ${check.bucket}`);
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
  throw new Error(`timed out waiting for ${expectedCheck} to fail`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const proofCase = loadProofCaseFile(options.caseFile);
  assert.equal(proofCase.kind, 'non-token-merge', `${proofCase.name}: case is not a merge-block proof`);
  const used = readUsed(options.usedCases);
  assert.ok(!used.names.includes(proofCase.name), `${proofCase.name}: already used`);

  if (options.dryRun) {
    console.log('DRY RUN');
    console.log(`branch: ${proofCase.branch}`);
    console.log(`file: ${proofCase.file}`);
    console.log(`expected failing check: ${proofCase.check}`);
    return;
  }

  assert.ok(options.usedCases, `${proofCase.name}: --used-cases is required for a real proof`);
  assert.ok(options.evidence, `${proofCase.name}: --evidence is required for a real proof`);
  assert.equal(requireSuccess(command('git', ['status', '--porcelain']), 'inspect worktree'), '', 'real merge proof requires a clean worktree');

  const remote = requireSuccess(command('git', ['remote', 'get-url', 'origin']), 'read origin');
  const temporary = mkdtempSync(path.join(tmpdir(), 'caelos-merge-block-'));
  const clone = path.join(temporary, 'repo');
  let prNumber;
  let failedCheck;
  let refusal;
  let completed = false;
  try {
    requireSuccess(command('git', ['clone', '--quiet', '--no-local', project, clone]), 'clone proof workspace');
    requireSuccess(command('git', ['checkout', '-b', proofCase.branch, 'origin/main'], clone), 'create proof branch');
    requireSuccess(command('git', ['remote', 'set-url', 'origin', remote], clone), 'restore remote');
    requireSuccess(command('git', ['config', 'user.email', 'merge-proof@example.invalid'], clone), 'configure email');
    requireSuccess(command('git', ['config', 'user.name', 'Merge-block proof'], clone), 'configure name');
    applyCatalogCase(clone, proofCase);
    requireSuccess(command('git', ['add', '--', proofCase.file], clone), 'stage planted change');
    requireSuccess(command('git', ['commit', '--quiet', '-m', `proof: ${proofCase.name}`], clone), 'commit planted change');
    requireSuccess(command('git', ['push', '--set-upstream', 'origin', proofCase.branch], clone), 'push proof branch');
    const created = requireSuccess(command('gh', [
      'pr', 'create', '--base', 'main', '--head', proofCase.branch,
      '--title', `Proof: ${proofCase.name}`,
      '--body', 'On-demand merge-block proof. This pull request must never merge.',
    ], clone), 'open proof pull request');
    const prUrl = created.match(/https:\/\/[^\s]+\/pull\/(\d+)/u);
    assert.ok(prUrl, `could not read pull request number from: ${created}`);
    prNumber = Number(prUrl[1]);
    failedCheck = waitForExpectedFailure(prNumber, proofCase.check);
    const requiredResult = command('gh', [
      'pr', 'checks', String(prNumber), '--required', '--json', 'name,bucket,link,state',
    ], clone);
    assert.ok([0, 1].includes(requiredResult.status), `cannot inspect required checks: ${requiredResult.stderr}${requiredResult.stdout}`);
    const requiredCheck = JSON.parse(requiredResult.stdout || '[]').find((entry) => entry.name === proofCase.check);
    assert.ok(requiredCheck && requiredCheck.bucket === 'fail', `${proofCase.check} is not a failing required check; refusing to attempt a merge`);

    const merge = command('gh', ['pr', 'merge', String(prNumber), '--merge'], clone);
    const view = JSON.parse(requireSuccess(command('gh', [
      'pr', 'view', String(prNumber), '--json', 'state,mergedAt,autoMergeRequest,mergeStateStatus,url',
    ], clone), 'inspect refused merge'));
    if (view.autoMergeRequest) command('gh', ['pr', 'merge', String(prNumber), '--disable-auto'], clone);
    assert.equal(view.mergedAt, null, `${proofCase.name}: pull request merged unexpectedly`);
    assert.notEqual(merge.status, 0, `${proofCase.name}: gh pr merge was not refused`);
    assert.equal(view.state, 'OPEN', `${proofCase.name}: pull request did not remain open after refusal`);
    refusal = `${merge.stderr}${merge.stdout}`.trim();
    assert.ok(refusal, `${proofCase.name}: gh pr merge returned no refusal evidence`);

    requireSuccess(command('gh', ['pr', 'close', String(prNumber)], clone), 'close proof pull request');
    const closed = JSON.parse(requireSuccess(command('gh', ['pr', 'view', String(prNumber), '--json', 'state,mergedAt'], clone), 'confirm pull request closure'));
    assert.equal(closed.state, 'CLOSED');
    assert.equal(closed.mergedAt, null);

    mkdirSync(path.dirname(options.evidence), { recursive: true });
    writeFileSync(options.evidence, `${JSON.stringify({
      schemaVersion: 1,
      case: proofCase.name,
      branch: proofCase.branch,
      file: proofCase.file,
      expectedCheck: proofCase.check,
      pullRequest: prNumber,
      failedRun: failedCheck.runId,
      mergeRefusal: refusal,
      status: 'closed-unmerged',
    }, null, 2)}\n`);
    writeUsed(options.usedCases, used, proofCase.name);
    completed = true;
    console.log(`PASS · ${proofCase.name} · pull request ${prNumber} closed unmerged`);
  } finally {
    if (prNumber && !completed) {
      const state = command('gh', ['pr', 'view', String(prNumber), '--json', 'state,mergedAt'], clone);
      if (state.status === 0) {
        const current = JSON.parse(state.stdout);
        if (current.state === 'OPEN' && current.mergedAt === null) command('gh', ['pr', 'close', String(prNumber)], clone);
      }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
