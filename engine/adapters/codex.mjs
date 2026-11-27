import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  assertOnlyDeclaredChanges, outputDestination, requireRegularOutput, safePath, validateJsonOutput,
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

export function assertCodexAvailable({ command = 'codex', env = process.env } = {}) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer,
  });
  if (result.status !== 0) throw new Error(processFailure(result, 'Codex harness'));
  return String(result.stdout || result.stderr || '').trim();
}

function promptFor(step, checkout, jobFolder) {
  const instructions = path.join(checkout, step.instructions);
  const inputs = step.inputs.map((file) => path.join(jobFolder, file));
  return [
    `Follow the instructions in ${instructions}.`,
    `Read these inputs: ${inputs.join(', ')}.`,
    `Write only these outputs in the checkout: ${step.outputs.join(', ')}.`,
  ].join('\n');
}

export function runCodexStep({
  gitRoot, baseCommit, jobFolder, step, command = 'codex', env = process.env,
}) {
  assertCodexAvailable({ command, env });
  for (const input of step.inputs) {
    if (!existsSync(path.join(jobFolder, input))) throw new Error(`model step ${step.step} is missing input ${input}`);
  }

  return withDetachedCheckout({ gitRoot, baseCommit }, ({ checkout, baseCommit: resolvedBase, container }) => {
    const instructions = safePath(checkout, step.instructions, 'model instructions');
    const schema = safePath(checkout, step.schema, 'model output schema');
    if (!existsSync(instructions)) throw new Error(`model step ${step.step} instructions ${step.instructions} do not exist at ${resolvedBase}`);
    if (!existsSync(schema)) throw new Error(`model step ${step.step} schema ${step.schema} does not exist at ${resolvedBase}`);
    for (const output of step.outputs) safePath(checkout, output, 'declared output');

    const built = buildCodexCommand({
      command,
      checkout,
      lastMessageFile: path.join(container, 'last-message.txt'),
      prompt: promptFor(step, checkout, jobFolder),
    });
    const result = spawnSync(built.command, built.args, {
      cwd: checkout,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer,
    });
    if (result.status !== 0) throw new Error(processFailure(result, `model step ${step.step}`));

    assertOnlyDeclaredChanges({ checkout, baseCommit: resolvedBase, outputs: step.outputs });
    const outputFiles = step.outputs.map((output) => requireRegularOutput(checkout, output));
    validateJsonOutput(outputFiles[0], schema);
    for (let index = 0; index < outputFiles.length; index += 1) {
      const destination = outputDestination(jobFolder, step.outputs[index]);
      copyFileSync(outputFiles[index], destination);
    }
    return { outputs: [...step.outputs] };
  });
}
