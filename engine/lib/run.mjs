import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeChain, readChainSnapshot, readJob, repositoryRoot, resolveScript,
} from './chain.mjs';
import { createEventWriter, finishedSteps, readEvents } from './events.mjs';
import { assertCodexAvailable, runCodexStep } from '../adapters/codex.mjs';
import { storeEngineOutputHashes } from './evidence.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

function processFailure(result, label) {
  if (result.error) return `${label} could not start: ${result.error.message}`;
  if (result.signal) return `${label} stopped by ${result.signal}`;
  const detail = String(result.stderr || result.stdout || '').trim();
  return `${label} exited ${result.status}${detail ? `: ${detail}` : ''}`;
}

function runProcess(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const error = new Error(processFailure(result, label));
    error.exitCode = result.status;
    throw error;
  }
  return result;
}

function jobFile(folder, name) {
  return path.join(folder, name);
}

export function executeStep(name, folder) {
  const jobFolder = path.resolve(folder);
  const chain = readChainSnapshot(jobFolder);
  const row = chain.steps.find(({ step }) => step === name);
  if (!row) throw new Error(`step ${name} is not in chain ${chain.chain}; choose a named step`);
  const previous = readEvents(jobFolder);
  if (finishedSteps(previous).has(name)) return { skipped: true };

  for (const input of row.inputs) {
    if (!existsSync(jobFile(jobFolder, input))) {
      throw new Error(`step ${name} is missing input ${input}; fix the job input and try again`);
    }
  }
  if (row.kind === 'model') {
    const reply = runCodexStep({
      gitRoot: repositoryRoot,
      baseCommit: chain.commit,
      jobFolder,
      step: row,
      command: process.env.CAELOS_CODEX_COMMAND || 'codex',
    });
    if (typeof reply.model !== 'string' || !reply.model) {
      throw new Error(`model step ${name} harness reply did not name the model`);
    }
    for (const output of row.outputs) {
      if (!existsSync(jobFile(jobFolder, output))) {
        throw new Error(`step ${name} did not write ${output}; fix the script and try again`);
      }
    }
    return { skipped: false, model: reply.model };
  } else {
    const script = resolveScript(row.script);
    if (!existsSync(script)) throw new Error(`step ${name} script ${row.script} does not exist; restore it and try again`);
    runProcess(process.execPath, [script, name, '--job', jobFolder], `step ${name}`);
  }
  for (const output of row.outputs) {
    if (!existsSync(jobFile(jobFolder, output))) {
      throw new Error(`step ${name} did not write ${output}; fix the script and try again`);
    }
  }
  return { skipped: false };
}

function parseStepResult(output, step) {
  try {
    return JSON.parse(String(output || '').trim());
  } catch {
    throw new Error(`step ${step} did not return its machine-readable result`);
  }
}

function defaultStepRunner({ jobFolder, row }) {
  const processResult = runProcess(
    process.execPath, [cli, 'step', row.step, '--job', jobFolder], `step ${row.step}`,
  );
  return parseStepResult(processResult.stdout, row.step);
}

function defaultCatalogCheck() {
  runProcess('npm', ['run', 'check:catalog'], 'npm run check:catalog');
}

function resumeIndex(chain, events) {
  const exits = events.filter(({ kind }) => kind === 'node.exit');
  if (!exits.length) return 0;
  const last = exits.at(-1).node;
  const index = chain.steps.findIndex(({ step }) => step === last);
  if (index < 0) throw new Error(`events.jsonl names finished step ${last}, which is not in chain.json; restore matching files`);
  return index + 1;
}

function failMessage(step, reason, folder) {
  return `step ${step} failed: ${reason}\nFix the step, its declared files, or the catalog check, then run engine run --job ${folder} again.`;
}

export function runJob(folder, options = {}) {
  const stepRunner = options.stepRunner || defaultStepRunner;
  const catalogCheck = options.catalogCheck || defaultCatalogCheck;
  const harnessCheck = options.harnessCheck || assertCodexAvailable;
  const jobFolder = path.resolve(folder);
  const job = readJob(jobFolder);
  const chain = materializeChain(jobFolder, job.chain);
  const previous = readEvents(jobFolder);
  const start = resumeIndex(chain, previous);
  if (start >= chain.steps.length) return { complete: true, resumed: true };

  if (chain.steps.slice(start).some(({ kind }) => kind === 'model')) {
    harnessCheck({ command: process.env.CAELOS_CODEX_COMMAND || 'codex' });
  }

  const events = createEventWriter(jobFolder, previous);
  events.emit(previous.length ? 'run.resume' : 'run.start', null);

  for (const row of chain.steps.slice(start)) {
    if (row.step === 'finish' && job.finish) storeEngineOutputHashes(jobFolder, job.finish);
    events.emit('node.enter', row.step);
    try {
      const stepResult = stepRunner({ jobFolder, row });
      catalogCheck({ jobFolder, row });
      events.emit('node.exit', row.step, stepResult.model ? { model: stepResult.model } : {});
    } catch (error) {
      if (error.exitCode === 75) {
        events.emit('run.pause', null, { step: row.step, status: 'waiting' });
        return { complete: false, resumed: previous.length > 0 };
      }
      const message = failMessage(row.step, error.message, jobFolder);
      events.emit('node.fail', row.step, { error: message });
      events.emit('run.end', null, { status: 'failed' });
      throw new Error(message);
    }
  }
  events.emit('run.end', null, { status: 'ok' });
  return { complete: true, resumed: previous.length > 0 };
}
