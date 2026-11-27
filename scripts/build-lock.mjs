#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveControlCatalog } from '../src/tier-2/control-catalog.mjs';

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

function ignoredFields(schema, marker) {
  const ignored = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.properties && typeof node.properties === 'object') {
      for (const [name, definition] of Object.entries(node.properties)) {
        if (definition?.[marker] === true) ignored.add(name);
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

function catalogFromSources(sources) {
  const tokens = new Map();
  const entries = new Map();
  for (const { file, root } of sources) {
    const tier = Number.parseInt(path.basename(file).slice(0, 2), 10);
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

function expandControlSources(sources) {
  return sources.map(({ file, root }) => ({
    file,
    root: root?.controls?.$extensions?.[appExtension]?.sharedConstruction
      ? resolveControlCatalog(root)
      : root,
  }));
}

async function loadCatalog(directory) {
  const files = (await readdir(directory))
    .filter((file) => /^0[0-5]-.*\.tokens\.json$/u.test(file))
    .sort();
  const sources = await Promise.all(files.map(async (file) => ({
    file,
    root: JSON.parse(await readFile(path.join(directory, file), 'utf8')),
  })));
  const expandedSources = expandControlSources(sources);
  return { ...catalogFromSources(expandedSources), sources: expandedSources };
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
      const child = clean(value[key], childIsAppRecord);
      result[key] = child;
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

function createContentResolver(catalog) {
  const tokenMemo = new Map();

  function resolveValue(value, stack = []) {
    if (typeof value === 'string') {
      const match = referencePattern.exec(value);
      return match ? resolveTokenValue(match[1], stack) : value;
    }
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, stack));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, resolveValue(value[key], stack)]));
  }

  function resolveTokenValue(name, stack = []) {
    if (stack.includes(name)) throw new Error(`token reference cycle: ${[...stack, name].join(' -> ')}`);
    if (tokenMemo.has(name)) return tokenMemo.get(name);
    const definitions = catalog.tokens.get(name);
    if (!definitions) throw new Error(`Unknown token reference: ${name}`);
    const nextStack = [...stack, name];
    const values = definitions.map(({ node }) => resolveValue(node.$value, nextStack));
    const resolved = values.length === 1
      ? values[0]
      : { $definitions: values.sort((left, right) => serialise(left).localeCompare(serialise(right))) };
    tokenMemo.set(name, resolved);
    return resolved;
  }

  function entryContent(name) {
    const definitions = catalog.entries.get(name);
    if (!definitions) throw new Error(`Missing entry: ${name}`);
    const tokens = [];
    for (const { node } of definitions) {
      function visit(value, segments = []) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        if (Object.hasOwn(value, '$value')) {
          tokens.push([segments.join('.'), resolveValue(value.$value), value.$type ?? null]);
          return;
        }
        for (const key of Object.keys(value).filter((key) => !key.startsWith('$')).sort()) {
          visit(value[key], [...segments, key]);
        }
      }
      visit(node);
    }
    const madeOf = [...new Set(definitions.flatMap(({ node }) => extension(node)?.madeOf ?? []))].sort();
    return {
      madeOf,
      tokens: tokens.sort((left, right) => serialise(left).localeCompare(serialise(right))),
    };
  }

  function resolveSelectionValues(selection) {
    return Object.entries(selection)
      .map(([axis, value]) => [axis, resolveValue(value)])
      .sort((left, right) => serialise(left).localeCompare(serialise(right)));
  }

  return { entryContent, resolveSelectionValues };
}

function hasTokenReference(value) {
  if (typeof value === 'string') return referencePattern.test(value);
  if (Array.isArray(value)) return value.some(hasTokenReference);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasTokenReference);
}

export function buildContentFingerprintRecords(sources) {
  const catalog = catalogFromSources(expandControlSources(sources));
  return contentFingerprintRecords(catalog);
}

function contentFingerprintRecords(catalog) {
  const resolver = createContentResolver(catalog);
  const records = new Map();
  for (const name of [...catalog.entries.keys()].sort()) {
    const definitions = catalog.entries.get(name);
    const content = resolver.entryContent(name);
    const variantContentFingerprints = new Map();
    const emptyVariants = new Set();
    for (const selection of variantSelections(definitions)) {
      if (Object.keys(selection).length === 0) continue;
      const selected = resolver.resolveSelectionValues(selection);
      const variant = selectionName(selection);
      variantContentFingerprints.set(variant, fingerprint({ content, selected }));
      if (content.tokens.length === 0 && content.madeOf.length === 0 && !hasTokenReference(selection)) {
        emptyVariants.add(variant);
      }
    }
    records.set(name, {
      contentFingerprint: fingerprint(content),
      empty: content.tokens.length === 0 && content.madeOf.length === 0,
      emptyVariants,
      variantContentFingerprints,
    });
  }
  return records;
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

async function buildLockModel(catalogDirectory, schemaFile) {
  const schema = JSON.parse(await readFile(schemaFile, 'utf8'));
  const catalog = await loadCatalog(catalogDirectory);
  const changeResolver = createResolver(catalog, ignoredFields(schema, 'x-caelos-ignore-for-change'));
  const contentRecords = contentFingerprintRecords(catalog);
  const walker = createDependencyWalker(catalog, changeResolver.clean);

  const entries = {};
  let variantCount = 0;
  for (const name of [...catalog.entries.keys()].sort()) {
    const definitions = catalog.entries.get(name);
    const changeContent = changeResolver.resolveEntry(name);
    const contentRecord = contentRecords.get(name);
    const variants = {};
    const variantContentFingerprints = {};
    const emptyVariants = [];
    for (const selection of variantSelections(definitions)) {
      if (Object.keys(selection).length === 0) continue;
      const variant = selectionName(selection);
      variants[variant] = fingerprint({ content: changeContent, selected: selection });
      variantContentFingerprints[variant] = contentRecord.variantContentFingerprints.get(variant);
      if (contentRecord.emptyVariants.has(variant)) emptyVariants.push(variant);
      variantCount += 1;
    }
    entries[name] = {
      fingerprint: fingerprint(changeContent),
      contentFingerprint: contentRecord.contentFingerprint,
      variants,
      variantContentFingerprints,
      ...(contentRecord.empty ? { empty: true } : {}),
      ...(emptyVariants.length ? { emptyVariants } : {}),
    };
  }
  return {
    catalog,
    document: canonical({ entries }),
    variantCount,
    walker,
  };
}

export async function buildLock({ catalog, schema }) {
  return (await buildLockModel(catalog, schema)).document;
}

async function run(options) {
  const model = await buildLockModel(options.catalog, options.schema);
  if (options.dependents !== undefined) {
    const target = model.catalog.tokens.get(options.dependents);
    if (!target || !target.some(({ tier }) => tier === 0)) {
      throw new Error(`Not a tier 0 token: ${options.dependents}`);
    }
    const matches = [];
    for (const [name, definitions] of model.catalog.entries) {
      if (!model.walker.entryDependencies(name).has(options.dependents)) continue;
      matches.push(name);
      for (const selection of variantSelections(definitions)) {
        if (Object.keys(selection).length > 0) matches.push(`${name}#${selectionName(selection)}`);
      }
    }
    process.stdout.write(matches.sort().map((name) => `${name}\n`).join(''));
    return;
  }

  const output = `${JSON.stringify(model.document, null, 2)}\n`;
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, output);
  process.stdout.write(
    `Built lock: ${Object.keys(model.document.entries).length} entries, ${model.variantCount} variants\n`,
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await run(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`Lock build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
