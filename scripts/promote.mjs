// Recommended: node scripts/promote.mjs --job <job-id> --record <path-to-signoff.json> --signer-words-file <path> [--catalog <dir>]
// Alternative:  node scripts/promote.mjs --job <job-id> --record <path-to-signoff.json> --signer-words "<words>" [--catalog <dir>]
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node scripts/promote.mjs --job <job-id> --record <path-to-signoff.json> (--signer-words-file <path> | --signer-words <text>) [--catalog <dir>] (the file form is recommended)';
const tierFile = /^\d\d-[\w.-]+\.tokens\.json$/;
const repositoryRoot = realpathSync(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function combinedError(original, addition) {
  const error = new Error(`${original.message}; ${addition}`);
  error.exitCode = original.exitCode;
  return error;
}

function argumentsFrom(args) {
  const values = { catalog: 'token_catalog' };
  const known = new Set(['--job', '--record', '--signer-words', '--signer-words-file', '--catalog']);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!known.has(flag) || value === undefined || seen.has(flag)) fail(usage, 2);
    seen.add(flag);
    values[flag.slice(2).replaceAll('-', '')] = value;
  }
  if (typeof values.job !== 'string' || !values.job || typeof values.record !== 'string' || !values.record) {
    fail(usage, 2);
  }
  const hasWords = seen.has('--signer-words');
  const hasWordsFile = seen.has('--signer-words-file');
  if (hasWords === hasWordsFile) fail(`exactly one of --signer-words and --signer-words-file is required\n${usage}`, 2);
  if (hasWordsFile) {
    try {
      values.signerwords = readFileSync(values.signerwordsfile, 'utf8');
    } catch (error) {
      fail(`--signer-words-file ${values.signerwordsfile}: ${error.message}`, 2);
    }
  }
  if (!values.signerwords.trim()) {
    fail(`${hasWordsFile ? '--signer-words-file' : '--signer-words'} must not be empty or whitespace-only`, 2);
  }
  return {
    catalog: values.catalog,
    job: values.job,
    record: values.record,
    signerWords: values.signerwords,
  };
}

function resolvedPath(pathname) {
  const absolute = path.resolve(pathname);
  let existing = absolute;
  const suffix = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(realpathSync(existing), ...suffix);
}

function assertExternalRecord(recordPath) {
  const resolved = resolvedPath(recordPath);
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
    fail(`--record must be outside the repository, including through symlinks: ${recordPath}`);
  }
  return resolved;
}

function parseJson(source, file) {
  let position = 0;
  const whiteSpace = () => {
    while (/\s/.test(source[position] ?? '')) position += 1;
  };
  const parseString = () => {
    const start = position;
    if (source[position] !== '"') fail(`${file}: invalid JSON`);
    position += 1;
    let escaped = false;
    while (position < source.length) {
      const character = source[position++];
      if (!escaped && character === '"') {
        const end = position;
        try {
          return { value: JSON.parse(source.slice(start, end)), start, end };
        } catch {
          fail(`${file}: invalid JSON`);
        }
      }
      escaped = !escaped && character === '\\';
      if (character !== '\\') escaped = false;
    }
    fail(`${file}: invalid JSON`);
  };
  const parseValue = () => {
    whiteSpace();
    const start = position;
    if (source[position] === '"') return { ...parseString(), type: 'string' };
    if (source[position] === '{') {
      position += 1;
      const properties = new Map();
      const value = {};
      whiteSpace();
      if (source[position] === '}') return { type: 'object', value, properties, start, end: ++position };
      while (position < source.length) {
        whiteSpace();
        const key = parseString();
        whiteSpace();
        if (source[position++] !== ':') fail(`${file}: invalid JSON`);
        const child = parseValue();
        properties.set(key.value, child);
        value[key.value] = child.value;
        whiteSpace();
        if (source[position] === '}') return { type: 'object', value, properties, start, end: ++position };
        if (source[position++] !== ',') fail(`${file}: invalid JSON`);
      }
      fail(`${file}: invalid JSON`);
    }
    if (source[position] === '[') {
      position += 1;
      const elements = [];
      const value = [];
      whiteSpace();
      if (source[position] === ']') return { type: 'array', value, elements, start, end: ++position };
      while (position < source.length) {
        const child = parseValue();
        elements.push(child);
        value.push(child.value);
        whiteSpace();
        if (source[position] === ']') return { type: 'array', value, elements, start, end: ++position };
        if (source[position++] !== ',') fail(`${file}: invalid JSON`);
      }
      fail(`${file}: invalid JSON`);
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(position));
    if (!literal) fail(`${file}: invalid JSON`);
    position += literal[0].length;
    try {
      return { type: 'literal', value: JSON.parse(literal[0]), start, end: position };
    } catch {
      fail(`${file}: invalid JSON`);
    }
  };

  try {
    const node = parseValue();
    whiteSpace();
    if (position !== source.length) fail(`${file}: invalid JSON`);
    return node;
  } catch (error) {
    if (error.exitCode) throw error;
    fail(`${file}: invalid JSON`);
  }
}

function catalogRecords(node, file) {
  const records = [];
  const visit = (current, segments) => {
    if (current.type === 'array') {
      current.elements.forEach((child, index) => visit(child, [...segments, String(index)]));
      return;
    }
    if (current.type !== 'object') return;
    const extension = current.properties.get('$extensions');
    const record = extension?.type === 'object' ? extension.properties.get('app.caelos') : undefined;
    if (record?.type === 'object') records.push({ id: segments.join('.'), file, record });
    for (const [key, child] of current.properties) {
      if (!key.startsWith('$')) visit(child, [...segments, key]);
    }
  };
  visit(node, []);
  return records;
}

function readCatalog(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => tierFile.test(name)).sort();
  } catch {
    fail(`${directory}: cannot read catalog`);
  }
  if (!names.length) fail(`${directory}: no tier JSON files found`);
  return names.map((name) => {
    const file = path.resolve(directory, name);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      fail(`${file}: cannot read catalog file`);
    }
    const source = bytes.toString('utf8');
    const node = parseJson(source, file);
    return { file, bytes, source, records: catalogRecords(node, file) };
  });
}

function recordField(record, name) {
  return record.record.properties.get(name);
}

function isPlaceholder(record) {
  return recordField(record, 'lifecycle')?.value === 'placeholder' ||
    recordField(record, 'gapFill')?.value === 'placeholder';
}

function recordedEntry(entry) {
  const output = { file: path.basename(entry.file), id: entry.id };
  const gapFill = recordField(entry, 'gapFill')?.value;
  if (typeof gapFill === 'string') output.gapFill = gapFill;
  else if (isPlaceholder(entry)) output.gapFill = 'placeholder';
  return output;
}

function promotionWrites(catalog, promotions) {
  const byFile = new Map();
  for (const promotion of promotions) {
    if (!byFile.has(promotion.file)) byFile.set(promotion.file, []);
    byFile.get(promotion.file).push(promotion);
  }
  return catalog.flatMap((input) => {
    const edits = byFile.get(input.file);
    if (!edits) return [];
    const output = [...edits].sort((left, right) => right.lifecycle.start - left.lifecycle.start).reduce(
      (source, promotion) => `${source.slice(0, promotion.lifecycle.start)}"promoted"${source.slice(promotion.lifecycle.end)}`,
      input.source,
    );
    return [{ file: input.file, original: input.bytes, output: Buffer.from(output) }];
  });
}

function temporaryFor(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
}

function removeTemporary(file, originalError) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw combinedError(originalError, `temporary cleanup failed for ${file}: ${error.message}`);
  }
  throw originalError;
}

function atomicInstall(file, bytes) {
  const temporary = temporaryFor(file);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    if (existsSync(file)) fail(`${file}: sign-off record already exists`);
    renameSync(temporary, file);
  } catch (error) {
    removeTemporary(temporary, error);
  }
}

function atomicReplace(file, expected, bytes) {
  const temporary = temporaryFor(file);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    const current = readFileSync(file);
    if (!current.equals(expected)) fail(`${file}: changed since it was read; refusing to overwrite`);
    renameSync(temporary, file);
  } catch (error) {
    removeTemporary(temporary, error);
  }
}

function restoreTierFiles(writes, originalError) {
  let error = originalError;
  for (const write of [...writes].reverse()) {
    try {
      atomicReplace(write.file, write.output, write.original);
    } catch (restoreError) {
      error = combinedError(error, `failed to restore ${write.file}: ${restoreError.message}`);
    }
  }
  throw error;
}

function lockOwner(lockFile) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    fail(`${lockFile}: promotion lock exists but is unreadable; verify no promote is running, then remove it manually`);
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    fail(`${lockFile}: promotion lock has no valid pid; verify no promote is running, then remove it manually`);
  }
  try {
    process.kill(owner.pid, 0);
    fail(`${lockFile}: promotion lock is held by pid ${owner.pid}; another promote is running`);
  } catch (error) {
    if (error.exitCode) throw error;
    if (error.code === 'ESRCH') {
      fail(`${lockFile}: stale promotion lock from dead pid ${owner.pid}; verify no promote is running, then remove it manually`);
    }
    fail(`${lockFile}: promotion lock belongs to pid ${owner.pid} and its state cannot be checked; do not clear it while a promote may be running`);
  }
}

function withCatalogLock(catalogDirectory, job, action) {
  const lockFile = path.resolve(catalogDirectory, '.promote.lock');
  const contents = `${JSON.stringify({ pid: process.pid, jobId: job, startedAt: new Date().toISOString() }, null, 2)}\n`;
  try {
    writeFileSync(lockFile, contents, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') lockOwner(lockFile);
    fail(`${lockFile}: cannot create promotion lock: ${error.message}`);
  }

  let actionError;
  let result;
  try {
    result = action();
  } catch (error) {
    actionError = error;
  }
  try {
    const current = readFileSync(lockFile, 'utf8');
    if (current !== contents) fail(`${lockFile}: promotion lock changed while held; refusing to remove it`);
    unlinkSync(lockFile);
  } catch (cleanupError) {
    if (actionError) throw combinedError(actionError, `promotion lock cleanup failed: ${cleanupError.message}`);
    throw cleanupError;
  }
  if (actionError) throw actionError;
  return result;
}

function readRecord(recordPath) {
  let bytes;
  try {
    bytes = readFileSync(recordPath);
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    fail(`${recordPath}: cannot read sign-off record`);
  }
}

function targetKey(file, id) {
  return `${file}\0${id}`;
}

function promotionsForPending(catalog, pending) {
  if (!Array.isArray(pending.promoted) || !pending.promoted.every((entry) =>
    entry && typeof entry.file === 'string' && typeof entry.id === 'string')) {
    fail('pending sign-off record has invalid promoted entries');
  }
  const targets = new Set(pending.promoted.map((entry) => targetKey(entry.file, entry.id)));
  const matches = catalog.flatMap((input) => input.records).filter((entry) =>
    targets.has(targetKey(path.basename(entry.file), entry.id)));
  if (matches.length !== targets.size) fail('pending sign-off record names entries that are missing from the catalog');
  const promotions = [];
  for (const entry of matches) {
    if (recordField(entry, 'draftedBy')?.value !== pending.jobId || isPlaceholder(entry)) {
      fail(`pending sign-off target is no longer promotable: ${path.basename(entry.file)}:${entry.id}`);
    }
    const lifecycle = recordField(entry, 'lifecycle');
    if (lifecycle?.value === 'draft') promotions.push({ ...entry, lifecycle });
    else if (lifecycle?.value !== 'promoted') {
      fail(`pending sign-off target has unexpected lifecycle: ${path.basename(entry.file)}:${entry.id}`);
    }
  }
  return promotions;
}

function verifyPromoted(directory, pending) {
  const targets = new Set(pending.promoted.map((entry) => targetKey(entry.file, entry.id)));
  const verified = new Set();
  for (const input of readCatalog(directory)) {
    for (const entry of input.records) {
      const key = targetKey(path.basename(entry.file), entry.id);
      if (targets.has(key) && recordField(entry, 'lifecycle')?.value === 'promoted') verified.add(key);
    }
  }
  if (verified.size !== targets.size) fail('promotion verification failed: not every recorded entry is promoted');
}

function finishPending(catalog, recordPath, pendingBytes, pending) {
  const promotions = promotionsForPending(catalog, pending);
  const writes = promotionWrites(catalog, promotions);
  const completed = [];
  try {
    for (const write of writes) {
      atomicReplace(write.file, write.original, write.output);
      completed.push(write);
      if (process.env.NODE_TEST_CONTEXT &&
        Number(process.env.CAELOS_PROMOTE_TEST_FAIL_AFTER_TIER_WRITES) === completed.length) {
        fail(`injected tier write failure after write ${completed.length}`);
      }
    }
    verifyPromoted(path.dirname(catalog[0].file), pending);
    const promotedBytes = Buffer.from(`${JSON.stringify({ ...pending, status: 'promoted' }, null, 2)}\n`);
    atomicReplace(recordPath, pendingBytes, promotedBytes);
  } catch (error) {
    if (completed.length) restoreTierFiles(completed, error);
    throw error;
  }
  return pending.promoted.length;
}

function promote(options, recordPath) {
  if (existsSync(recordPath)) {
    const prior = readRecord(recordPath);
    if (prior.value.jobId !== options.job) fail(`${options.record}: sign-off record already exists`);
    if (prior.value.status !== 'pending') fail(`job ${options.job} was already signed off`);
    const catalog = readCatalog(options.catalog);
    const count = finishPending(catalog, recordPath, prior.bytes, prior.value);
    console.log(`finished pending promotion for ${count} entries`);
    return;
  }

  const catalog = readCatalog(options.catalog);
  const records = catalog.flatMap((input) => input.records);
  const drafted = records.filter((entry) => recordField(entry, 'draftedBy')?.value === options.job);
  if (!drafted.length) fail(`nothing was drafted by that job: ${options.job}`);

  const placeholders = drafted.filter(isPlaceholder);
  const skipped = placeholders.map((entry) => ({ ...recordedEntry(entry), reason: 'placeholder' }));
  const promotions = drafted.filter((entry) => recordField(entry, 'lifecycle')?.value === 'draft' &&
    !isPlaceholder(entry)).map((entry) => ({ ...entry, lifecycle: recordField(entry, 'lifecycle') }));
  if (!promotions.length) {
    const alreadyPromoted = drafted.some((entry) => recordField(entry, 'lifecycle')?.value === 'promoted');
    if (alreadyPromoted) {
      const suffix = skipped.length ? `; remaining placeholders still need values: ${skipped.map((entry) => `${entry.file}:${entry.id}`).join(', ')}` : '';
      fail(`job ${options.job} was already signed off${suffix}`);
    }
    if (placeholders.length === drafted.length) {
      fail(`job ${options.job} contains only placeholder gaps; no sign-off was made`);
    }
    fail(`job ${options.job} has no draft entries eligible for promotion; no sign-off was made`);
  }

  const pending = {
    status: 'pending',
    jobId: options.job,
    signedAt: new Date().toISOString(),
    signerWords: options.signerWords,
    promoted: promotions.map(recordedEntry),
    skipped,
  };
  const pendingBytes = Buffer.from(`${JSON.stringify(pending, null, 2)}\n`);
  atomicInstall(recordPath, pendingBytes);
  const count = finishPending(catalog, recordPath, pendingBytes, pending);
  console.log(`promoted ${count} entries; skipped ${skipped.length} placeholders`);
}

function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const recordPath = assertExternalRecord(options.record);
  withCatalogLock(options.catalog, options.job, () => promote(options, recordPath));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
