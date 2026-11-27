import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const usage = 'Usage: node scripts/promote.mjs --job <job-id> --record <path-to-signoff.json> --signer-words <text> [--catalog <dir>]';
const tierFile = /^\d\d-[\w.-]+\.tokens\.json$/;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function argumentsFrom(args) {
  const values = { catalog: 'token_catalog' };
  const known = new Set(['--job', '--record', '--signer-words', '--catalog']);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!known.has(flag) || value === undefined || seen.has(flag)) fail(usage, 2);
    seen.add(flag);
    values[flag === '--signer-words' ? 'signerWords' : flag.slice(2)] = value;
  }
  if (typeof values.job !== 'string' || !values.job || typeof values.record !== 'string' ||
      !values.record || typeof values.signerWords !== 'string') fail(usage, 2);
  return values;
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
    const file = path.join(directory, name);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      fail(`${file}: cannot read catalog file`);
    }
    const node = parseJson(source, file);
    return { file, source, records: catalogRecords(node, file) };
  });
}

function recordField(record, name) {
  return record.record.properties.get(name);
}

function writePromotions(catalog, promotions) {
  const byFile = new Map();
  for (const promotion of promotions) {
    if (!byFile.has(promotion.file)) byFile.set(promotion.file, []);
    byFile.get(promotion.file).push(promotion);
  }
  for (const input of catalog) {
    const edits = byFile.get(input.file);
    if (!edits) continue;
    const output = [...edits].sort((left, right) => right.lifecycle.start - left.lifecycle.start).reduce(
      (source, promotion) => `${source.slice(0, promotion.lifecycle.start)}"promoted"${source.slice(promotion.lifecycle.end)}`,
      input.source,
    );
    writeFileSync(input.file, output);
  }
}

function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (existsSync(options.record)) {
    let prior;
    try {
      prior = JSON.parse(readFileSync(options.record, 'utf8'));
    } catch {
      fail(`${options.record}: cannot read sign-off record`);
    }
    if (prior.jobId === options.job) fail(`job ${options.job} was already signed off`);
    fail(`${options.record}: sign-off record already exists`);
  }

  const catalog = readCatalog(options.catalog);
  const records = catalog.flatMap((input) => input.records);
  const drafted = records.filter((entry) => recordField(entry, 'draftedBy')?.value === options.job);
  const draftRecords = drafted.filter((entry) => recordField(entry, 'lifecycle')?.value === 'draft');
  if (!drafted.length) fail(`nothing was drafted by that job: ${options.job}`);
  if (!draftRecords.length) fail(`job ${options.job} was already signed off`);

  const skipped = drafted.filter((entry) => recordField(entry, 'lifecycle')?.value === 'placeholder' ||
    recordField(entry, 'gapFill')?.value === 'placeholder').map((entry) => ({ id: entry.id, reason: 'placeholder' }));
  const promotions = draftRecords.filter((entry) => !skipped.some((item) => item.id === entry.id)).map((entry) => ({
    ...entry,
    lifecycle: recordField(entry, 'lifecycle'),
  }));

  writePromotions(catalog, promotions);
  writeFileSync(options.record, `${JSON.stringify({
    jobId: options.job,
    signedAt: new Date().toISOString(),
    signerWords: options.signerWords,
    promoted: promotions.map((entry) => entry.id),
    skipped,
  }, null, 2)}\n`);
  console.log(`promoted ${promotions.length} entries; skipped ${skipped.length} placeholders`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
