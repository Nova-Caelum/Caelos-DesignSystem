import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const directory = 'token_catalog';
const extension = 'app.caelos';
const tierFile = /^0[0-5]-[\w.-]+\.tokens\.json$/;
export const exceptionsFile = `${directory}/tier-line.exceptions.json`;
export const schemaFile = `${directory}/recipe.schema.json`;
export const paintFile = `${directory}/paint-families.json`;
export const trustedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBuffer = 16 * 1024 * 1024;
const annotationKeys = new Set(['title', 'description', '$comment']);
const topSchemaKeys = new Set(['$schema', 'title', 'description', '$comment', 'type', 'required', 'properties']);
const propertySchemaKeys = new Set([
  'type', 'enum', 'minLength', 'pattern', 'format', 'minProperties', 'minItems', 'uniqueItems', 'items',
]);

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionName(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function options(args, allowed) {
  const values = {
    base: 'origin/main',
    candidate: process.cwd(),
    gitRoot: process.env.CAELOS_CATALOG_GIT_ROOT || process.cwd(),
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!allowed.includes(flag) || seen.has(flag) || !value || value.startsWith('--')) {
      throw new Error(`invalid argument ${flag}; use ${allowed.map((name) => `${name} <value>`).join(', ')}`);
    }
    seen.add(flag);
    values[optionName(flag)] = value;
  }
  values.candidate = path.resolve(values.candidate);
  values.gitRoot = path.resolve(values.gitRoot);
  values.provided = seen;
  return values;
}

export function createContext(values) {
  return { candidate: path.resolve(values.candidate), gitRoot: path.resolve(values.gitRoot) };
}

function git(context, args) {
  return execFileSync('git', ['-C', context.gitRoot, ...args], {
    encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function baseTree(ref, context) {
  try {
    return git(context, ['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`]).trim();
  } catch {
    throw new Error(`cannot read Git base ${ref}; fetch the base branch or pass --base <ref>`);
  }
}

export function treeFiles(tree, prefix, context) {
  const args = ['ls-tree', '-r', '--name-only', '-z', tree, '--'];
  if (prefix) args.push(prefix);
  return new Set(git(context, args).split('\0').filter(Boolean));
}

export function readTreeJson(file, tree, context) {
  const source = `${file} at base ${tree}`;
  try {
    return JSON.parse(git(context, ['show', `${tree}:${file}`]));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : 'cannot read input';
    throw new Error(`${source}: ${reason}; supply a readable JSON file`);
  }
}

function relativeInside(root, file, label) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}: path must stay inside the candidate; pass a candidate-relative file`);
  }
  return { absolute, relative };
}

function regularCandidatePath(context, file) {
  const { absolute, relative } = relativeInside(context.candidate, file, file);
  const parts = relative.split(path.sep);
  let current = context.candidate;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return { absolute, relative };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${relative}: candidate input is a symlink; replace the symlink with a regular file`);
    }
  }
  return { absolute, relative };
}

export function readCandidateJson(file, context) {
  const { absolute, relative } = regularCandidatePath(context, file);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : 'cannot read input';
    throw new Error(`${relative}: ${reason}; supply a readable JSON file`);
  }
}

function readTrustedJson(file) {
  const absolute = path.join(trustedRoot, file);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : 'cannot read input';
    throw new Error(`${file}: ${reason}; restore the trusted checker input`);
  }
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

function unsupportedSchema(label, property, keyword) {
  throw new Error(`${label}: keyword ${keyword} on property ${property} is not supported; the checker does not implement it`);
}

function validatePropertySchema(rule, label, property) {
  if (!object(rule)) throw new Error(`${label}: property ${property} must be a schema object; fix the recipe schema`);
  for (const keyword of Object.keys(rule)) {
    if (annotationKeys.has(keyword) || keyword.startsWith('x-caelos-')) continue;
    if (!propertySchemaKeys.has(keyword)) unsupportedSchema(label, property, keyword);
  }
  if (!['string', 'object', 'array'].includes(rule.type) || typeof rule.type !== 'string') {
    unsupportedSchema(label, property, 'type');
  }
  if (rule.format !== undefined && rule.format !== 'date-time') unsupportedSchema(label, property, 'format');
  if (rule.items !== undefined) validatePropertySchema(rule.items, label, `${property}.items`);
}

export function validateSchema(schema, label) {
  if (!object(schema)) throw new Error(`${label}: expected a schema object; fix the recipe schema`);
  for (const keyword of Object.keys(schema)) {
    if (!topSchemaKeys.has(keyword)) unsupportedSchema(label, '<schema>', keyword);
  }
  if (schema.type !== 'object') unsupportedSchema(label, '<schema>', 'type');
  if (!object(schema.properties) || !stringList(schema.required) ||
      schema.required.some((name) => !Object.hasOwn(schema.properties, name))) {
    throw new Error(`${label}: expected record properties and required field names; fix the recipe schema`);
  }
  for (const [property, rule] of Object.entries(schema.properties)) validatePropertySchema(rule, label, property);
  return schema;
}

function validatePaintFamilies(data, label) {
  if (!object(data) || !Object.keys(data).length || Object.values(data).some((family) =>
    !object(family) || !stringList(family.tokenTypes) || !stringList(family.pathFamilies))) {
    throw new Error(`${label}: expected tokenTypes and pathFamilies arrays for each paint family; fix the paint definitions`);
  }
  return data;
}

function paintFamilySets(data) {
  return {
    types: new Set(Object.values(data).flatMap((family) => family.tokenTypes)),
    paths: new Set(Object.values(data).flatMap((family) => family.pathFamilies)),
  };
}

export function validateCandidateRuleData(context, tree) {
  const candidateSchema = validateSchema(readCandidateJson(schemaFile, context), schemaFile);
  const candidatePaint = validatePaintFamilies(readCandidateJson(paintFile, context), paintFile);
  if (!tree) return;
  const baseFiles = treeFiles(tree, directory, context);
  if (baseFiles.has(schemaFile)) {
    const previous = readTreeJson(schemaFile, tree, context);
    if (stringList(previous.required)) {
      for (const name of previous.required) {
        if (!candidateSchema.required.includes(name)) {
          throw new Error(`${schemaFile}: required name ${name} was removed; restore it to the required list`);
        }
      }
    }
  }
  if (baseFiles.has(paintFile)) {
    const previous = validatePaintFamilies(readTreeJson(paintFile, tree, context), `${paintFile} at base ${tree}`);
    for (const [name, family] of Object.entries(previous)) {
      if (!Object.hasOwn(candidatePaint, name)) {
        throw new Error(`${paintFile}: paint family ${name} was removed; restore the family`);
      }
      for (const tokenType of family.tokenTypes) {
        if (!candidatePaint[name].tokenTypes.includes(tokenType)) {
          throw new Error(`${paintFile}: tokenType ${tokenType} was removed from ${name}; restore it`);
        }
      }
      for (const pathFamily of family.pathFamilies) {
        if (!candidatePaint[name].pathFamilies.includes(pathFamily)) {
          throw new Error(`${paintFile}: pathFamily ${pathFamily} was removed from ${name}; restore it`);
        }
      }
    }
  }
}

export function guardBaseNone({ base, candidate, gitRoot }) {
  if (base !== 'none') return;
  let hasCommit = true;
  try {
    hasCommit = Boolean(git({ gitRoot }, ['rev-list', '-n', '1', '--all']).trim());
  } catch {
    hasCommit = true;
  }
  if (process.env.CI || !process.env.CAELOS_CATALOG_GIT_ROOT || hasCommit ||
      path.resolve(candidate) !== path.resolve(process.cwd())) {
    throw new Error("--base none is only for a repository's first commit; pass --base <ref>");
  }
}

function readCatalog(context, tree) {
  let files;
  if (tree) {
    files = [...treeFiles(tree, directory, context)].map((file) => file.slice(directory.length + 1));
  } else {
    const catalogPath = regularCandidatePath(context, directory).absolute;
    try {
      files = readdirSync(catalogPath);
    } catch {
      throw new Error(`${directory}: missing tier files; restore the catalog inputs`);
    }
  }
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
    const relative = `${directory}/${file}`;
    visit(tree ? readTreeJson(relative, tree, context) : readCandidateJson(relative, context), [], Number(file.slice(0, 2)), file);
  }
  return catalog;
}

function paintIndex(catalog, families) {
  const byName = new Map();
  for (const token of catalog.tokens) {
    if (!byName.has(token.name)) byName.set(token.name, []);
    byName.get(token.name).push(token);
  }
  const memo = new Map();
  function isPaint(token, visiting = new Set()) {
    if (memo.has(token)) return memo.get(token);
    if (visiting.has(token)) return false;
    const next = new Set(visiting).add(token);
    const segments = token.tier === 0 ? token.segments.slice(1) : token.segments.slice(3);
    const words = segments.flatMap((segment) => segment.toLowerCase().split(/[-_]+/).filter(Boolean));
    let result = families.types.has(token.node.$type) || words.some((word) => families.paths.has(word));
    if (!result) {
      const target = typeof token.node.$value === 'string' && /^\{([^{}]+)\}$/.exec(token.node.$value)?.[1];
      result = (byName.get(target) ?? []).some((candidate) => isPaint(candidate, next));
    }
    memo.set(token, result);
    return result;
  }
  return { byName, isPaint };
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

function pairedEntries(file, catalog, context) {
  if (!file) return new Set();
  const data = readCandidateJson(file, context);
  const names = Array.isArray(data) ? data : object(data) ? Object.values(data) : null;
  if (!stringList(names)) throw new Error(`${file}: expected entry names or a need-to-entry map; fix the match file`);
  const paired = new Set(names.filter((name) => name !== 'none' && name !== 'none, new kind'));
  const known = new Set(catalog.entries.map((entry) => entry.name));
  for (const name of paired) {
    if (!known.has(name)) throw new Error(`${file} entry ${name}: unknown paired entry; select a catalog entry or record none`);
  }
  return paired;
}

function templateFields() {
  const root = path.join(trustedRoot, 'templates');
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const templates = new Map();
  const declaration = /export\s+const\s+requiredFields\s*=\s*(\[(?:\s|,|"(?:\\.|[^"\\])*")*\])\s*;/m;
  for (const entry of entries.filter((file) => file.isFile() && file.name.endsWith('.mjs'))) {
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(trustedRoot, file);
    const source = readFileSync(file, 'utf8');
    const match = declaration.exec(source);
    if (!match) {
      throw new Error(`${relative}: declare export const requiredFields = [<JSON array of strings>];`);
    }
    let requiredFields;
    try {
      requiredFields = JSON.parse(match[1]);
    } catch {
      throw new Error(`${relative}: declare export const requiredFields = [<JSON array of strings>];`);
    }
    const kind = path.basename(entry.name, '.mjs');
    if (!stringList(requiredFields) || requiredFields.some((field) => field.split('.').some((segment) => !segment)) ||
        templates.has(kind)) {
      throw new Error(`${relative}: expected one template per kind exporting requiredFields; declare the recipe field paths in the template`);
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
  if (rule.minLength !== undefined && value.trim().length < rule.minLength) return 'supply a non-empty string';
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) return 'supply a structured identifier';
  if (rule.format === 'date-time') {
    const match = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.exec(value);
    const parsed = match && new Date(value);
    if (!match || Number.isNaN(parsed.getTime())) return 'supply a date and time with a timezone';
    if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() + 1 !== Number(match[2]) ||
        parsed.getUTCDate() !== Number(match[3])) return 'supply a real calendar date';
  }
  if (rule.minProperties !== undefined && Object.keys(value).length < rule.minProperties) {
    return 'describe the accepted contents as structured data';
  }
  if (rule.minItems !== undefined && value.length < rule.minItems) return 'list at least one lower-tier entry';
  if (rule.uniqueItems && value.some((item, index) => value.slice(0, index).some((prior) => isDeepStrictEqual(prior, item)))) {
    return 'remove duplicate items';
  }
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

function hasProseSource(value, holder) {
  if (typeof value === 'string') {
    return !/^(?:label|text|title|placeholder)$/i.test(holder ?? '') && /\s/.test(value.trim());
  }
  if (Array.isArray(value)) return value.some((item) => hasProseSource(item));
  if (object(value)) {
    return Object.entries(value).some(([key, child]) => proseField(key) || hasProseSource(child, key));
  }
  return false;
}

async function checkRecipes(values) {
  const context = createContext(values);
  guardBaseNone(values);
  const hasBase = values.base !== 'none';
  const tree = hasBase ? baseTree(values.base, context) : undefined;
  validateCandidateRuleData(context, tree);
  const schema = validateSchema(readTrustedJson(schemaFile), schemaFile);
  const families = paintFamilySets(validatePaintFamilies(readTrustedJson(paintFile), paintFile));
  const ignored = Object.keys(schema.properties).filter((key) => schema.properties[key]['x-caelos-ignore-for-change']);
  const current = readCatalog(context);
  const previous = tree ? readCatalog(context, tree) : { files: [], entries: [], tokens: [] };
  if (!hasBase) console.log('no base given: changed-entry rule skipped');
  for (const file of previous.files) {
    if (!current.files.includes(file)) throw new Error(`${directory}/${file}: missing tier input; restore the catalog file`);
  }
  const entriesAtBase = new Map(previous.entries.map((entry) => [`${entry.file}:${entry.name}`, entry.node]));
  const tierByName = new Map();
  for (const entry of current.entries.filter((record) => record.group || record.tier === 0)) {
    tierByName.set(entry.name, Math.min(tierByName.get(entry.name) ?? Infinity, entry.tier));
  }
  const matches = pairedEntries(values.paired, current, context);
  const templates = templateFields();
  const exceptions = exceptionNames(readCandidateJson(exceptionsFile, context), exceptionsFile);
  const paint = paintIndex(current, families);
  const previousTokens = new Map(previous.tokens.map((token) => [token.name, token]));
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
    const active = matches.has(name) || (hasBase && (!old || !isDeepStrictEqual(materialRecord(old, ignored), materialRecord(node, ignored))));
    const required = new Set(schema.required);
    for (const [key, rule] of Object.entries(schema.properties)) {
      const recipeTier = rule['x-caelos-recipe-tier'];
      if (active && group && (rule['x-caelos-required-on-active-recipe'] || tier >= rule['x-caelos-required-from-tier'])) {
        required.add(key);
      }
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
        if (typeof dependency !== 'string') continue;
        if (!(tierByName.get(dependency) < tier)) {
          say(`madeOf names ${dependency}, which is not a lower-tier entry; choose an existing entry below tier ${tier}`);
          continue;
        }
        if (tier >= 3 && tierByName.get(dependency) === 0 &&
            (paint.byName.get(dependency) ?? []).some((token) => paint.isPaint(token))) {
          const allowance = current.tokens.some((token) => token.recipe === name && exceptions.has(token.name) &&
            token.node.$value === `{${dependency}}`);
          if (!allowance) {
            say(`madeOf names ${dependency}, which is paint; list a tier 1 or 2 entry instead`);
          }
        }
      }
    }
    for (const field of templates.get(record.kind) ?? []) {
      const value = fieldValue(node, record, field);
      if (value === undefined || value === null || value === '') {
        if (active) say(`template requires ${field}; supply the structured recipe field`);
      } else if (field.split('.').some(proseField) || hasProseSource(value, field.split('.').at(-1))) {
        say(`template field ${field} uses prose as a source; supply structured identifiers, values, or references`);
      }
    }
  }

  for (const name of exceptions) {
    const candidates = paint.byName.get(name) ?? [];
    const token = candidates.find((candidate) => candidate.tier >= 3 && paint.isPaint(candidate));
    if (!token) {
      errors.push(`stale exception ${name}; remove it from ${exceptionsFile}`);
      continue;
    }
    const old = previousTokens.get(name);
    if (old && (!isDeepStrictEqual(old.node.$value, token.node.$value) || old.node.$type !== token.node.$type)) {
      errors.push(`tier ${token.tier} entry ${token.recipe}: ${name} changed; an excepted token may not change its paint; move it to tier 1 or 2`);
    }
  }
  for (const token of current.tokens.filter((candidate) => candidate.tier > 2 && paint.isPaint(candidate))) {
    if (exceptions.has(token.name)) continue;
    errors.push(`tier ${token.tier} entry ${token.recipe} declares paint token ${token.name}; paint enters only at tiers 0 to 2; move it into a tier 1 or 2 entry and list that entry in madeOf`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Recipe schema and paint line passed.');
}

function run(command, args, cwd = trustedRoot) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`${command} stopped by ${result.signal}`);
  return result.status;
}

function tierDrift(script, candidate, context) {
  const trustedScript = path.resolve(trustedRoot, script);
  if (candidate) return run(process.execPath, [trustedScript, path.resolve(candidate)]);
  if (process.env.CAELOS_CATALOG_GIT_ROOT) return run(process.execPath, [trustedScript, process.cwd()]);
  const snapshot = mkdtempSync(path.join(tmpdir(), 'caelos-catalog-check-'));
  try {
    const root = realpathSync(trustedRoot);
    const tracked = new Set(git(context, ['ls-files', '--cached', '-z']).split('\0').filter(Boolean));
    const files = new Set(git(context, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
    for (const file of files) {
      let stat;
      try {
        const absolute = path.resolve(root, file);
        const parent = path.dirname(absolute);
        if (realpathSync(parent) !== parent) {
          if (tracked.has(file)) throw new Error(`${file}: tracked path uses a symlinked directory; replace it with a regular directory`);
          continue;
        }
        stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          if (!tracked.has(file)) continue;
          if (statSync(absolute).isDirectory()) {
            throw new Error(`${file}: tracked symlinked directory is unsupported; replace it with a regular directory`);
          }
        }
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isDirectory()) throw new Error(`${file}: expected a tracked file; cannot snapshot a directory entry`);
      const dest = path.join(snapshot, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(path.join(root, file), dest, { verbatimSymlinks: true });
    }
    return run(process.execPath, [trustedScript, snapshot]);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function checkCatalog(args) {
  const separator = args.indexOf('--');
  const drift = args[0];
  const checks = separator < 0 ? [] : args.slice(1, separator);
  if (!drift || !checks.length || separator < 0) throw new Error('check:catalog: missing configured checks');
  const values = options(args.slice(separator + 1), ['--base', '--candidate', '--paired', '--baseline', '--git-root']);
  const context = createContext(values);
  const candidate = values.provided.has('--candidate') ? values.candidate : undefined;
  let status = tierDrift(drift, candidate, context);
  if (status) return status;
  for (const check of checks) {
    const checkArgs = ['--base', values.base];
    if (candidate) checkArgs.push('--candidate', values.candidate);
    if (values.provided.has('--git-root')) checkArgs.push('--git-root', values.gitRoot);
    if (check === 'check:recipes' && values.paired) checkArgs.push('--paired', values.paired);
    if (check === 'check:ratchet' && values.baseline) checkArgs.push('--baseline', values.baseline);
    status = run('npm', ['run', check, '--', ...checkArgs]);
    if (status) return status;
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--catalog') process.exitCode = checkCatalog(args.slice(1));
    else await checkRecipes(options(args, ['--base', '--candidate', '--paired', '--git-root']));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
