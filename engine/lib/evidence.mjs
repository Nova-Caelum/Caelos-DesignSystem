import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const refusedModelFamilies = JSON.parse(
  readFileSync(new URL('../refused-models.json', import.meta.url), 'utf8'),
).models.map((model) => model.toLowerCase());
const pinFiles = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
const tierZeroOwners = ['enforcer gate', 'catalog checks', 'tier-drift check', 'token build', 'lock build'];
const outputHashesName = 'output-hashes.json';

function readJson(file, label = file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function removeLifecycle(value, parentKey = null) {
  if (Array.isArray(value)) return value.map((child) => removeLifecycle(child, parentKey));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !(parentKey === 'app.caelos' && key === 'lifecycle'))
    .map(([key, child]) => [key, removeLifecycle(child, key)]));
}

function tierFile(output) {
  return output.tierFile === true || /^\d\d-[\w.-]+\.tokens\.json$/.test(path.basename(output.path));
}

function hashBytes(bytes, output) {
  let source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (tierFile(output)) {
    source = Buffer.from(JSON.stringify(removeLifecycle(JSON.parse(source.toString('utf8')))));
  }
  return createHash('sha256').update(source).digest('hex');
}

function repositories(finish) {
  return [
    ['designSystem', finish.designSystem],
    ...(finish.app ? [['app', finish.app]] : []),
  ];
}

function includedOutput(repository, output) {
  return !(repository === 'app' && pinFiles.has(output.path));
}

export function captureEngineOutputHashes(finish) {
  const snapshot = {};
  for (const [repository, config] of repositories(finish)) {
    if (!config?.folder || !Array.isArray(config.outputs)) {
      throw new Error(`finish.${repository} must name a folder and declared outputs`);
    }
    snapshot[repository] = {};
    for (const output of config.outputs.filter((entry) => includedOutput(repository, entry))) {
      const file = path.join(config.folder, output.path);
      snapshot[repository][output.path] = { hash: hashBytes(readFileSync(file), output), tierFile: tierFile(output) };
    }
  }
  return snapshot;
}

export function storeEngineOutputHashes(jobFolder, finish) {
  const file = path.join(jobFolder, outputHashesName);
  if (existsSync(file)) return readJson(file, outputHashesName);
  const snapshot = captureEngineOutputHashes(finish);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

export function readEngineOutputHashes(jobFolder) {
  return readJson(path.join(jobFolder, outputHashesName), outputHashesName);
}

async function outputWasEdited({ finish, snapshot, state, git }) {
  for (const [repository, config] of repositories(finish)) {
    const commit = repository === 'designSystem' ? state.designSystemMergeCommit : state.appMergeCommit;
    if (!commit) continue;
    for (const [file, recorded] of Object.entries(snapshot[repository] || {})) {
      try {
        const bytes = await git.readFileAt({ folder: config.folder, commit, file });
        if (hashBytes(bytes, { path: file, tierFile: recorded.tierFile }) !== recorded.hash) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

function eventRecords(jobFolder) {
  const file = path.join(jobFolder, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function modelEvidence(jobFolder) {
  const chain = readJson(path.join(jobFolder, 'chain.json'), 'chain.json');
  const modelSteps = chain.steps.filter(({ kind }) => kind === 'model').map(({ step }) => step);
  const exits = eventRecords(jobFolder).filter(({ kind }) => kind === 'node.exit');
  const recorded = exits.filter(({ model }) => typeof model === 'string' && model.trim())
    .map(({ node, model }) => ({ node, model }));
  return {
    models: recorded.map(({ model }) => model),
    missing: modelSteps.filter((step) => !recorded.some(({ node }) => node === step)),
  };
}

function hasRefusedModel(models) {
  return models.some((model) => model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .some((token) => refusedModelFamilies.some((family) => token === family
      || (token.startsWith(family) && /^\d/.test(token.slice(family.length))))));
}

async function catalogDrafts({ job, commit, git }) {
  if (!commit) return [];
  const drafts = [];
  const visit = (value, keys, file) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...keys, String(index)], file));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const metadata = value.$extensions?.['app.caelos'];
    if (metadata?.lifecycle === 'draft' && metadata.draftedBy === job.id) {
      drafts.push({ file, id: keys.join('.') });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== '$extensions') visit(child, [...keys, key], file);
    }
  };
  const files = await git.listFilesAt({
    folder: job.finish.designSystem.folder, commit, directory: 'token_catalog',
  });
  for (const file of files.filter((name) => /^token_catalog\/\d\d-[\w.-]+\.json$/.test(name))) {
    const bytes = await git.readFileAt({
      folder: job.finish.designSystem.folder, commit, file,
    });
    visit(JSON.parse(bytes.toString('utf8')), [], file);
  }
  return drafts;
}

function backendFile(file) {
  return file === 'lib/mock-aelpha-client.ts' || file.startsWith('lib/aelpha-client/');
}

function successfulIds(checks) {
  return (checks || []).map((check) => typeof check === 'number' ? check : check.id);
}

export async function writeJobEvidence({
  jobFolder, evidenceFolder, snapshot, state, git, deployRecord,
}) {
  const job = readJson(path.join(jobFolder, 'job.json'), 'job.json');
  const finish = job.finish;
  const signoff = readJson(path.join(jobFolder, 'signoff.json'), 'signoff.json');
  const appRequired = Boolean(finish.app);
  const behaviour = appRequired
    ? readJson(path.join(jobFolder, finish.behaviourResults), 'behaviour results')
    : { summary: { failed: 0 } };
  const gate = appRequired
    ? readJson(path.join(jobFolder, finish.gateResults), 'gate results')
    : { errors: 0 };
  const drafts = await catalogDrafts({ job, commit: state.designSystemMergeCommit, git });
  const model = modelEvidence(jobFolder);
  const engineOutputEdited = await outputWasEdited({ finish, snapshot, state, git });
  const changed = finish.app && state.appMergeCommit
    ? await git.changedFiles({
      folder: finish.app.folder, baseCommit: finish.app.baseCommit, commit: state.appMergeCommit,
    }) : [];
  const backendChanged = changed.filter(backendFile).length;
  const behavioursFailed = behaviour.summary.failed;
  if (!Number.isInteger(behavioursFailed)) throw new Error('behaviour results have no integer summary.failed');
  if (!Number.isInteger(gate.errors)) throw new Error('gate results have no integer errors count');
  const signedAt = Date.parse(signoff.signedAt);
  if (!Number.isFinite(signedAt)) throw new Error('promote record has no valid signedAt timestamp');
  const signoffAfterMerge = Boolean(state.appMergedAt) && signedAt > Date.parse(state.appMergedAt);
  const designChecksPassed = successfulIds(state.designSystemCheckRunIds).length > 0;
  const appChecksPassed = !appRequired || successfulIds(state.appCheckRunIds).length > 0;
  const deployMatchesAppMerge = !appRequired || Boolean(
    state.appMergeCommit && deployRecord?.id && await git.isAncestor({
      folder: finish.app.folder, ancestor: state.appMergeCommit, commit: deployRecord.id,
    }),
  );
  const passed = signoff.status === 'promoted'
    && drafts.length === 0
    && !signoffAfterMerge
    && model.missing.length === 0
    && !hasRefusedModel(model.models)
    && behavioursFailed === 0
    && backendChanged === 0
    && gate.errors === 0
    && !engineOutputEdited
    && Boolean(state.designSystemMergeCommit)
    && designChecksPassed
    && appChecksPassed
    && (!appRequired || (Boolean(state.appMergeCommit) && Boolean(deployRecord) && deployMatchesAppMerge));
  const report = {
    job_passed: passed,
    behaviours_failed: behavioursFailed,
    backend_files_changed: backendChanged,
    engine_output_edited_after_run: engineOutputEdited,
    design_system_merge_commit: state.designSystemMergeCommit || null,
    app_merge_commit: state.appMergeCommit || null,
    design_system_check_run_ids: successfulIds(state.designSystemCheckRunIds),
    app_check_run_ids: successfulIds(state.appCheckRunIds),
    deploy_record: deployRecord || null,
    deploy_matches_app_merge: deployMatchesAppMerge,
    draft_catalog_entries: drafts,
    model_steps_missing_records: model.missing,
  };
  writeFileSync(path.join(evidenceFolder, finish.evidenceFile), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function signoffRecords(jobFolder) {
  return readdirSync(jobFolder)
    .filter((name) => /^signoff(?:[-.].*)?\.json$/.test(name) || name === 'signoff.json')
    .sort()
    .map((name) => readJson(path.join(jobFolder, name), name))
    .filter((record) => record.status === 'promoted');
}

function entryKey(file, id) {
  return `${file}\0${id}`;
}

function catalogGapEntries(job) {
  const entries = [];
  const visit = (value, keys, file) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...keys, String(index)], file));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const metadata = value.$extensions?.['app.caelos'];
    if (metadata?.draftedBy === job.id && typeof metadata.gapFill === 'string') {
      entries.push({ file, id: keys.join('.'), catalog_gap_fill: metadata.gapFill });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== '$extensions') visit(child, [...keys, key], file);
    }
  };
  for (const output of job.finish.designSystem.outputs.filter(tierFile)) {
    const file = path.basename(output.path);
    visit(readJson(path.join(job.finish.designSystem.folder, output.path), output.path), [], file);
  }
  return entries;
}

export async function recomputeCrossJobEvidence({ jobFolders, evidenceFolder }) {
  const signoffJobs = [];
  const gaps = [];
  const gapsNotListed = [];
  for (const jobFolder of jobFolders) {
    const job = readJson(path.join(jobFolder, 'job.json'), 'job.json');
    const records = signoffRecords(jobFolder);
    signoffJobs.push({ job: job.id, promote_records: records.length });
    const listed = new Map(records.flatMap((record) => [...(record.promoted || []), ...(record.skipped || [])])
      .map((entry) => [entryKey(entry.file, entry.id), entry]));
    for (const gap of catalogGapEntries(job)) {
      const signoffEntry = listed.get(entryKey(gap.file, gap.id));
      const row = {
        job: job.id, file: gap.file, id: gap.id,
        gapFill: typeof signoffEntry?.gapFill === 'string' ? signoffEntry.gapFill : null,
      };
      gaps.push(row);
      if (!signoffEntry || typeof signoffEntry.gapFill !== 'string') gapsNotListed.push(row);
    }
  }
  const signoffs = {
    jobs: signoffJobs,
    jobs_with_more_than_one_signoff: signoffJobs.filter(({ promote_records: count }) => count > 1).length,
    job_ids_with_more_than_one_signoff: signoffJobs.filter(({ promote_records: count }) => count > 1).map(({ job }) => job),
  };
  const gapReport = {
    gaps,
    gaps_not_listed_at_signoff: gapsNotListed.length,
    gap_entries_not_listed_at_signoff: gapsNotListed,
  };
  const systemFaithful = readNamesNotReachingTierZero(signoffJobs.map(({ job }) => job));
  for (const [name, value] of [
    ['signoffs.json', signoffs], ['gaps.json', gapReport], ['system-faithful.json', systemFaithful],
  ]) writeFileSync(path.join(evidenceFolder, name), `${JSON.stringify(value, null, 2)}\n`);
  return { signoffs, gaps: gapReport, systemFaithful };
}

function readNamesNotReachingTierZero(jobs) {
  return {
    jobs,
    names_not_reaching_tier_0: null,
    names_not_reaching_tier_0_source: `unavailable: ${tierZeroOwners.join(', ')} publish no tier-0 field`,
  };
}

export function jobFoldersUnder(jobsRoot) {
  return readdirSync(jobsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(jobsRoot, entry.name, 'job.json')))
    .map((entry) => path.join(jobsRoot, entry.name))
    .sort();
}
