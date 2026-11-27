import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const engineRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repositoryRoot = path.dirname(engineRoot);
export const chainsRoot = path.join(engineRoot, 'chains');

const chainNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file, label = file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist; create it and try again`);
    throw new Error(`${label} cannot be read; fix its permissions and try again`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON; fix the file and try again`);
  }
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim());
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path; fix the chain`);
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay inside its root; fix the chain`);
  }
}

export function validateChain(chain, label = 'chain') {
  if (!object(chain)) throw new Error(`${label} must be an object; fix the chain`);
  if (typeof chain.chain !== 'string' || !chainNamePattern.test(chain.chain)) {
    throw new Error(`${label} has an invalid chain name; use letters, numbers, dashes, or underscores`);
  }
  if (!Array.isArray(chain.steps) || chain.steps.length === 0) {
    throw new Error(`${label} must contain at least one step; fix the chain`);
  }
  if (chain.commit !== undefined && (typeof chain.commit !== 'string' || !/^[0-9a-f]{40}$/.test(chain.commit))) {
    throw new Error(`${label} has an invalid commit; restore the recorded chain snapshot`);
  }

  const names = new Set();
  for (const [index, row] of chain.steps.entries()) {
    const rowLabel = `${label} step ${index + 1}`;
    if (!object(row)) throw new Error(`${rowLabel} must be an object; fix the chain`);
    if (typeof row.step !== 'string' || !chainNamePattern.test(row.step)) {
      throw new Error(`${rowLabel} has an invalid step name; fix the chain`);
    }
    if (names.has(row.step)) throw new Error(`${label}: duplicate step name ${row.step}; give every step a unique name`);
    names.add(row.step);
    if (row.kind !== 'script') {
      throw new Error(`${rowLabel} kind must be script; model steps are not supported by this runner yet`);
    }
    safeRelative(row.script, `${rowLabel} script`);
    if (!row.script.endsWith('.mjs')) throw new Error(`${rowLabel} script must name an .mjs file; fix the chain`);
    if (!nonEmptyStrings(row.inputs)) throw new Error(`${rowLabel} inputs must be a string list; fix the chain`);
    if (!nonEmptyStrings(row.outputs) || row.outputs.length === 0) {
      throw new Error(`${rowLabel} outputs must be a non-empty string list; fix the chain`);
    }
    if (new Set(row.inputs).size !== row.inputs.length || new Set(row.outputs).size !== row.outputs.length) {
      throw new Error(`${rowLabel} repeats an input or output; remove the duplicate`);
    }
    for (const input of row.inputs) safeRelative(input, `${rowLabel} input`);
    for (const output of row.outputs) safeRelative(output, `${rowLabel} output`);
    if (row.check !== 'npm run check:catalog') {
      throw new Error(`${rowLabel} check must be npm run check:catalog; restore the repository check`);
    }
  }
  return chain;
}

export function readJob(folder) {
  const file = path.join(folder, 'job.json');
  const job = readJson(file, 'job.json');
  if (!object(job) || typeof job.chain !== 'string' || !chainNamePattern.test(job.chain)) {
    throw new Error('job.json must name a chain; add a valid "chain" and try again');
  }
  return job;
}

function sourceChainPath(name) {
  return path.join(chainsRoot, `${name}.chain.json`);
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error('cannot read the repository commit; run the engine from a Git checkout');
  }
}

export function materializeChain(folder, chainName) {
  const snapshotFile = path.join(folder, 'chain.json');
  if (existsSync(snapshotFile)) {
    const snapshot = validateChain(readJson(snapshotFile, 'chain.json'), 'chain.json');
    if (snapshot.chain !== chainName) {
      throw new Error(`chain.json records ${snapshot.chain}, but job.json names ${chainName}; restore the original job`);
    }
    if (!snapshot.commit) throw new Error('chain.json has no commit; restore the recorded chain snapshot');
    return snapshot;
  }

  const sourceFile = sourceChainPath(chainName);
  if (!existsSync(sourceFile)) {
    throw new Error(`chain ${chainName} does not exist; add engine/chains/${chainName}.chain.json or fix job.json`);
  }
  const source = validateChain(readJson(sourceFile, `chain ${chainName}`), `chain ${chainName}`);
  if (source.chain !== chainName) {
    throw new Error(`chain ${chainName} declares itself as ${source.chain}; make the names match`);
  }
  const snapshot = { chain: source.chain, commit: currentCommit(), steps: source.steps };
  const temporary = `${snapshotFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(temporary, snapshotFile);
  return snapshot;
}

export function readChainSnapshot(folder) {
  const snapshot = validateChain(readJson(path.join(folder, 'chain.json'), 'chain.json'), 'chain.json');
  if (!snapshot.commit) throw new Error('chain.json has no commit; run engine run before engine step');
  return snapshot;
}

export function resolveScript(script) {
  const absolute = path.resolve(repositoryRoot, script);
  const relative = path.relative(repositoryRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`script ${script} leaves the repository; fix the chain`);
  }
  return absolute;
}
