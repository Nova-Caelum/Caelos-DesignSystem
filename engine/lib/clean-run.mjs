import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateSchema } from '../../scripts/check-recipes.mjs';

const maxBuffer = 16 * 1024 * 1024;

function resultText(result) {
  return String(result.stderr || result.stdout || '').trim();
}

function git(cwd, args, label) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed${resultText(result) ? `: ${resultText(result)}` : ''}`);
  }
  return result.stdout;
}

function repositoryGit(gitDir, workTree, args, label, env = process.env) {
  const result = spawnSync('git', [
    `--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args,
  ], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed${resultText(result) ? `: ${resultText(result)}` : ''}`);
  }
  return result.stdout;
}

function safeRelative(file, label) {
  if (typeof file !== 'string' || !file.trim() || path.isAbsolute(file)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = path.normalize(file);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay inside its root`);
  }
  return normalized;
}

export function safePath(root, file, label) {
  const relative = safeRelative(file, label);
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relative);
  const contained = path.relative(absoluteRoot, absolute);
  if (!contained || contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) {
    throw new Error(`${label} must stay inside its root`);
  }
  let current = absoluteRoot;
  for (const part of contained.split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} crosses symbolic link ${file}`);
  }
  return absolute;
}

export function withDetachedCheckout({ gitRoot, baseCommit }, useCheckout) {
  const root = path.resolve(gitRoot);
  const resolvedBase = git(root, ['rev-parse', '--verify', '--end-of-options', `${baseCommit}^{commit}`], 'base commit').trim();
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir'], 'source repository git directory').trim();
  const container = mkdtempSync(path.join(tmpdir(), 'caelos-model-step-'));
  const checkout = path.join(container, 'checkout');
  let result;
  let originalError;
  try {
    git(root, ['worktree', 'add', '--detach', checkout, resolvedBase], 'fresh checkout');
    const checkoutGitDir = git(checkout, [
      'rev-parse', '--absolute-git-dir',
    ], 'fresh checkout git directory').trim();
    result = useCheckout({
      checkout, baseCommit: resolvedBase, container, gitDir, checkoutGitDir,
    });
  } catch (error) {
    originalError = error;
  }

  let cleanupError;
  if (existsSync(checkout)) {
    const removed = spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', checkout], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer,
    });
    if (removed.status !== 0) {
      cleanupError = new Error(`fresh checkout cleanup failed${resultText(removed) ? `: ${resultText(removed)}` : ''}`);
    }
  }
  try {
    rmSync(container, { recursive: true, force: true });
  } catch (error) {
    cleanupError ||= error;
  }
  if (originalError) {
    if (cleanupError) originalError.cleanupError = cleanupError;
    throw originalError;
  }
  if (cleanupError) throw cleanupError;
  return result;
}

function statusPaths(output) {
  const records = output.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      if (records[index]) paths.push(records[index]);
    }
  }
  return paths;
}

export function readBaseFile({ gitRoot, baseCommit, file, label }) {
  const relative = safeRelative(file, label).split(path.sep).join('/');
  return git(path.resolve(gitRoot), [
    'show', `${baseCommit}:${relative}`,
  ], `${label} ${file} at ${baseCommit}`);
}

export function assertOnlyDeclaredChanges({
  checkout, gitDir, checkoutGitDir, baseCommit, outputs, guardIndex,
}) {
  const checkoutHead = repositoryGit(
    checkoutGitDir, checkout, ['rev-parse', '--verify', 'HEAD'], 'model HEAD check',
  ).trim();
  if (checkoutHead !== baseCommit) {
    throw new Error(
      `model step moved HEAD from base ${baseCommit} to ${checkoutHead}; ` +
        'a model commit or any other HEAD movement is forbidden',
    );
  }

  const allowed = new Set(outputs.map((file) => safeRelative(file, 'declared output').split(path.sep).join('/')));
  // The checkout's own git dir, whose HEAD was just verified to be the base, so the source
  // repository's HEAD (which may have moved on since the job was pinned) never enters the comparison.
  const guardEnv = { ...process.env, GIT_INDEX_FILE: guardIndex };
  repositoryGit(checkoutGitDir, checkout, ['read-tree', baseCommit], 'model guard index', guardEnv);
  const status = repositoryGit(checkoutGitDir, checkout, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',
  ], 'model change check', guardEnv);
  const extra = statusPaths(status).find((file) => !allowed.has(file));
  if (extra) throw new Error(`model step changed undeclared file ${extra}; declare it as an output or remove the change`);
}

export function snapshotFileList(root) {
  const files = new Set();
  function visit(folder, prefix) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(folder, entry.name), relative);
      else files.add(relative);
    }
  }
  visit(path.resolve(root), '');
  return files;
}

export function assertNoUnexpectedJobFiles({ before, after, outputs }) {
  const allowed = new Set(outputs.map((file) => safeRelative(file, 'declared output').split(path.sep).join('/')));
  const forged = [...after].find((file) => !before.has(file) && !allowed.has(file));
  if (forged) throw new Error(`model step wrote undeclared file ${forged} into the job folder`);
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'null') return value === null;
  return typeof value === expected;
}

function fieldLabel(file, segments) {
  return segments.length ? `${file} field ${segments.join('.')}` : file;
}

function validateNode(value, rule, file, segments, errors) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    errors.push(`${fieldLabel(file, segments)} has an invalid schema rule`);
    return;
  }
  if (!matchesType(value, rule.type)) {
    errors.push(`${fieldLabel(file, segments)} violates its schema; expected ${rule.type}, got ${valueType(value)}`);
    return;
  }
  if (rule.enum && !rule.enum.some((choice) => isDeepStrictEqual(value, choice))) {
    errors.push(`${fieldLabel(file, segments)} violates its schema; use an allowed value`);
  }
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.trim().length < rule.minLength) errors.push(`${fieldLabel(file, segments)} violates its schema; supply at least ${rule.minLength} character(s)`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${fieldLabel(file, segments)} violates its schema; match ${rule.pattern}`);
    if (rule.format === 'date-time') {
      const match = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.exec(value);
      const parsed = match && new Date(value);
      if (!match || Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== Number(match[1]) ||
          parsed.getUTCMonth() + 1 !== Number(match[2]) || parsed.getUTCDate() !== Number(match[3])) {
        errors.push(`${fieldLabel(file, segments)} violates its schema; supply a real date and time with a timezone`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) errors.push(`${fieldLabel(file, segments)} violates its schema; list at least ${rule.minItems} item(s)`);
    if (rule.uniqueItems && value.some((item, index) => value.slice(0, index).some((prior) => isDeepStrictEqual(prior, item)))) {
      errors.push(`${fieldLabel(file, segments)} violates its schema; remove duplicate items`);
    }
    if (rule.items) value.forEach((item, index) => validateNode(item, rule.items, file, [...segments, String(index)], errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (rule.minProperties !== undefined && Object.keys(value).length < rule.minProperties) errors.push(`${fieldLabel(file, segments)} violates its schema; supply at least ${rule.minProperties} field(s)`);
    for (const name of rule.required || []) {
      if (!Object.hasOwn(value, name)) errors.push(`${file} requires field ${[...segments, name].join('.')}`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(rule.properties || {}, name)) validateNode(child, rule.properties[name], file, [...segments, name], errors);
    }
  }
}

export function parseJsonSchema(schemaText, schemaName) {
  let schema;
  try {
    schema = JSON.parse(schemaText);
  } catch (error) {
    throw new Error(`${schemaName} is not a valid JSON schema: ${error.message}`);
  }
  validateSchema(schema, schemaName);
  return schema;
}

export function validateJsonOutput(outputFile, schema, schemaName = 'output schema') {
  let value;
  try {
    value = JSON.parse(readFileSync(outputFile, 'utf8'));
  } catch (error) {
    throw new Error(`${path.basename(outputFile)} is not valid JSON: ${error.message}`);
  }
  validateSchema(schema, schemaName);
  const errors = [];
  validateNode(value, schema, path.basename(outputFile), [], errors);
  if (errors.length) throw new Error(errors.join('; '));
  return value;
}

export function requireRegularOutput(checkout, output) {
  const file = safePath(checkout, output, 'declared output');
  if (!existsSync(file)) throw new Error(`model step did not write declared output ${output}`);
  if (!lstatSync(file).isFile()) throw new Error(`model step output ${output} must be a regular file`);
  return file;
}

export function outputDestination(jobFolder, output) {
  const file = safePath(jobFolder, output, 'declared output destination');
  mkdirSync(path.dirname(file), { recursive: true });
  return safePath(jobFolder, output, 'declared output destination');
}
