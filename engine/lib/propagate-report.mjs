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
    const source = readFileSync(file, 'utf8');
    const root = JSON.parse(source);
    let node = root;
    let type = root.$type;
    for (const segment of segments) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, segment)) {
        node = null;
        break;
      }
      node = node[segment];
      if (node && typeof node === 'object' && typeof node.$type === 'string') type = node.$type;
    }
    if (node && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, '$value')) {
      matches.push({ file, source, node, type });
    }
  }
  if (matches.length > 1) throw new Error(`token ${token} has multiple tier 0 definitions`);
  return matches[0] ?? null;
}

function skipWhitespace(source, offset) {
  let cursor = offset;
  while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
  return cursor;
}

function scanString(source, offset) {
  let cursor = offset + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') cursor += 2;
    else if (source[cursor] === '"') return cursor + 1;
    else cursor += 1;
  }
  throw new Error('unterminated JSON string');
}

function jsonValueRange(source, target) {
  function parseValue(offset, segments) {
    const start = skipWhitespace(source, offset);
    const selected = segments.length === target.length
      && segments.every((segment, index) => segment === target[index]);
    let cursor = start;
    let nestedRange = null;
    if (source[cursor] === '"') {
      cursor = scanString(source, cursor);
    } else if (source[cursor] === '{') {
      cursor = skipWhitespace(source, cursor + 1);
      while (source[cursor] !== '}') {
        const keyStart = cursor;
        const keyEnd = scanString(source, keyStart);
        const key = JSON.parse(source.slice(keyStart, keyEnd));
        cursor = skipWhitespace(source, keyEnd);
        if (source[cursor] !== ':') throw new Error('invalid JSON object');
        const parsed = parseValue(cursor + 1, [...segments, key]);
        nestedRange ??= parsed.range;
        cursor = skipWhitespace(source, parsed.end);
        if (source[cursor] === ',') cursor = skipWhitespace(source, cursor + 1);
        else if (source[cursor] !== '}') throw new Error('invalid JSON object');
      }
      cursor += 1;
    } else if (source[cursor] === '[') {
      cursor = skipWhitespace(source, cursor + 1);
      let index = 0;
      while (source[cursor] !== ']') {
        const parsed = parseValue(cursor, [...segments, String(index)]);
        nestedRange ??= parsed.range;
        cursor = skipWhitespace(source, parsed.end);
        if (source[cursor] === ',') cursor = skipWhitespace(source, cursor + 1);
        else if (source[cursor] !== ']') throw new Error('invalid JSON array');
        index += 1;
      }
      cursor += 1;
    } else {
      while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor])) cursor += 1;
    }
    return { end: cursor, range: selected ? { start, end: cursor } : nestedRange };
  }
  const { range } = parseValue(0, []);
  if (!range) throw new Error(`cannot find JSON value ${target.join('.')}`);
  return range;
}

function valueMatchesType(type, value) {
  if (typeof value === 'string' && /^\{[^{}]+\}$/u.test(value)) return true;
  if (type === 'dimension') {
    return (typeof value === 'string'
      && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc)$/u.test(value))
      || (value !== null && typeof value === 'object' && !Array.isArray(value)
        && typeof value.value === 'number' && Number.isFinite(value.value)
        && typeof value.unit === 'string' && value.unit.length > 0);
  }
  if (type === 'duration') {
    return (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/u.test(value))
      || (value !== null && typeof value === 'object' && !Array.isArray(value)
        && typeof value.value === 'number' && Number.isFinite(value.value)
        && /^(?:ms|s)$/u.test(value.unit));
  }
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'cubicBezier') return Array.isArray(value) && value.length === 4
    && value.every((part) => typeof part === 'number' && Number.isFinite(part));
  if (type === 'color') return typeof value === 'string'
    || (value !== null && typeof value === 'object' && !Array.isArray(value)
      && typeof value.colorSpace === 'string' && Array.isArray(value.components));
  if (['fontFamily', 'fontWeight', 'strokeStyle'].includes(type)) {
    return typeof value === 'string' || (type === 'fontWeight' && typeof value === 'number');
  }
  if (['border', 'transition', 'shadow', 'gradient', 'typography'].includes(type)) {
    return value !== null && typeof value === 'object';
  }
  return ['string', 'boolean', 'object'].includes(typeof value) || typeof value === 'number';
}

function assertValueShape(type, value, token) {
  if (typeof type !== 'string' || !valueMatchesType(type, value)) {
    throw new Error(`token ${token} requires a ${type ?? 'declared'} value`);
  }
}

export function applyPropagateEdit({ jobFolder }) {
  const { job, design } = jobConfig(jobFolder);
  const token = job.propagate.token;
  const located = locateToken(path.join(design.folder, 'token_catalog'), token);
  if (!located) throw new Error(`token ${token} does not exist in tier 0`);
  const previous = located.node.$value;
  assertValueShape(located.type, job.propagate.value, token);
  const range = jsonValueRange(located.source, [...tokenSegments(token), '$value']);
  const replacement = JSON.stringify(job.propagate.value);
  writeFileSync(located.file,
    `${located.source.slice(0, range.start)}${replacement}${located.source.slice(range.end)}`);
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

function workingTreeFiles(folder) {
  const tracked = git(folder, ['diff', '--name-only', 'HEAD']).trim();
  const untracked = git(folder, ['ls-files', '--others', '--exclude-standard']).trim();
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort();
}

function fileAt(folder, commit, file) {
  return git(folder, ['show', `${commit}:${file}`]);
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase();
}

function componentName(entry) {
  const words = entry.split('#')[0].split('.').at(-1)
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  return /^\d/u.test(name) ? `Component${name}` : name;
}

// This is the single mapping from a lock entry to the files emitted for it. The
// candidate paths come from the generator outputs recorded by the apply step.
function builtFilesByEntry({ folder, commit, entries, outputPaths }) {
  const sources = new Map(outputPaths.map((output) => {
    try {
      return [output, fileAt(folder, commit, output)];
    } catch {
      return [output, ''];
    }
  }));
  return new Map(entries.map((entry) => {
    const baseEntry = entry.split('#')[0];
    const cssPrefix = `--${baseEntry.split('.').map(kebab).join('-')}`;
    const generatedName = componentName(baseEntry);
    const files = outputPaths.filter((output) => {
      const source = sources.get(output);
      const basename = path.basename(output);
      return source.includes(cssPrefix)
        || basename === `${generatedName}.tsx`
        || basename === `${generatedName}.css`;
    });
    return [entry, files];
  }));
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

function expectedDesignFiles(edit) {
  return new Set([
    edit.file,
    lockFile,
    ...edit.generated_outputs,
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
  if (!Array.isArray(edit.generated_outputs)
      || edit.generated_outputs.some((output) => typeof output !== 'string')) {
    throw new Error('propagate-edit.json must contain generated_outputs as a string array');
  }
  const designChanged = changedFiles(design.folder, design.baseCommit, state.designSystemMergeCommit);
  const builtFiles = builtFilesByEntry({
    folder: design.folder,
    commit: state.designSystemMergeCommit,
    entries: expected,
    outputPaths: edit.generated_outputs,
  });
  const changedSet = new Set(designChanged);
  const actualDependents = expected
    .filter((entry) => builtFiles.get(entry).some((file) => changedSet.has(file)))
    .sort();
  const actualSet = new Set(actualDependents);
  const missed = expected.filter((name) => !actualSet.has(name)).sort();
  const nonDependents = [];
  const allowedDesign = expectedDesignFiles(edit);
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
    const edit = applyPropagateEdit({ jobFolder });
    const { design } = jobConfig(jobFolder);
    runBuild(design.folder);
    const declaredOutputs = new Set((design.outputs ?? []).map(({ path: output }) => output));
    edit.generated_outputs = workingTreeFiles(design.folder)
      .filter((output) => output !== edit.file && output !== lockFile && declaredOutputs.has(output));
    writeJson(path.join(jobFolder, 'propagate-edit.json'), edit);
    writeJson(path.join(jobFolder, 'expected-dependents.json'), collectExpectedDependents({ jobFolder }));
    return;
  }
  if (step === 'write-propagate-report') {
    const report = await writePropagateReport({ jobFolder });
    if (report.dependents_missed > 0) {
      throw new Error(`${report.dependents_missed} dependent(s) missed: ${report.missed_dependents.join(', ')}`);
    }
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
