import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  assertNoUnexpectedJobFiles, assertOnlyDeclaredChanges, outputDestination, parseJsonSchema,
  readBaseFile, requireRegularOutput, safePath, snapshotFileList, validateJsonOutput,
  withDetachedCheckout,
} from '../lib/clean-run.mjs';

const maxBuffer = 64 * 1024 * 1024;

export function buildCodexCommand({ command = 'codex', checkout, lastMessageFile, prompt }) {
  return {
    command,
    args: [
      'exec',
      '--sandbox', 'workspace-write',
      '--ephemeral',
      '--json',
      '--output-last-message', lastMessageFile,
      '--cd', checkout,
      prompt,
    ],
  };
}

function processFailure(result, label) {
  if (result.error?.code === 'ENOENT') return `${label} command ${result.error.path} was not found`;
  if (result.error) return `${label} could not start: ${result.error.message}`;
  if (result.signal) return `${label} stopped by ${result.signal}`;
  const detail = String(result.stderr || result.stdout || '').trim();
  return `${label} exited ${result.status}${detail ? `: ${detail}` : ''}`;
}

function spawnEnvironment(options) {
  const explicit = Object.hasOwn(options, 'env');
  const env = { ...(explicit ? options.env : process.env) };
  if (!explicit) delete env.CODEX_HOME;
  return env;
}

export function assertCodexAvailable(options = {}) {
  const command = options.command || 'codex';
  const env = spawnEnvironment(options);
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer,
  });
  if (result.status !== 0) throw new Error(processFailure(result, 'Codex harness'));
  return String(result.stdout || result.stderr || '').trim();
}

function promptFor(step, instructions, checkout, jobFolder) {
  const inputs = step.inputs.map((file) => path.join(jobFolder, file));
  return [
    'Follow these instructions exactly:',
    instructions,
    `Read these inputs: ${inputs.join(', ')}.`,
    `Write only these outputs in the checkout: ${step.outputs.join(', ')}.`,
  ].join('\n');
}

function findModel(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.model === 'string' && value.model.trim()) return value.model.trim();
  for (const child of Object.values(value)) {
    const model = findModel(child);
    if (model) return model;
  }
  return null;
}

export function parseHarnessModel(output) {
  let model = null;
  for (const line of String(output || '').split('\n').filter(Boolean)) {
    try {
      model ||= findModel(JSON.parse(line));
    } catch {
      // The harness JSON stream may be surrounded by non-JSON diagnostics.
    }
  }
  return model;
}

export function runCodexStep(options) {
  const {
    gitRoot, baseCommit, jobFolder, step, command = 'codex',
  } = options;
  const env = spawnEnvironment(options);
  const jobFilesBefore = snapshotFileList(jobFolder);
  assertCodexAvailable({ command, env });
  for (const input of step.inputs) {
    if (!existsSync(path.join(jobFolder, input))) throw new Error(`model step ${step.step} is missing input ${input}`);
  }

  return withDetachedCheckout({ gitRoot, baseCommit }, ({
    checkout, baseCommit: resolvedBase, container, gitDir, checkoutGitDir,
  }) => {
    const instructionsPath = safePath(checkout, step.instructions, 'model instructions');
    const schemaPath = safePath(checkout, step.schema, 'model output schema');
    if (!existsSync(instructionsPath)) throw new Error(`model step ${step.step} instructions ${step.instructions} do not exist at ${resolvedBase}`);
    if (!existsSync(schemaPath)) throw new Error(`model step ${step.step} schema ${step.schema} does not exist at ${resolvedBase}`);
    for (const output of step.outputs) safePath(checkout, output, 'declared output');
    const instructions = readBaseFile({
      gitRoot, baseCommit: resolvedBase, file: step.instructions, label: 'model instructions',
    });
    const schemaText = readBaseFile({
      gitRoot, baseCommit: resolvedBase, file: step.schema, label: 'model output schema',
    });
    const schema = parseJsonSchema(schemaText, path.basename(step.schema));
    const built = buildCodexCommand({
      command,
      checkout,
      lastMessageFile: path.join(container, 'last-message.txt'),
      prompt: promptFor(step, instructions, checkout, jobFolder),
    });
    const result = spawnSync(built.command, built.args, {
      cwd: checkout,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer,
    });
    if (result.status !== 0) throw new Error(processFailure(result, `model step ${step.step}`));

    assertNoUnexpectedJobFiles({
      before: jobFilesBefore,
      after: snapshotFileList(jobFolder),
      outputs: step.outputs,
    });
    const outputFiles = step.outputs.map((output) => requireRegularOutput(checkout, output));
    for (const outputFile of outputFiles) validateJsonOutput(outputFile, schema, path.basename(step.schema));
    assertOnlyDeclaredChanges({
      checkout,
      gitDir,
      checkoutGitDir,
      baseCommit: resolvedBase,
      outputs: step.outputs,
      guardIndex: path.join(container, 'guard-index'),
    });
    for (let index = 0; index < outputFiles.length; index += 1) {
      const destination = outputDestination(jobFolder, step.outputs[index]);
      copyFileSync(outputFiles[index], destination);
    }
    return { outputs: [...step.outputs], model: parseHarnessModel(result.stdout) };
  });
}
