#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const appExtension = 'app.caelos';
const referencePattern = /^\{([^{}]+)\}$/u;

function parseArguments(argv) {
  const options = {
    catalog: path.resolve('token_catalog'),
    schema: path.resolve('token_catalog/recipe.schema.json'),
    out: path.resolve('token_catalog/versions.lock.json'),
    dependents: undefined,
  };
  const flags = new Map([
    ['--catalog', 'catalog'],
    ['--schema', 'schema'],
    ['--out', 'out'],
    ['--dependents', 'dependents'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = flags.get(argv[index]);
    if (!option || index + 1 >= argv.length) {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
    const value = argv[index + 1];
    options[option] = option === 'dependents' ? value : path.resolve(value);
    index += 1;
  }
  return options;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function serialise(value) {
  return JSON.stringify(canonical(value));
}

function fingerprint(value) {
  return createHash('sha256').update(serialise(value)).digest('hex');
}

function ignoredFields(schema) {
  const ignored = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.properties && typeof node.properties === 'object') {
      for (const [name, definition] of Object.entries(node.properties)) {
        if (definition?.['x-caelos-ignore-for-change'] === true) ignored.add(name);
      }
    }
    for (const value of Object.values(node)) visit(value);
  }
  visit(schema);
  return ignored;
}

function extension(node) {
  return node?.$extensions?.[appExtension];
}

function addDefinition(map, name, definition) {
  const definitions = map.get(name) ?? [];
  definitions.push(definition);
  map.set(name, definitions);
}

async function loadCatalog(directory) {
  const files = (await readdir(directory))
    .filter((file) => /^0[0-5]-.*\.tokens\.json$/u.test(file))
    .sort();
  const tokens = new Map();
  const entries = new Map();
  for (const file of files) {
    const tier = Number.parseInt(file.slice(0, 2), 10);
    const root = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    function visit(node, segments = []) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const name = segments.join('.');
      const isToken = Object.hasOwn(node, '$value');
      const isEntry = isToken || (tier > 0 && segments.length === 3);
      const definition = { file, name, node, tier };
      if (isToken) addDefinition(tokens, name, definition);
      if (isEntry) addDefinition(entries, name, definition);
      if (isToken) return;
      for (const key of Object.keys(node).filter((key) => !key.startsWith('$')).sort()) {
        visit(node[key], [...segments, key]);
      }
    }
    visit(root);
  }
  return { entries, tokens };
}

function variantSelections(definitions) {
  const axes = new Map();
  for (const { node } of definitions) {
    const variants = extension(node)?.variants;
    if (!variants || typeof variants !== 'object' || Array.isArray(variants)) continue;
    for (const [axis, values] of Object.entries(variants)) {
      if (!Array.isArray(values)) throw new Error(`Variant axis ${axis} must be an array`);
      const existing = axes.get(axis) ?? new Map();
      for (const value of values) existing.set(serialise(value), value);
      axes.set(axis, existing);
    }
  }
  const names = [...axes.keys()].sort();
  let selections = [{}];
  for (const name of names) {
    const values = [...axes.get(name).values()].sort((left, right) => serialise(left).localeCompare(serialise(right)));
    selections = selections.flatMap((selection) => values.map((value) => ({ ...selection, [name]: value })));
  }
  return selections;
}

function selectionName(selection) {
  return Object.keys(selection).sort().map((axis) => `${axis}=${String(selection[axis])}`).join(',');
}

function createResolver(catalog, ignored) {
  const entryMemo = new Map();
  const tokenMemo = new Map();

  function clean(value, inAppRecord = false) {
    if (Array.isArray(value)) return value.map((item) => clean(item, false));
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (inAppRecord && ignored.has(key)) continue;
      const childIsAppRecord = key === appExtension;
      result[key] = clean(value[key], childIsAppRecord);
    }
    return result;
  }

  function definitionValue(definitions, resolve) {
    if (definitions.length === 1) return resolve(definitions[0]);
    return {
      $definitions: definitions
        .map((definition) => ({ file: definition.file, content: resolve(definition) }))
        .sort((left, right) => left.file.localeCompare(right.file)),
    };
  }

  function resolveValue(value, tokenStack) {
    if (typeof value === 'string') {
      const match = referencePattern.exec(value);
      return match ? resolveToken(match[1], tokenStack) : value;
    }
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, tokenStack));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, resolveValue(value[key], tokenStack)]));
  }

  function resolveToken(name, stack = []) {
    if (stack.includes(name)) throw new Error(`token reference cycle: ${[...stack, name].join(' -> ')}`);
    if (tokenMemo.has(name)) return tokenMemo.get(name);
    const definitions = catalog.tokens.get(name);
    if (!definitions) throw new Error(`Unknown token reference: ${name}`);
    const nextStack = [...stack, name];
    const resolved = definitionValue(definitions, ({ node }) => resolveValue(clean(node), nextStack));
    tokenMemo.set(name, resolved);
    return resolved;
  }

  function resolveEntry(name, stack = []) {
    if (stack.includes(name)) throw new Error(`madeOf cycle: ${[...stack, name].join(' -> ')}`);
    if (entryMemo.has(name)) return entryMemo.get(name);
    const definitions = catalog.entries.get(name);
    if (!definitions) throw new Error(`madeOf names missing entry: ${name}`);
    const nextStack = [...stack, name];
    const own = definitionValue(definitions, ({ node }) => resolveValue(clean(node), []));
    const madeOf = [...new Set(definitions.flatMap(({ node }) => extension(node)?.madeOf ?? []))].sort();
    const resolved = {
      content: own,
      madeOf: madeOf.map((dependency) => ({ entry: dependency, content: resolveEntry(dependency, nextStack) })),
    };
    entryMemo.set(name, resolved);
    return resolved;
  }

  return { clean, resolveEntry };
}

function createDependencyWalker(catalog, clean) {
  const tokenMemo = new Map();
  const entryMemo = new Map();

  function references(value, found = new Set()) {
    if (typeof value === 'string') {
      const match = referencePattern.exec(value);
      if (match) found.add(match[1]);
      return found;
    }
    if (Array.isArray(value)) {
      for (const item of value) references(item, found);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) references(item, found);
    }
    return found;
  }

  function tokenDependencies(name, stack = []) {
    if (stack.includes(name)) throw new Error(`token reference cycle: ${[...stack, name].join(' -> ')}`);
    if (tokenMemo.has(name)) return tokenMemo.get(name);
    const definitions = catalog.tokens.get(name);
    if (!definitions) throw new Error(`Unknown token reference: ${name}`);
    const result = new Set();
    if (definitions.some(({ tier }) => tier === 0)) result.add(name);
    const nextStack = [...stack, name];
    for (const definition of definitions) {
      for (const reference of references(clean(definition.node))) {
        for (const dependency of tokenDependencies(reference, nextStack)) result.add(dependency);
      }
    }
    tokenMemo.set(name, result);
    return result;
  }

  function entryDependencies(name, stack = []) {
    if (stack.includes(name)) throw new Error(`madeOf cycle: ${[...stack, name].join(' -> ')}`);
    if (entryMemo.has(name)) return entryMemo.get(name);
    const definitions = catalog.entries.get(name);
    if (!definitions) throw new Error(`madeOf names missing entry: ${name}`);
    const result = new Set();
    if (definitions.some(({ tier }) => tier === 0)) result.add(name);
    const nextStack = [...stack, name];
    for (const definition of definitions) {
      for (const reference of references(clean(definition.node))) {
        for (const dependency of tokenDependencies(reference)) result.add(dependency);
      }
      for (const dependency of extension(definition.node)?.madeOf ?? []) {
        for (const transitive of entryDependencies(dependency, nextStack)) result.add(transitive);
      }
    }
    entryMemo.set(name, result);
    return result;
  }

  return { entryDependencies };
}

async function run(options) {
  const schema = JSON.parse(await readFile(options.schema, 'utf8'));
  const catalog = await loadCatalog(options.catalog);
  const resolver = createResolver(catalog, ignoredFields(schema));
  const walker = createDependencyWalker(catalog, resolver.clean);

  if (options.dependents !== undefined) {
    const target = catalog.tokens.get(options.dependents);
    if (!target || !target.some(({ tier }) => tier === 0)) {
      throw new Error(`Not a tier 0 token: ${options.dependents}`);
    }
    const matches = [];
    for (const [name, definitions] of catalog.entries) {
      if (!walker.entryDependencies(name).has(options.dependents)) continue;
      matches.push(name);
      for (const selection of variantSelections(definitions)) {
        if (Object.keys(selection).length > 0) matches.push(`${name}#${selectionName(selection)}`);
      }
    }
    process.stdout.write(matches.sort().map((name) => `${name}\n`).join(''));
    return;
  }

  const entries = {};
  let variantCount = 0;
  for (const name of [...catalog.entries.keys()].sort()) {
    const definitions = catalog.entries.get(name);
    const content = resolver.resolveEntry(name);
    const variants = {};
    for (const selection of variantSelections(definitions)) {
      if (Object.keys(selection).length === 0) continue;
      variants[selectionName(selection)] = fingerprint({ content, selected: selection });
      variantCount += 1;
    }
    entries[name] = { fingerprint: fingerprint(content), variants };
  }
  const output = `${JSON.stringify(canonical({ entries }), null, 2)}\n`;
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, output);
  process.stdout.write(`Built lock: ${Object.keys(entries).length} entries, ${variantCount} variants\n`);
}

try {
  await run(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`Lock build failed: ${error.message}\n`);
  process.exitCode = 1;
}
