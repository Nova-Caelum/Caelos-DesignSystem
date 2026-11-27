#!/usr/bin/env node

/**
 * Checks the lock builder's fingerprints; it never resolves content or computes hashes.
 *
 * A near duplicate is two lock fingerprints of the same kind that differ at exactly
 * one hexadecimal character. This is deliberately advisory: it is a cheap signal for
 * Match, not evidence that two resolved entries are equivalent.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fingerprintPattern = /^[a-f0-9]{64}$/u;
const tierFile = /^0[0-5]-[\w.-]+\.tokens\.json$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArguments(argv) {
  const options = { lock: undefined, near: undefined, candidate: path.resolve(process.cwd()) };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--lock', '--near', '--candidate', '--base', '--git-root'].includes(flag) || index + 1 >= argv.length) {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value.startsWith('--')) throw new Error(`unknown or incomplete argument: ${flag}`);
    if (flag === '--lock') options.lock = path.resolve(value);
    if (flag === '--near') options.near = path.resolve(value);
    if (flag === '--candidate') options.candidate = path.resolve(value);
    index += 1;
  }
  if (!options.lock) {
    options.lock = path.join(options.candidate, 'token_catalog/versions.lock.json');
  }
  return options;
}

function fingerprint(value, label) {
  if (typeof value !== 'string' || !fingerprintPattern.test(value)) {
    throw new Error(`${label}: fingerprint must be a lowercase SHA-256 hex string`);
  }
  return value;
}

async function recordEntryNames(candidate) {
  const directory = path.join(candidate, 'token_catalog');
  let files;
  try {
    files = (await readdir(directory)).filter((file) => tierFile.test(file)).sort();
  } catch {
    throw new Error(`${directory}: missing tier files; pass --candidate <catalog root>`);
  }
  if (!files.length) throw new Error(`${directory}: missing tier files; pass --candidate <catalog root>`);

  const names = new Set();
  for (const file of files) {
    let root;
    try {
      root = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    } catch (error) {
      const reason = error instanceof SyntaxError ? 'invalid JSON' : 'unreadable catalog file';
      throw new Error(`${path.join(directory, file)}: ${reason}`);
    }
    const tier = Number(file.slice(0, 2));
    function visit(node, segments = []) {
      if (!isRecord(node)) throw new Error(`${file} entry ${segments.join('.')}: expected a catalog object`);
      const token = Object.hasOwn(node, '$value');
      // Matches check-recipes.mjs readCatalog: tier > 0 at three segments is a recipe group.
      // A $value node is a leaf token, never a duplicate-check record.
      if (!token && tier > 0 && segments.length === 3) names.add(segments.join('.'));
      if (token) return;
      for (const [key, child] of Object.entries(node)) {
        if (!key.startsWith('$')) visit(child, [...segments, key]);
      }
    }
    visit(root);
  }
  return names;
}

function readFingerprints(lock, label, recordNames) {
  if (!isRecord(lock) || !isRecord(lock.entries)) {
    throw new Error(`${label}: expected an entries object`);
  }
  const entries = [];
  const variants = [];
  for (const name of Object.keys(lock.entries).sort()) {
    const entry = lock.entries[name];
    if (!isRecord(entry)) throw new Error(`${label}: entries.${name} must be an object`);
    const entryFingerprint = fingerprint(entry.fingerprint, `${label}: entries.${name}`);
    const record = recordNames.has(name);
    if (record) entries.push({ name, fingerprint: entryFingerprint });
    if (!isRecord(entry.variants)) throw new Error(`${label}: entries.${name}.variants must be an object`);
    for (const variant of Object.keys(entry.variants).sort()) {
      const variantFingerprint = fingerprint(entry.variants[variant], `${label}: entries.${name}.variants.${variant}`);
      if (record) variants.push({ name: `${name}#${variant}`, fingerprint: variantFingerprint });
    }
  }
  return { entries, variants };
}

function duplicateGroups(records) {
  const byFingerprint = new Map();
  for (const record of records) {
    const group = byFingerprint.get(record.fingerprint) ?? [];
    group.push(record.name);
    byFingerprint.set(record.fingerprint, group);
  }
  return [...byFingerprint.values()]
    .filter((names) => names.length > 1)
    .map((names) => names.sort())
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function differsByOneCharacter(left, right) {
  if (left.length !== right.length) return false;
  let differences = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) differences += 1;
    if (differences > 1) return false;
  }
  return differences === 1;
}

function nearDuplicates(records, kind) {
  const near = [];
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      if (differsByOneCharacter(records[left].fingerprint, records[right].fingerprint)) {
        near.push({ entries: [records[left].name, records[right].name], kind });
      }
    }
  }
  return near;
}

function duplicateMessage(entryGroups, variantGroups) {
  const count = entryGroups.length + variantGroups.length;
  const lines = [`BAILOUT: ${count} exact duplicate fingerprint group${count === 1 ? '' : 's'} found.`];
  for (const names of entryGroups) lines.push(`Duplicate entries: ${names.join(' and ')}`);
  for (const names of variantGroups) lines.push(`Duplicate variants: ${names.join(' and ')}`);
  return lines.join('\n');
}

async function run(options) {
  let document;
  try {
    document = JSON.parse(await readFile(options.lock, 'utf8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : error.code === 'ENOENT' ? 'missing lock file' : 'unreadable lock file';
    throw new Error(`${options.lock}: ${reason}`);
  }
  const records = readFingerprints(document, options.lock, await recordEntryNames(options.candidate));
  const entryGroups = duplicateGroups(records.entries);
  const variantGroups = duplicateGroups(records.variants);
  if (entryGroups.length || variantGroups.length) {
    const error = new Error(duplicateMessage(entryGroups, variantGroups));
    error.exitCode = 1;
    throw error;
  }
  const near = [
    ...nearDuplicates(records.entries, 'entry'),
    ...nearDuplicates(records.variants, 'variant'),
  ];
  const output = `${JSON.stringify(near, null, 2)}\n`;
  if (options.near) await writeFile(options.near, output);
  else process.stdout.write(output);
}

try {
  await run(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`check:duplicates: ${error.message}\n`);
  process.exitCode = error.exitCode ?? 2;
}
