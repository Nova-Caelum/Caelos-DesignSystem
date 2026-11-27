import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tokenName } from '../../style-dictionary.config.mjs';

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

function componentName(entry) {
  const words = entry.split('#')[0].split('.').at(-1)
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  return /^\d/u.test(name) ? `Component${name}` : name;
}

function optionalFileAt(folder, commit, file) {
  try {
    return fileAt(folder, commit, file);
  } catch {
    return null;
  }
}

function catalogFilesAt(folder, commit) {
  const output = git(folder, [
    'ls-tree', '-r', '--name-only', commit, '--', 'token_catalog',
  ]).trim();
  return output.split('\n').filter((file) => /^token_catalog\/0[0-5]-.*\.tokens\.json$/u.test(file));
}

function catalogDocuments(folder, commit) {
  return new Map(catalogFilesAt(folder, commit).map((file) => {
    const source = fileAt(folder, commit, file);
    return [file, {
      file,
      root: JSON.parse(source),
      source,
      tier: Number.parseInt(path.basename(file).slice(0, 2), 10),
    }];
  }));
}

function addToMapSet(map, key, value) {
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
}

// Property names are taken from the transform used by the token build. A tier
// entry owns every token declaration below it; a token leaf also owns its own
// declaration because it is independently represented in the lock.
function outputOwnership(...catalogs) {
  const properties = new Map();
  const components = new Map();
  for (const catalog of catalogs) {
    for (const { root, tier } of catalog.values()) {
      function visit(node, segments = []) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        const isToken = Object.hasOwn(node, '$value');
        const entryNames = [];
        if (tier > 0 && segments.length >= 3) entryNames.push(segments.slice(0, 3).join('.'));
        if (isToken) entryNames.push(segments.join('.'));
        for (const entry of new Set(entryNames)) {
          addToMapSet(components, `${componentName(entry)}.css`, entry);
          addToMapSet(components, `${componentName(entry)}.tsx`, entry);
          if (isToken) addToMapSet(properties, `--${tokenName(segments)}`, entry);
        }
        if (isToken) return;
        for (const key of Object.keys(node).filter((key) => !key.startsWith('$')).sort()) {
          visit(node[key], [...segments, key]);
        }
      }
      visit(root);
    }
  }
  return { properties, components };
}

function declarations(source) {
  const result = new Map();
  for (const match of (source ?? '').matchAll(/^\s*(--[\w-]+)\s*:\s*.*;.*$/gmu)) {
    result.set(match[1], match[0].trim());
  }
  return result;
}

function withoutDeclarations(source) {
  return (source ?? '').replace(/^\s*--[\w-]+\s*:\s*.*;.*$/gmu, '');
}

function changedOutputEntries({ folder, base, head, outputPaths, ownership }) {
  const entries = new Set();
  const unmappedFiles = new Set();
  for (const output of outputPaths) {
    const before = optionalFileAt(folder, base, output);
    const after = optionalFileAt(folder, head, output);
    if (before === after) continue;
    const componentOwners = ownership.components.get(path.basename(output));
    if (componentOwners) {
      if (componentOwners.size === 1) entries.add(componentOwners.values().next().value);
      else unmappedFiles.add(output);
      continue;
    }
    const beforeDeclarations = declarations(before);
    const afterDeclarations = declarations(after);
    const propertyNames = new Set([...beforeDeclarations.keys(), ...afterDeclarations.keys()]);
    let changedDeclaration = false;
    let unmappedDeclaration = false;
    for (const property of propertyNames) {
      if (beforeDeclarations.get(property) === afterDeclarations.get(property)) continue;
      changedDeclaration = true;
      const owners = ownership.properties.get(property);
      if (!owners) {
        unmappedDeclaration = true;
        continue;
      }
      for (const entry of owners) entries.add(entry);
    }
    if (unmappedDeclaration || !changedDeclaration
        || withoutDeclarations(before) !== withoutDeclarations(after)) {
      unmappedFiles.add(output);
    }
  }
  return { entries, unmappedFiles };
}

function nodeAt(root, segments) {
  let node = root;
  for (const segment of segments) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, segment)) return null;
    node = node[segment];
  }
  return node;
}

function catalogDifferences(before, after, segments = []) {
  if (segments.at(-1) === '$value' || Array.isArray(before) || Array.isArray(after)
      || before === null || after === null || typeof before !== 'object' || typeof after !== 'object') {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ segments, before, after }];
  }
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  return [...keys].sort().flatMap((key) => catalogDifferences(
    before?.[key], after?.[key], [...segments, key],
  ));
}

function owningEntry(difference, before, after, tier) {
  for (let length = difference.segments.length; length > 0; length -= 1) {
    const segments = difference.segments.slice(0, length);
    const candidates = [nodeAt(before, segments), nodeAt(after, segments)];
    if (candidates.some((node) => node && typeof node === 'object' && Object.hasOwn(node, '$value'))) {
      return segments.join('.');
    }
  }
  if (tier > 0 && difference.segments.length >= 3) return difference.segments.slice(0, 3).join('.');
  return null;
}

function catalogViolations({ folder, base, head, edit, beforeCatalog, afterCatalog }) {
  const files = new Set([...beforeCatalog.keys(), ...afterCatalog.keys()]);
  const allowedSegments = [...tokenSegments(edit.token), '$value'];
  const violations = new Set();
  let intendedChanges = 0;
  for (const file of files) {
    const beforeDocument = beforeCatalog.get(file);
    const afterDocument = afterCatalog.get(file);
    const differences = catalogDifferences(beforeDocument?.root, afterDocument?.root);
    for (const difference of differences) {
      const intended = file === edit.file
        && difference.segments.length === allowedSegments.length
        && difference.segments.every((segment, index) => segment === allowedSegments[index])
        && JSON.stringify(difference.before) === JSON.stringify(edit.previous)
        && JSON.stringify(difference.after) === JSON.stringify(edit.value);
      if (intended) {
        intendedChanges += 1;
        continue;
      }
      const entry = owningEntry(
        difference,
        beforeDocument?.root,
        afterDocument?.root,
        beforeDocument?.tier ?? afterDocument?.tier ?? 0,
      );
      violations.add(`design-system:${entry ?? file}`);
    }
    if (file !== edit.file && beforeDocument?.source !== afterDocument?.source
        && differences.length === 0) {
      violations.add(`design-system:${file}`);
    }
  }
  if (intendedChanges !== 1) violations.add(`design-system:${edit.token}`);

  const beforeSource = optionalFileAt(folder, base, edit.file);
  const afterSource = optionalFileAt(folder, head, edit.file);
  if (beforeSource !== null) {
    const range = jsonValueRange(beforeSource, allowedSegments);
    const expectedSource = `${beforeSource.slice(0, range.start)}${JSON.stringify(edit.value)}${beforeSource.slice(range.end)}`;
    if (afterSource !== expectedSource && violations.size === 0) violations.add(`design-system:${edit.file}`);
  }
  return violations;
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
  const beforeCatalog = catalogDocuments(design.folder, design.baseCommit);
  const afterCatalog = catalogDocuments(design.folder, state.designSystemMergeCommit);
  const ownership = outputOwnership(beforeCatalog, afterCatalog);
  const outputPaths = [...new Set([
    ...(design.outputs ?? [])
      .filter((output) => !output.tierFile && output.path !== lockFile)
      .map((output) => output.path),
    ...edit.generated_outputs,
  ])].sort();
  const outputChanges = changedOutputEntries({
    folder: design.folder,
    base: design.baseCommit,
    head: state.designSystemMergeCommit,
    outputPaths,
    ownership,
  });
  const changedEntries = outputChanges.entries;
  const actualDependents = expected
    .filter((entry) => changedEntries.has(entry.split('#')[0]))
    .sort();
  const actualSet = new Set(actualDependents);
  const missed = expected.filter((name) => !actualSet.has(name)).sort();
  const expectedBaseEntries = new Set(expected.map((entry) => entry.split('#')[0]));
  const nonDependents = [...catalogViolations({
    folder: design.folder,
    base: design.baseCommit,
    head: state.designSystemMergeCommit,
    edit,
    beforeCatalog,
    afterCatalog,
  })];
  nonDependents.push(...[...changedEntries]
    .filter((entry) => !expectedBaseEntries.has(entry))
    .map((entry) => `design-system:${entry}`));
  nonDependents.push(...[...outputChanges.unmappedFiles]
    .map((file) => `design-system:${file}`));
  const allowedDesign = new Set([
    lockFile,
    ...beforeCatalog.keys(),
    ...afterCatalog.keys(),
    ...outputPaths,
  ]);
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
    if (report.non_dependents_changed.length > 0) {
      throw new Error(`non-dependent change(s): ${report.non_dependents_changed.join(', ')}`);
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
