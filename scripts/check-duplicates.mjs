#!/usr/bin/env node

/**
 * Checks the lock builder's fingerprints. For locks that predate content fingerprints,
 * it imports the builder's allowlist implementation and computes the base values once.
 *
 * A near duplicate is two lock fingerprints of the same kind that differ at exactly
 * one hexadecimal character. This is deliberately advisory: it is a cheap signal for
 * Match, not evidence that two resolved entries are equivalent.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  baseTree, createContext, guardBaseNone, isRecipeRecord, object, readTreeJson, treeFiles,
} from './check-recipes.mjs';
import { buildContentFingerprintRecords, buildLock } from './build-lock.mjs';

const fingerprintPattern = /^[a-f0-9]{64}$/u;
const tierFile = /^0[0-5]-[\w.-]+\.tokens\.json$/u;

function parseArguments(argv) {
  const options = {
    base: undefined,
    candidate: path.resolve(process.cwd()),
    candidateMode: false,
    gitRoot: path.resolve(process.env.CAELOS_CATALOG_GIT_ROOT || process.cwd()),
    lock: undefined,
    near: undefined,
    verbose: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (!['--lock', '--near', '--candidate', '--base', '--git-root'].includes(flag) || index + 1 >= argv.length) {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value.startsWith('--')) throw new Error(`unknown or incomplete argument: ${flag}`);
    if (flag === '--lock') options.lock = path.resolve(value);
    if (flag === '--near') options.near = path.resolve(value);
    if (flag === '--candidate') {
      options.candidate = path.resolve(value);
      options.candidateMode = true;
    }
    if (flag === '--base') options.base = value;
    if (flag === '--git-root') options.gitRoot = path.resolve(value);
    index += 1;
  }
  if (!options.lock) {
    options.lock = path.join(options.candidate, 'token_catalog/versions.lock.json');
  }
  return options;
}

function emptyMarker(record, label) {
  if (!Object.hasOwn(record, 'empty')) return false;
  if (record.empty !== true) throw new Error(`${label}: empty marker must be true or omitted`);
  return true;
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
      if (!object(node)) throw new Error(`${file} entry ${segments.join('.')}: expected a catalog object`);
      const token = Object.hasOwn(node, '$value');
      if (isRecipeRecord(tier, segments)) names.add(segments.join('.'));
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
  if (!object(lock) || !object(lock.entries)) {
    throw new Error(`${label}: expected an entries object`);
  }
  const entries = [];
  const variants = [];
  for (const name of Object.keys(lock.entries).sort()) {
    const entry = lock.entries[name];
    if (!object(entry)) throw new Error(`${label}: entries.${name} must be an object`);
    fingerprint(entry.fingerprint, `${label}: entries.${name}`);
    const entryFingerprint = fingerprint(
      entry.contentFingerprint,
      `${label}: entries.${name}: content fingerprint`,
    );
    const record = recordNames.has(name);
    const entryEmpty = emptyMarker(entry, `${label}: entries.${name}`);
    if (record) entries.push({ name, fingerprint: entryFingerprint, empty: entryEmpty });
    if (!object(entry.variants)) throw new Error(`${label}: entries.${name}.variants must be an object`);
    if (!object(entry.variantContentFingerprints)) {
      throw new Error(`${label}: entries.${name}.variantContentFingerprints must be an object`);
    }
    const emptyVariants = Object.hasOwn(entry, 'emptyVariants') ? entry.emptyVariants : [];
    if (!Array.isArray(emptyVariants) ||
        (emptyVariants.length === 0 && Object.hasOwn(entry, 'emptyVariants')) ||
        emptyVariants.some((variant) => typeof variant !== 'string') || new Set(emptyVariants).size !== emptyVariants.length) {
      throw new Error(`${label}: entries.${name}.emptyVariants must be a non-empty array of unique names or omitted`);
    }
    const variantNames = Object.keys(entry.variants).sort();
    if (JSON.stringify(variantNames) !== JSON.stringify(Object.keys(entry.variantContentFingerprints).sort())) {
      throw new Error(`${label}: entries.${name}: variant content fingerprints must match variants`);
    }
    if (emptyVariants.some((variant) => !Object.hasOwn(entry.variants, variant))) {
      throw new Error(`${label}: entries.${name}.emptyVariants names an unknown variant`);
    }
    for (const variant of variantNames) {
      fingerprint(entry.variants[variant], `${label}: entries.${name}.variants.${variant}`);
      const variantFingerprint = fingerprint(
        entry.variantContentFingerprints[variant],
        `${label}: entries.${name}.variants.${variant}: content fingerprint`,
      );
      if (record) {
        variants.push({
          name: `${name}#${variant}`,
          fingerprint: variantFingerprint,
          empty: emptyVariants.includes(variant),
        });
      }
    }
  }
  return { entries, variants };
}

function baseLockIndex(lock, label) {
  if (!object(lock) || !object(lock.entries)) throw new Error(`${label}: expected an entries object`);
  const entries = new Map();
  const variants = new Map();
  const contentShapes = Object.values(lock.entries).map((entry) => object(entry) &&
    typeof entry.contentFingerprint === 'string' && object(entry.variantContentFingerprints) &&
    object(entry.variants) && Object.values(entry.variants).every((value) => typeof value === 'string'));
  if (contentShapes.some(Boolean) && !contentShapes.every(Boolean)) {
    throw new Error(`${label}: base content fingerprints are incomplete`);
  }
  const hasContentFingerprints = contentShapes.length > 0 && contentShapes.every(Boolean);
  let sawEmptyMarkers = false;
  for (const [name, entry] of Object.entries(lock.entries)) {
    if (!object(entry)) throw new Error(`${label}: entries.${name} must be an object`);
    fingerprint(entry.fingerprint, `${label}: entries.${name}`);
    if (Object.hasOwn(entry, 'empty') || Object.hasOwn(entry, 'emptyVariants')) sawEmptyMarkers = true;
    const entryEmpty = emptyMarker(entry, `${label}: entries.${name}`);
    entries.set(name, {
      empty: entryEmpty,
      fingerprint: hasContentFingerprints
        ? fingerprint(entry.contentFingerprint, `${label}: entries.${name}: content fingerprint`)
        : undefined,
    });
    if (!object(entry.variants)) throw new Error(`${label}: entries.${name}.variants must be an object`);
    const emptyVariants = Object.hasOwn(entry, 'emptyVariants') ? entry.emptyVariants : [];
    if (!Array.isArray(emptyVariants)) throw new Error(`${label}: entries.${name}.emptyVariants must be an array`);
    if (hasContentFingerprints && !object(entry.variantContentFingerprints)) {
      throw new Error(`${label}: entries.${name}.variantContentFingerprints must be an object`);
    }
    for (const [variant, variantRecord] of Object.entries(entry.variants)) {
      const variantFingerprint = object(variantRecord) ? variantRecord.fingerprint : variantRecord;
      fingerprint(variantFingerprint, `${label}: entries.${name}.variants.${variant}`);
      variants.set(`${name}#${variant}`, {
        empty: emptyVariants.includes(variant),
        fingerprint: hasContentFingerprints
          ? fingerprint(
            entry.variantContentFingerprints[variant],
            `${label}: entries.${name}.variants.${variant}: content fingerprint`,
          )
          : undefined,
      });
    }
  }
  return {
    entries,
    variants,
    hasContentFingerprints,
    hasEmptyMarkers: hasContentFingerprints && sawEmptyMarkers,
  };
}

function bootstrapBaseContent(tree, context, index) {
  const files = [...treeFiles(tree, 'token_catalog', context)]
    .filter((file) => tierFile.test(path.basename(file)))
    .sort();
  if (!files.length) throw new Error('base has no tier files; pass --base <ref> with a readable catalog');
  const records = buildContentFingerprintRecords(files.map((file) => ({
    file: path.basename(file),
    root: readTreeJson(file, tree, context),
  })));
  for (const [name, base] of index.entries) {
    const computed = records.get(name);
    if (!computed) throw new Error(`base tier files are missing lock entry: ${name}`);
    if (!index.hasContentFingerprints) base.fingerprint = computed.contentFingerprint;
    if (!index.hasEmptyMarkers) base.empty = computed.empty;
  }
  for (const [name, base] of index.variants) {
    const separator = name.indexOf('#');
    const entry = name.slice(0, separator);
    const variant = name.slice(separator + 1);
    const computed = records.get(entry);
    if (!computed) throw new Error(`base tier files are missing lock entry: ${entry}`);
    if (!computed.variantContentFingerprints.has(variant) && !index.hasContentFingerprints) {
      throw new Error(`base tier files are missing lock variant: ${name}`);
    }
    if (!index.hasContentFingerprints) base.fingerprint = computed.variantContentFingerprints.get(variant);
    if (!index.hasEmptyMarkers) {
      base.empty = computed.variantContentFingerprints.has(variant)
        ? computed.emptyVariants.has(variant)
        : computed.empty;
    }
  }
}

function compareEmpty(records, base, kind) {
  const comparable = [];
  const skipped = [];
  const refused = [];
  for (const record of records) {
    if (!record.empty) {
      comparable.push(record);
      continue;
    }
    if (base.get(record.name)?.empty === true) {
      skipped.push(record.name);
      continue;
    }
    refused.push({ kind, name: record.name, reason: base.has(record.name) ? 'newly emptied' : 'added empty' });
  }
  return { comparable, skipped, refused };
}

function skipEmptyComparison(records) {
  const comparable = [];
  const skipped = [];
  for (const record of records) {
    if (record.empty) skipped.push(record.name);
    else comparable.push(record);
  }
  return { comparable, skipped, refused: [] };
}

function reportSkipped(entries, variants, verbose) {
  if (!entries.length && !variants.length) return;
  process.stderr.write(
    `not comparable (empty in base and candidate): ${entries.length} entries, ${variants.length} variants\n`,
  );
  if (!verbose) return;
  for (const name of entries) process.stderr.write(`not comparable entry: ${name}\n`);
  for (const name of variants) process.stderr.write(`not comparable variant: ${name}\n`);
}

function emptyRefusalMessage(refused) {
  const lines = [`BAILOUT: ${refused.length} empty record${refused.length === 1 ? '' : 's'} refused.`];
  for (const record of refused) {
    lines.push(`${record.reason[0].toUpperCase()}${record.reason.slice(1)} ${record.kind}: ${record.name}`);
  }
  return lines.join('\n');
}

function duplicateGroups(records) {
  const byFingerprint = new Map();
  for (const record of records) {
    const group = byFingerprint.get(record.fingerprint) ?? [];
    group.push(record.name);
    byFingerprint.set(record.fingerprint, group);
  }
  return [...byFingerprint.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([groupFingerprint, names]) => ({ fingerprint: groupFingerprint, names: names.sort() }))
    .sort((left, right) => left.names[0].localeCompare(right.names[0]));
}

function shrinkOnlyGroups(groups, base) {
  const refused = [];
  const skipped = [];
  for (const group of groups) {
    if (base && group.names.every((name) => base.get(name)?.fingerprint === group.fingerprint)) {
      skipped.push(group);
    } else {
      refused.push(group);
    }
  }
  return { refused, skipped };
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
  for (const { names } of entryGroups) lines.push(`Duplicate entries: ${names.join(' and ')}`);
  for (const { names } of variantGroups) lines.push(`Duplicate variants: ${names.join(' and ')}`);
  return lines.join('\n');
}

async function run(options) {
  if (!options.base) throw new Error('a base lock is required; pass --base <ref>');
  const hasBase = options.base !== 'none';
  if (!hasBase) guardBaseNone(options);
  let document;
  let lockLabel = options.lock;
  if (options.candidateMode) {
    lockLabel = `trusted rebuild of ${options.candidate}`;
    document = await buildLock({
      catalog: path.join(options.candidate, 'token_catalog'),
      schema: path.join(options.candidate, 'token_catalog/recipe.schema.json'),
    });
  } else {
    try {
      document = JSON.parse(await readFile(options.lock, 'utf8'));
    } catch (error) {
      const reason = error instanceof SyntaxError ? 'invalid JSON' : error.code === 'ENOENT' ? 'missing lock file' : 'unreadable lock file';
      throw new Error(`${options.lock}: ${reason}`);
    }
  }
  const records = readFingerprints(document, lockLabel, await recordEntryNames(options.candidate));
  let entryComparison;
  let variantComparison;
  let baseIndex;
  if (!hasBase) {
    entryComparison = skipEmptyComparison(records.entries);
    variantComparison = skipEmptyComparison(records.variants);
    process.stderr.write(
      `no base given: empty-record comparison skipped (${entryComparison.skipped.length} entries, ${variantComparison.skipped.length} variants not compared)\n`,
    );
  } else {
    const context = createContext(options);
    const tree = baseTree(options.base, context);
    const baseLockFile = 'token_catalog/versions.lock.json';
    if (!treeFiles(tree, 'token_catalog', context).has(baseLockFile)) {
      throw new Error(`base ${options.base} has no ${baseLockFile}; pass --base <ref> with a lock file`);
    }
    const baseLock = readTreeJson(baseLockFile, tree, context);
    baseIndex = baseLockIndex(baseLock, `${baseLockFile} at base ${tree}`);
    if (!baseIndex.hasContentFingerprints || !baseIndex.hasEmptyMarkers) {
      bootstrapBaseContent(tree, context, baseIndex);
    }
    if (!baseIndex.hasContentFingerprints) {
      process.stderr.write('base lock predates content fingerprints; base content read from base tier files\n');
    }
    if (!baseIndex.hasEmptyMarkers) {
      process.stderr.write('base lock predates empty markers; base emptiness read from base tier files\n');
    }
    entryComparison = compareEmpty(records.entries, baseIndex.entries, 'entry');
    variantComparison = compareEmpty(records.variants, baseIndex.variants, 'variant');
    reportSkipped(entryComparison.skipped, variantComparison.skipped, options.verbose);
  }
  const refused = [...entryComparison.refused, ...variantComparison.refused];
  if (refused.length) {
    const error = new Error(emptyRefusalMessage(refused));
    error.exitCode = 1;
    throw error;
  }
  const entryGroups = shrinkOnlyGroups(
    duplicateGroups(entryComparison.comparable),
    baseIndex?.entries,
  );
  const variantGroups = shrinkOnlyGroups(
    duplicateGroups(variantComparison.comparable),
    baseIndex?.variants,
  );
  for (const group of [...entryGroups.skipped, ...variantGroups.skipped]) {
    process.stderr.write(`pre-existing duplicate (shrink-only): ${group.names.join(', ')}\n`);
  }
  if (entryGroups.refused.length || variantGroups.refused.length) {
    const error = new Error(duplicateMessage(entryGroups.refused, variantGroups.refused));
    error.exitCode = 1;
    throw error;
  }
  const near = [
    ...nearDuplicates(entryComparison.comparable, 'entry'),
    ...nearDuplicates(variantComparison.comparable, 'variant'),
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
