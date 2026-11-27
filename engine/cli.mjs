#!/usr/bin/env node

import path from 'node:path';

import { jobFoldersUnder, recomputeCrossJobEvidence } from './lib/evidence.mjs';
import { executeStep, runJob } from './lib/run.mjs';

function usage() {
  return 'usage: engine run --job <folder> [--model <id>] | engine step <name> --job <folder> [--model <id>] | engine evidence (--job <folder> ... | --jobs-root <folder>) --evidence <folder>';
}

function runSettings(args) {
  let folder = null;
  let model;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== '--job' && flag !== '--model')) {
      const error = new Error(usage());
      error.exitCode = 2;
      throw error;
    }
    if (flag === '--job' && folder === null) folder = value;
    else if (flag === '--model' && model === undefined) model = value;
    else {
      const error = new Error(usage());
      error.exitCode = 2;
      throw error;
    }
  }
  if (!folder) {
    const error = new Error(usage());
    error.exitCode = 2;
    throw error;
  }
  return { folder, model };
}

function evidenceFolders(args) {
  const jobs = [];
  let jobsRoot = null;
  let evidenceFolder = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw Object.assign(new Error(usage()), { exitCode: 2 });
    if (flag === '--job') jobs.push(path.resolve(value));
    else if (flag === '--jobs-root') jobsRoot = path.resolve(value);
    else if (flag === '--evidence') evidenceFolder = path.resolve(value);
    else throw Object.assign(new Error(usage()), { exitCode: 2 });
  }
  if (jobsRoot && jobs.length) throw Object.assign(new Error(usage()), { exitCode: 2 });
  const jobFolders = jobsRoot ? jobFoldersUnder(jobsRoot) : jobs;
  if (!jobFolders.length || !evidenceFolder) throw Object.assign(new Error(usage()), { exitCode: 2 });
  return { jobFolders, evidenceFolder };
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'run') {
    const { folder, model } = runSettings(args);
    console.log(JSON.stringify(runJob(folder, { model })));
  } else if (command === 'step') {
    const [name, ...rest] = args;
    if (!name) {
      const error = new Error(usage());
      error.exitCode = 2;
      throw error;
    }
    const { folder, model } = runSettings(rest);
    console.log(JSON.stringify(executeStep(name, folder, { model })));
  } else if (command === 'evidence') {
    console.log(JSON.stringify(await recomputeCrossJobEvidence(evidenceFolders(args))));
  } else {
    const error = new Error(usage());
    error.exitCode = 2;
    throw error;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
