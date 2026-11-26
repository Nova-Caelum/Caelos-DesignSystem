import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = 'token_catalog';
const extension = 'app.caelos';
const tierFile = /^0[0-5]-[\w.-]+\.tokens\.json$/;
export const exceptionsFile = `${directory}/tier-line.exceptions.json`;
const paintFile = `${directory}/paint-families.json`;
const gitRoot = process.env.CAELOS_CATALOG_GIT_ROOT || process.cwd();
const maxBuffer = 16 * 1024 * 1024;

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function options(args, allowed) {
  const values = { base: 'origin/main' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!allowed.includes(flag) || seen.has(flag) || !value || value.startsWith('--')) {
      throw new Error(`invalid argument ${flag}; use ${allowed.map((name) => `${name} <value>`).join(', ')}`);
    }
    seen.add(flag);
    values[flag.slice(2)] = value;
  }
  return values;
}

function git(args) {
  return execFileSync('git', ['-C', gitRoot, ...args], { encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function baseTree(ref) {
  try {
    return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`]).trim();
  } catch {
    throw new Error(`cannot read Git base ${ref}; fetch the base branch or pass --base <ref>`);
  }
}

export function readJson(file, tree) {
  const source = tree ? `${file} at base ${tree}` : file;
  try {
    const data = tree ? git(['show', `${tree}:${file}`]) : readFileSync(file, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : 'cannot read input';
    throw new Error(`${source}: ${reason}; supply a readable JSON file`);
  }
}

export function treeFiles(tree, prefix) {
  const args = ['ls-tree', '-r', '--name-only', '-z', tree, '--'];
  if (prefix) args.push(prefix);
  return new Set(git(args).split('\0').filter(Boolean));
}

function readCatalog(tree) {
  const files = tree
    ? [...treeFiles(tree, directory)].map((file) => file.slice(directory.length + 1))
    : readdirSync(directory);
  const catalog = { entries: [], tokens: [], files: files.filter((file) => tierFile.test(file)).sort() };
  if (!catalog.files.length) throw new Error(`${directory}: missing tier files; restore the catalog inputs`);

  function visit(node, segments, tier, file, recipe) {
    const name = segments.join('.');
    if (!object(node)) throw new Error(`${file} entry ${name}: expected a catalog object; restore its record`);
    const token = Object.hasOwn(node, '$value');
    const group = tier > 0 && segments.length === 3;
    if (group) recipe = name;
    if (token || group) catalog.entries.push({ name, tier, file, node, group });
    if (token) {
      catalog.tokens.push({ name, tier, recipe: recipe ?? name, segments, node });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!key.startsWith('$')) visit(child, [...segments, key], tier, file, recipe);
    }
  }

  for (const file of catalog.files) {
    visit(readJson(`${directory}/${file}`, tree), [], Number(file.slice(0, 2)), file);
  }
  return catalog;
}

function stringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim());
}

export function exceptionNames(data, label) {
  if (!stringList(data) || new Set(data).size !== data.length) {
    throw new Error(`${label}: expected an array of distinct token names; fix the exception list`);
  }
  return new Set(data);
}

function paintFamilies() {
  const data = readJson(paintFile);
  if (!object(data) || !Object.keys(data).length || Object.values(data).some((family) =>
    !object(family) || !stringList(family.tokenTypes) || !stringList(family.pathFamilies))) {
    throw new Error(`${paintFile}: expected tokenTypes and pathFamilies arrays for each paint family; fix the paint definitions`);
  }
  return {
    types: new Set(Object.values(data).flatMap((family) => family.tokenTypes)),
    paths: new Set(Object.values(data).flatMap((family) => family.pathFamilies)),
  };
}

function paintTokens(catalog, families) {
  const byName = new Map();
  for (const token of catalog.tokens) {
    if (!byName.has(token.name)) byName.set(token.name, []);
    byName.get(token.name).push(token);
  }

  function isPaint(token, visited) {
    if (visited.has(token)) return false;
    visited.add(token);
    const segments = token.tier === 0 ? token.segments.slice(1) : token.segments.slice(3);
    const words = segments.flatMap((segment) => segment.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/));
    if (families.types.has(token.node.$type) || words.some((word) => families.paths.has(word))) return true;
    const target = typeof token.node.$value === 'string' && /^\{([^{}]+)\}$/.exec(token.node.$value)?.[1];
    return (byName.get(target) ?? []).some((candidate) => isPaint(candidate, visited));
  }

  return catalog.tokens.filter((token) => token.tier > 2 && isPaint(token, new Set()));
}

export function legacyPaintNames(tree) {
  return paintTokens(readCatalog(tree), paintFamilies()).map((token) => token.name).sort();
}

function materialRecord(node, ignored) {
  if (Array.isArray(node)) return node.map((item) => materialRecord(item, ignored));
  if (!object(node)) return node;
  const result = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, materialRecord(value, ignored)]));
  if (object(result.$extensions?.[extension])) {
    const fields = result.$extensions[extension];
    for (const key of ignored) delete fields[key];
    if (!Object.keys(fields).length) delete result.$extensions[extension];
    if (!Object.keys(result.$extensions).length) delete result.$extensions;
  }
  return result;
}

function pairedEntries(file, catalog) {
  if (!file) return new Set();
  const data = readJson(file);
  const names = Array.isArray(data) ? data : object(data) ? Object.values(data) : null;
  if (!stringList(names)) throw new Error(`${file}: expected entry names or a need-to-entry map; fix the match file`);
  const paired = new Set(names.filter((name) => name !== 'none' && name !== 'none, new kind'));
  const known = new Set(catalog.entries.map((entry) => entry.name));
  for (const name of paired) {
    if (!known.has(name)) throw new Error(`${file} entry ${name}: unknown paired entry; select a catalog entry or record none`);
  }
  return paired;
}

async function templateFields() {
  let files;
  try {
    files = readdirSync('templates', { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const templates = new Map();
  for (const entry of files.filter((file) => file.isFile() && file.name.endsWith('.mjs'))) {
    const file = path.join(entry.parentPath, entry.name);
    const kind = path.basename(entry.name, '.mjs');
    const { requiredFields } = await import(pathToFileURL(path.resolve(file)).href);
    if (!stringList(requiredFields) || requiredFields.some((field) => field.split('.').some((segment) => !segment)) ||
        templates.has(kind)) {
      throw new Error(`${file}: expected one template per kind exporting requiredFields; declare the recipe field paths in the template`);
    }
    templates.set(kind, requiredFields);
  }
  return templates;
}

function schemaError(value, rule) {
  if (rule.type === 'object' ? !object(value) : rule.type === 'array' ? !Array.isArray(value) : typeof value !== rule.type) {
    return `expected ${rule.type}`;
  }
  if (rule.enum && !rule.enum.includes(value)) return `use one of ${rule.enum.join(', ')}`;
  if (rule.minLength && value.trim().length < rule.minLength) return 'supply a non-empty string';
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) return 'supply a structured identifier';
  if (rule.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value) || Number.isNaN(Date.parse(value)))) {
    return 'supply a date and time with a timezone';
  }
  if (rule.minProperties && Object.keys(value).length < rule.minProperties) return 'describe the accepted contents as structured data';
  if (rule.minItems && value.length < rule.minItems) return 'list at least one lower-tier entry';
  if (rule.uniqueItems && new Set(value).size !== value.length) return 'remove duplicate items';
  if (rule.items) {
    for (const item of value) {
      const reason = schemaError(item, rule.items);
      if (reason) return reason;
    }
  }
  return undefined;
}

function fieldValue(node, record, name) {
  const segments = name.split('.');
  let value = Object.hasOwn(record, segments[0]) ? record : node;
  for (const segment of segments) {
    if (!object(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function proseField(name) {
  return /^(?:\$?description|note|notes|prose|instructions)$/i.test(name);
}

function hasProseSource(value) {
  if (typeof value === 'string') return /\s/.test(value.trim());
  if (Array.isArray(value)) return value.some(hasProseSource);
  if (object(value)) return Object.entries(value).some(([key, child]) => proseField(key) || hasProseSource(child));
  return false;
}

async function checkRecipes({ base, paired }) {
  const schema = readJson(`${directory}/recipe.schema.json`);
  if (!object(schema.properties) || !stringList(schema.required) ||
      schema.required.some((name) => !Object.hasOwn(schema.properties, name))) {
    throw new Error('recipe.schema.json: expected record properties and required field names; fix the recipe schema');
  }
  const ignored = Object.keys(schema.properties).filter((key) => schema.properties[key]['x-caelos-ignore-for-change']);
  const current = readCatalog();
  const tree = baseTree(base);
  const previous = readCatalog(tree);
  // A hook provides a checkout-index snapshot. Compare that snapshot directly
  // with the base tree so unstaged edits and alternate indexes stay out of it.
  const changedFiles = process.env.CAELOS_CATALOG_GIT_ROOT ? null : new Set(
    git(['diff', '--name-only', '--no-renames', '-z', tree, '--', directory]).split('\0'),
  );
  for (const file of previous.files) {
    if (!current.files.includes(file)) throw new Error(`${directory}/${file}: missing tier input; restore the catalog file`);
  }
  const entriesAtBase = new Map(previous.entries.map((entry) => [`${entry.file}:${entry.name}`, entry.node]));
  const tierByName = new Map();
  for (const entry of current.entries.filter((record) => record.group || record.tier === 0)) {
    tierByName.set(entry.name, Math.min(tierByName.get(entry.name) ?? Infinity, entry.tier));
  }
  const matches = pairedEntries(paired, current);
  const templates = await templateFields();
  const errors = [];

  for (const entry of current.entries) {
    const { name, node, tier, file, group } = entry;
    const say = (message) => errors.push(`tier ${tier} entry ${name}: ${message}`);
    const record = node.$extensions?.[extension];
    if (!object(record)) {
      say(`missing recipe record; add $extensions["${extension}"] with the required fields`);
      continue;
    }
    const old = entriesAtBase.get(`${file}:${name}`);
    const changed = !changedFiles || changedFiles.has(`${directory}/${file}`);
    const active = matches.has(name) || !old || (changed && !isDeepStrictEqual(materialRecord(old, ignored), materialRecord(node, ignored)));
    const required = new Set(schema.required);
    for (const [key, rule] of Object.entries(schema.properties)) {
      const recipeTier = rule['x-caelos-recipe-tier'];
      if (active && group && (rule['x-caelos-required-on-active-recipe'] ||
          tier >= rule['x-caelos-required-from-tier'] || tier === recipeTier)) required.add(key);
      if (!Object.hasOwn(record, key)) continue;
      if (recipeTier !== undefined && (!group || tier !== recipeTier)) {
        say(`${key} belongs on a tier ${recipeTier} shell; move the contents contract to that shell`);
      }
      const reason = schemaError(record[key], rule);
      if (reason) say(`${key} violates its schema; ${reason}`);
    }
    for (const key of required) {
      if (!Object.hasOwn(record, key)) say(`requires ${key}; add ${key} to the recipe record`);
    }
    if (Array.isArray(record.madeOf)) {
      for (const dependency of record.madeOf) {
        if (typeof dependency === 'string' && !(tierByName.get(dependency) < tier)) {
          say(`madeOf names ${dependency}, which is not a lower-tier entry; choose an existing entry below tier ${tier}`);
        }
      }
    }
    for (const name of templates.get(record.kind) ?? []) {
      const value = fieldValue(node, record, name);
      if (value === undefined || value === null || value === '') {
        if (active) say(`template requires ${name}; supply the structured recipe field`);
      } else if (name.split('.').some(proseField) || (name !== 'contents' && hasProseSource(value))) {
        say(`template field ${name} uses prose as a source; supply structured identifiers, values, or references`);
      }
    }
  }

  const exceptions = exceptionNames(readJson(exceptionsFile), exceptionsFile);
  for (const token of paintTokens(current, paintFamilies())) {
    if (exceptions.has(token.name)) continue;
    errors.push(`tier ${token.tier} entry ${token.recipe} declares paint token ${token.name}; paint enters only at tiers 0 to 2; move it into a tier 1 or 2 entry and list that entry in madeOf`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Recipe schema and paint line passed.');
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`${command} stopped by ${result.signal}`);
  return result.status;
}

function tierDrift(script) {
  if (process.env.CAELOS_CATALOG_GIT_ROOT) return run(process.execPath, [script, process.cwd()]);
  const snapshot = mkdtempSync(path.join(tmpdir(), 'caelos-catalog-check-'));
  try {
    const root = realpathSync('.');
    const files = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
    for (const file of files) {
      let stat;
      try {
        const parent = path.resolve(root, path.dirname(file));
        if (realpathSync(parent) !== parent) throw new Error(`${file}: unsupported symlink in tracked path`);
        stat = lstatSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isDirectory()) throw new Error(`${file}: expected a tracked file; cannot snapshot a directory entry`);
      const dest = path.join(snapshot, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(file, dest, { verbatimSymlinks: true });
    }
    return run(process.execPath, [script, snapshot]);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function checkCatalog([drift, recipes, ratchet, separator, ...args]) {
  if (!drift || !recipes || !ratchet || separator !== '--') throw new Error('check:catalog: missing configured checks');
  const { base, paired, baseline } = options(args, ['--base', '--paired', '--baseline']);
  const recipeArgs = ['--base', base];
  const ratchetArgs = ['--base', base];
  if (paired) recipeArgs.push('--paired', paired);
  if (baseline) ratchetArgs.push('--baseline', baseline);
  return tierDrift(drift) || run('npm', ['run', recipes, '--', ...recipeArgs]) || run('npm', ['run', ratchet, '--', ...ratchetArgs]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--catalog') process.exitCode = checkCatalog(args.slice(1));
    else await checkRecipes(options(args, ['--base', '--paired']));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
