#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { recomputeCrossJobEvidence } from './lib/evidence.mjs';
import { executeStep, runJob } from './lib/run.mjs';

function usage() {
  return 'usage: engine run --job <folder> | engine step <name> --job <folder> | engine evidence (--job <folder> ... | --jobs-root <folder>) --evidence <folder>';
}

function jobFolder(args) {
  if (args.length !== 2 || args[0] !== '--job' || !args[1]) {
    const error = new Error(usage());
    error.exitCode = 2;
    throw error;
  }
  return args[1];
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
  const jobFolders = jobsRoot
    ? readdirSync(jobsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(jobsRoot, entry.name, 'job.json')))
      .map((entry) => path.join(jobsRoot, entry.name)).sort()
    : jobs;
  if (!jobFolders.length || !evidenceFolder) throw Object.assign(new Error(usage()), { exitCode: 2 });
  return { jobFolders, evidenceFolder };
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'run') {
    console.log(JSON.stringify(runJob(jobFolder(args))));
  } else if (command === 'step') {
    const [name, ...rest] = args;
    if (!name) {
      const error = new Error(usage());
      error.exitCode = 2;
      throw error;
    }
    console.log(JSON.stringify(executeStep(name, jobFolder(rest))));
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
