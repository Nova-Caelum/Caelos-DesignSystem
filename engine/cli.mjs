#!/usr/bin/env node

import { executeStep, runJob } from './lib/run.mjs';

function usage() {
  return 'usage: engine run --job <folder> | engine step <name> --job <folder>';
}

function jobFolder(args) {
  if (args.length !== 2 || args[0] !== '--job' || !args[1]) {
    const error = new Error(usage());
    error.exitCode = 2;
    throw error;
  }
  return args[1];
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
  } else {
    const error = new Error(usage());
    error.exitCode = 2;
    throw error;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
