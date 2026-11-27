import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const lockBuilder = path.join(repositoryRoot, 'scripts', 'build-lock.mjs');
const lockFile = 'token_catalog/versions.lock.json';
const pinFiles = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
]);
const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies'];
const unsafeSegments = new Set(['__proto__', 'constructor', 'prototype']);

function readJson(file, label = file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} cannot be read as JSON: ${error.message}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function jobConfig(jobFolder) {
  const job = readJson(path.join(jobFolder, 'job.json'), 'job.json');
  const design = job.finish?.designSystem;
  if (!design?.folder) throw new Error('job.json must contain finish.designSystem.folder');
  if (!job.propagate || typeof job.propagate.token !== 'string'
      || !Object.hasOwn(job.propagate, 'value')) {
    throw new Error('job.json must contain propagate.token and propagate.value');
  }
  return { job, design, app: job.finish.app };
}

function tokenSegments(token) {
  const segments = token.split('.');
  if (!segments.length || segments.some((segment) => !segment || unsafeSegments.has(segment))) return null;
  return segments;
}

function locateToken(catalog, token) {
  const segments = tokenSegments(token);
  if (!segments) return null;
  const matches = [];
  for (const name of readdirSync(catalog).filter((file) => /^00-.*\.tokens\.json$/u.test(file)).sort()) {
    const file = path.join(catalog, name);
    const root = readJson(file);
    let node = root;
    for (const segment of segments) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, segment)) {
        node = null;
        break;
      }
      node = node[segment];
    }
    if (node && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, '$value')) {
      matches.push({ file, root, node });
    }
  }
  if (matches.length > 1) throw new Error(`token ${token} has multiple tier 0 definitions`);
  return matches[0] ?? null;
}

export function applyPropagateEdit({ jobFolder }) {
  const { job, design } = jobConfig(jobFolder);
  const token = job.propagate.token;
  const located = locateToken(path.join(design.folder, 'token_catalog'), token);
  if (!located) throw new Error(`token ${token} does not exist in tier 0`);
  const previous = located.node.$value;
  located.node.$value = job.propagate.value;
  writeJson(located.file, located.root);
  const edit = {
    token,
    previous,
    value: job.propagate.value,
    file: path.relative(design.folder, located.file),
  };
  writeJson(path.join(jobFolder, 'propagate-edit.json'), edit);
  return edit;
}

export function collectExpectedDependents({ jobFolder }) {
  const { job, design } = jobConfig(jobFolder);
  const catalog = path.join(design.folder, 'token_catalog');
  const output = execFileSync(process.execPath, [
    lockBuilder,
    '--catalog', catalog,
    '--schema', path.join(catalog, 'recipe.schema.json'),
    '--out', path.join(catalog, 'versions.lock.json'),
    '--dependents', job.propagate.token,
  ], { cwd: design.folder, encoding: 'utf8' });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function git(folder, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: folder, encoding });
}

function changedFiles(folder, base, head) {
  const output = git(folder, ['diff', '--name-only', base, head]).trim();
  return output ? output.split('\n') : [];
}

function fileAt(folder, commit, file) {
  return git(folder, ['show', `${commit}:${file}`]);
}

function lockIds(lock) {
  const ids = [];
  for (const [entry, record] of Object.entries(lock.entries ?? {})) {
    ids.push(entry);
    for (const variant of Object.keys(record.variants ?? {})) ids.push(`${entry}#${variant}`);
  }
  return ids;
}

function lockValue(lock, id) {
  const separator = id.indexOf('#');
  const entry = separator < 0 ? id : id.slice(0, separator);
  const variant = separator < 0 ? null : id.slice(separator + 1);
  const record = lock.entries?.[entry];
  return variant === null ? record?.fingerprint : record?.variants?.[variant];
}

function changedLockIds(before, after) {
  const ids = new Set([...lockIds(before), ...lockIds(after)]);
  return [...ids].filter((id) => lockValue(before, id) !== lockValue(after, id)).sort();
}

function eventModelCalls(jobFolder) {
  const file = path.join(jobFolder, 'events.jsonl');
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).reduce((count, line) => {
    try {
      const event = JSON.parse(line);
      return count + Number(event.kind === 'node.enter'
        && event.model_source === 'run-setting'
        && typeof event.model === 'string' && event.model.trim().length > 0);
    } catch {
      return count;
    }
  }, 0);
}

function expectedDesignFiles(design, edit) {
  return new Set([
    edit.file,
    lockFile,
    ...(design.outputs ?? []).map(({ path: output }) => output),
  ]);
}

function packageAt(app, commit) {
  return JSON.parse(fileAt(app.folder, commit, 'package.json'));
}

function dependencyRecord(document, dependency) {
  for (const group of dependencyGroups) {
    if (typeof document[group]?.[dependency] === 'string') {
      return { group, specifier: document[group][dependency] };
    }
  }
  return null;
}

function withoutDependency(document, dependency) {
  const copy = structuredClone(document);
  for (const group of dependencyGroups) {
    if (copy[group]) delete copy[group][dependency];
  }
  return copy;
}

function pinnedCommit(record) {
  const specifier = record?.specifier;
  if (typeof specifier !== 'string' || !specifier.includes('#')) return null;
  return specifier.slice(specifier.lastIndexOf('#') + 1) || null;
}

export async function writePropagateReport({ jobFolder }) {
  const { design, app } = jobConfig(jobFolder);
  const state = readJson(path.join(jobFolder, 'finish.json'), 'finish.json');
  if (!state.designSystemMergeCommit) throw new Error('finish.json has no designSystemMergeCommit');
  const expected = readJson(path.join(jobFolder, 'expected-dependents.json'), 'expected-dependents.json');
  if (!Array.isArray(expected) || expected.some((name) => typeof name !== 'string')) {
    throw new Error('expected-dependents.json must be a string array');
  }
  const edit = readJson(path.join(jobFolder, 'propagate-edit.json'), 'propagate-edit.json');
  const designChanged = changedFiles(design.folder, design.baseCommit, state.designSystemMergeCommit);
  const beforeLock = JSON.parse(fileAt(design.folder, design.baseCommit, lockFile));
  const afterLock = JSON.parse(fileAt(design.folder, state.designSystemMergeCommit, lockFile));
  const actualDependents = changedLockIds(beforeLock, afterLock);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actualDependents);
  const missed = expected.filter((name) => !actualSet.has(name)).sort();
  const nonDependents = actualDependents.filter((name) => !expectedSet.has(name))
    .map((name) => `design-system:${name}`);
  const allowedDesign = expectedDesignFiles(design, edit);
  nonDependents.push(...designChanged
    .filter((file) => !allowedDesign.has(file))
    .map((file) => `design-system:${file}`));

  const expectedChanges = expected.map((name) => `design-system:${name}`);
  let appChanged = [];
  let appDesignSystemCommit = null;
  if (app) {
    if (!state.appMergeCommit) throw new Error('finish.json has no appMergeCommit');
    appChanged = changedFiles(app.folder, app.baseCommit, state.appMergeCommit);
    const packageBefore = packageAt(app, app.baseCommit);
    const packageAfter = packageAt(app, state.appMergeCommit);
    const dependency = dependencyRecord(packageAfter, app.dependency);
    appDesignSystemCommit = pinnedCommit(dependency);
    expectedChanges.push(`app:package.json#${dependency?.group ?? 'dependencies'}.${app.dependency}`);
    const changedPins = appChanged.filter((file) => pinFiles.has(file));
    expectedChanges.push(...changedPins.map((file) => `app:${file}`));
    if (JSON.stringify(withoutDependency(packageBefore, app.dependency))
        !== JSON.stringify(withoutDependency(packageAfter, app.dependency))) {
      nonDependents.push('app:package.json');
    }
    nonDependents.push(...appChanged
      .filter((file) => file !== 'package.json' && !pinFiles.has(file))
      .map((file) => `app:${file}`));
    if (appDesignSystemCommit !== state.designSystemMergeCommit) {
      missed.push(`app:package.json#${dependency?.group ?? 'dependencies'}.${app.dependency}`);
    }
  }

  const report = {
    token: edit.token,
    expected_dependents: [...expected].sort(),
    actual_dependents: actualDependents,
    dependents_missed: missed.length,
    missed_dependents: missed,
    expected_changes: expectedChanges.sort(),
    changed: {
      design_system: designChanged,
      app: appChanged,
    },
    non_dependents_changed: [...new Set(nonDependents)].sort(),
    model_calls: eventModelCalls(jobFolder),
    design_system_merge_commit: state.designSystemMergeCommit,
    app_merge_commit: state.appMergeCommit ?? null,
    app_design_system_commit: appDesignSystemCommit,
    app_recorded_commit: appDesignSystemCommit,
    deploy_record: state.deployRecord ?? null,
  };
  writeJson(path.join(jobFolder, 'propagate.json'), report);
  return report;
}

function runBuild(designFolder) {
  execFileSync('npm', ['run', 'build:all'], { cwd: designFolder, stdio: 'inherit' });
}

async function main() {
  const step = process.argv[2];
  const jobIndex = process.argv.indexOf('--job');
  const jobFolder = jobIndex >= 0 ? process.argv[jobIndex + 1] : null;
  if (!jobFolder) throw new Error('usage: propagate-report <step> --job <folder>');
  if (step === 'apply-propagate-edit') {
    applyPropagateEdit({ jobFolder });
    const { design } = jobConfig(jobFolder);
    runBuild(design.folder);
    writeJson(path.join(jobFolder, 'expected-dependents.json'), collectExpectedDependents({ jobFolder }));
    return;
  }
  if (step === 'write-propagate-report') {
    await writePropagateReport({ jobFolder });
    return;
  }
  throw new Error(`unknown propagate step: ${step}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
