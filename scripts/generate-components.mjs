#!/usr/bin/env node
/**
 * Generate React components from catalog recipes.
 *
 * Job mode (`--job <id>`) writes exactly one JSON object to stdout. Its `gaps`
 * array contains non-fatal recipe gaps for the runner; operational failures still
 * use stderr and a non-zero exit code. Human-readable mode prints the same gaps.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveControlCatalog } from '../src/tier-2/control-catalog.mjs';
import { tokenName } from '../style-dictionary.config.mjs';

const appExtension = 'app.caelos';
const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function parseArguments(argv) {
  const options = {
    catalog: path.resolve('token_catalog'),
    templates: path.resolve('templates'),
    out: path.resolve('generated/components'),
    job: undefined,
  };
  const flags = new Map([
    ['--catalog', 'catalog'],
    ['--templates', 'templates'],
    ['--out', 'out'],
    ['--job', 'job'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = flags.get(argv[index]);
    if (!option || index + 1 >= argv.length) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    const value = argv[index + 1];
    options[option] = option === 'job' ? value : path.resolve(value);
    index += 1;
  }
  return options;
}

function extension(node) {
  return node?.$extensions?.[appExtension];
}

function hasField(record, node, field) {
  const segments = field.split('.');
  const source = Object.hasOwn(record, segments[0]) ? record : node;
  let value = source;
  for (const segment of segments) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return false;
    value = value[segment];
  }
  return value !== undefined && value !== null;
}

function fieldValue(record, node, field) {
  const segments = field.split('.');
  let value = Object.hasOwn(record, segments[0]) ? record : node;
  for (const segment of segments) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function isEmpty(value) {
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') return Object.keys(value).length === 0;
  return value === undefined || value === null;
}

function emptyVariantField(variants, segments = ['variants']) {
  if (typeof variants === 'string') return variants.trim() === '' ? segments.join('.') : null;
  if (Array.isArray(variants)) {
    if (variants.length === 0) return segments.join('.');
    for (let index = 0; index < variants.length; index += 1) {
      const found = emptyVariantField(variants[index], segments);
      if (found) return found;
    }
    return null;
  }
  if (!variants || typeof variants !== 'object') return null;
  if (Object.keys(variants).length === 0) return segments.join('.');
  for (const key of Object.keys(variants).sort(compareCodeUnits)) {
    const found = emptyVariantField(variants[key], [...segments, key]);
    if (found) return found;
  }
  return null;
}

function identifier(value) {
  const words = value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  return /^\d/u.test(name) ? `Component${name}` : name;
}

function tokenVariables(node, entrySegments) {
  const variables = {};
  function visit(value, relative = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (Object.hasOwn(value, '$value')) {
      const variable = `var(--${tokenName([...entrySegments, ...relative])})`;
      const relativeName = relative.join('.');
      variables[relativeName] = variable;
      const leafName = relative.at(-1);
      if (!Object.hasOwn(variables, leafName)) variables[leafName] = variable;
      return;
    }
    for (const key of Object.keys(value).filter((key) => !key.startsWith('$')).sort(compareCodeUnits)) {
      visit(value[key], [...relative, key]);
    }
  }
  visit(node);
  return variables;
}

async function loadTemplates(directory) {
  const templates = new Map();
  async function filesBelow(current, relative = '') {
    const found = [];
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name))) {
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) found.push(...await filesBelow(path.join(current, entry.name), childRelative));
      else if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(childRelative);
    }
    return found;
  }
  for (const file of await filesBelow(directory)) {
    const kind = path.basename(file, '.mjs');
    if (templates.has(kind)) {
      throw new Error(`duplicate template kind "${kind}" in ${templates.get(kind).file} and ${file}`);
    }
    const template = await import(pathToFileURL(path.join(directory, file)).href);
    if (!Array.isArray(template.requiredFields) || typeof template.render !== 'function') {
      throw new Error(`${file} must export requiredFields and render`);
    }
    templates.set(kind, { ...template, file });
  }
  return templates;
}

async function loadCatalog(directory) {
  const files = (await readdir(directory))
    .filter((file) => /^0[0-5]-.*\.tokens\.json$/u.test(file))
    .sort(compareCodeUnits);
  const allEntries = new Map();
  const candidates = [];
  for (const file of files) {
    const tier = Number.parseInt(file.slice(0, 2), 10);
    const parsed = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    let root = parsed;
    if (tier === 2 && parsed.controls?.$extensions?.[appExtension]?.sharedConstruction) {
      const buttonEntry = Object.entries(parsed.controls?.shared ?? {})
        .find(([, entry]) => extension(entry)?.kind === 'button' &&
          extension(entry)?.construction && extension(entry)?.statePaints);
      if (buttonEntry) {
        const [buttonName, button] = buttonEntry;
        if (buttonName === 'button') {
          root = resolveControlCatalog(parsed);
        } else {
          const canonicalInput = structuredClone(parsed);
          canonicalInput.controls.shared.button = structuredClone(button);
          const resolved = resolveControlCatalog(canonicalInput);
          root = structuredClone(parsed);
          root.controls.shared[buttonName] = resolved.controls.shared.button;
        }
      }
    }
    function visit(node, segments = []) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      if (tier === 0 && Object.hasOwn(node, '$value')) {
        allEntries.set(segments.join('.'), {
          name: segments.join('.'), segments, tier, node, record: extension(node) ?? {},
          componentName: identifier(segments.at(-1)),
          className: `caelos-${tokenName(segments)}`,
          variables: {},
        });
        return;
      }
      if (tier > 0 && segments.length === 3) {
        const record = extension(node);
        if (!record) return;
        const entry = {
          name: segments.join('.'),
          segments,
          tier,
          node,
          record,
          componentName: identifier(segments.at(-1)),
          className: `caelos-${tokenName(segments)}`,
          variables: tokenVariables(node, segments),
        };
        allEntries.set(entry.name, entry);
        if (record.recipeInStaging === true || typeof record.kind === 'string' || Array.isArray(record.madeOf)) {
          candidates.push(entry);
        }
        return;
      }
      for (const key of Object.keys(node).filter((key) => !key.startsWith('$')).sort(compareCodeUnits)) {
        visit(node[key], [...segments, key]);
      }
    }
    visit(root);
  }
  candidates.sort((left, right) => left.tier - right.tier || compareCodeUnits(left.name, right.name));
  return { allEntries, candidates };
}

function gap(entry, reason, field) {
  return { entry: entry.name, reason, ...(field ? { field } : {}) };
}

function orderParts(entry, parts) {
  const positions = new Map((entry.record.layerOrder ?? []).map((name, index) => [name, index]));
  return [...parts].sort((left, right) => {
    const leftPosition = positions.get(left.name) ?? Number.MAX_SAFE_INTEGER;
    const rightPosition = positions.get(right.name) ?? Number.MAX_SAFE_INTEGER;
    return leftPosition - rightPosition || compareCodeUnits(left.name, right.name);
  });
}

function nestedInteractivePath(entry, parts, allEntries, templates, interactiveElement) {
  function visit(part, path, ancestors) {
    if (ancestors.has(part.name)) return null;
    const nextPath = [...path, part];
    const partTemplate = templates.get(part.record.kind);
    if (partTemplate?.interactiveElement === interactiveElement) return nextPath;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(part.name);
    const madeOf = Array.isArray(part.record.madeOf) ? part.record.madeOf : [];
    for (const name of madeOf) {
      const child = allEntries.get(name);
      if (!child) continue;
      const nested = visit(child, nextPath, nextAncestors);
      if (nested) return nested;
    }
    return null;
  }

  for (const part of parts) {
    const nested = visit(part, [entry], new Set([entry.name]));
    if (nested) return nested;
  }
  return null;
}

async function generate(options) {
  const templates = await loadTemplates(options.templates);
  const { allEntries, candidates } = await loadCatalog(options.catalog);
  const gaps = [];
  const generated = new Map();
  const outputs = new Map();
  const reservedNames = new Map();
  await mkdir(options.out, { recursive: true });

  for (const entry of candidates) {
    if (!hasField(entry.record, entry.node, 'kind')) {
      gaps.push(gap(entry, 'missing required field "kind"', 'kind'));
      continue;
    }
    if (isEmpty(fieldValue(entry.record, entry.node, 'kind'))) {
      gaps.push(gap(entry, 'empty required field "kind"', 'kind'));
      continue;
    }
    const template = templates.get(entry.record.kind);
    if (!template) {
      gaps.push(gap(entry, `no template for kind "${entry.record.kind}"`));
      continue;
    }
    const missing = template.requiredFields.find((field) => !hasField(entry.record, entry.node, field) ||
      isEmpty(fieldValue(entry.record, entry.node, field)));
    if (missing) {
      gaps.push(gap(entry, `missing or empty required field "${missing}"`, missing));
      continue;
    }
    if (entry.tier > 2 && (!hasField(entry.record, entry.node, 'madeOf') ||
      isEmpty(fieldValue(entry.record, entry.node, 'madeOf')))) {
      gaps.push(gap(entry, 'missing required field "madeOf"', 'madeOf'));
      continue;
    }
    const madeOf = Array.isArray(entry.record.madeOf) ? entry.record.madeOf : [];
    const emptyMadeOf = madeOf.findIndex((name) => typeof name !== 'string' || name.trim() === '');
    if (emptyMadeOf !== -1) {
      gaps.push(gap(entry, `empty value in field "madeOf" at index ${emptyMadeOf}`, 'madeOf'));
      continue;
    }
    const emptyVariant = hasField(entry.record, entry.node, 'variants')
      ? emptyVariantField(fieldValue(entry.record, entry.node, 'variants')) : null;
    if (emptyVariant) {
      gaps.push(gap(entry, `empty value in field "${emptyVariant}"`, emptyVariant));
      continue;
    }
    const templateGap = typeof template.validate === 'function' ? template.validate(entry) : null;
    if (templateGap) {
      gaps.push(gap(entry, templateGap.reason, templateGap.field));
      continue;
    }
    const missingPart = madeOf.find((name) => !allEntries.has(name));
    if (missingPart) {
      gaps.push(gap(entry, `madeOf names missing entry "${missingPart}"`, 'madeOf'));
      continue;
    }
    const dependencies = madeOf.map((name) => allEntries.get(name));
    const parts = dependencies.filter((part) => part.tier > 0);
    if (entry.tier > 2) {
      const unbuiltPart = parts.find((part) => !generated.has(part.name));
      if (unbuiltPart) {
        gaps.push(gap(entry, `madeOf part "${unbuiltPart.name}" was not generated`, 'madeOf'));
        continue;
      }
      const interactivePath = typeof template.interactiveElement === 'string'
        ? nestedInteractivePath(entry, parts, allEntries, templates, template.interactiveElement)
        : null;
      if (interactivePath) {
        gaps.push(gap(entry,
          `interactive ${template.interactiveElement} part "${interactivePath.at(-1).name}" would nest inside the same interactive element via ${interactivePath.map((part) => part.name).join(' → ')}`,
          'madeOf'));
        continue;
      }
    }
    const collision = reservedNames.get(entry.componentName);
    if (collision) {
      gaps.push(gap(entry, `output name also belongs to "${collision}"`));
      continue;
    }
    const variable = (reference) => {
      const match = /^\{([^{}]+)\}$/u.exec(reference);
      if (!match) throw new Error(`Paint value for ${entry.name} is not a token reference: ${JSON.stringify(reference)}`);
      return `var(--${tokenName(match[1].split('.'))})`;
    };
    const output = template.render({ ...entry, parts: orderParts(entry, parts), variable });
    if (!output || typeof output.tsx !== 'string' || typeof output.css !== 'string') {
      throw new Error(`Template "${entry.record.kind}" returned invalid output for ${entry.name}`);
    }
    const clientSource = output.tsx.startsWith('"use client";\n') ? output.tsx : `"use client";\n${output.tsx}`;
    outputs.set(`${entry.componentName}.tsx`, clientSource);
    outputs.set(`${entry.componentName}.css`, output.css);
    reservedNames.set(entry.componentName, entry.name);
    generated.set(entry.name, entry);
  }

  const existing = await readdir(options.out, { withFileTypes: true });
  for (const file of existing) {
    if (file.isFile() && /\.(?:tsx|css)$/u.test(file.name) && !outputs.has(file.name)) {
      await unlink(path.join(options.out, file.name));
    }
  }
  for (const [file, content] of [...outputs].sort(([left], [right]) => compareCodeUnits(left, right))) {
    await writeFile(path.join(options.out, file), content);
  }

  gaps.sort((left, right) => compareCodeUnits(left.entry, right.entry) || compareCodeUnits(left.reason, right.reason));
  const exports = [...generated.values()]
    .sort((left, right) => compareCodeUnits(left.componentName, right.componentName))
    .map((entry) => `export { ${entry.componentName} } from './${entry.componentName}';`);
  const index = ['// Generated by scripts/generate-components.mjs. Do not edit.', ...(exports.length ? exports : ['export {};']), ''].join('\n');
  await writeFile(path.join(options.out, 'index.ts'), index);
  return { gaps, generated: [...generated.keys()].sort(compareCodeUnits) };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await generate(options);
  if (options.job !== undefined) {
    process.stdout.write(`${JSON.stringify({ job: options.job, ...result })}\n`);
  } else {
    process.stdout.write(`Generated components: ${result.generated.length}\n`);
    process.stdout.write(`Skipped components (${result.gaps.length}):\n`);
    for (const item of result.gaps) process.stdout.write(`- ${item.entry}: ${item.reason}\n`);
  }
} catch (error) {
  process.stderr.write(`Component generation failed: ${error.message}\n`);
  process.exitCode = 1;
}
