#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const jobIndex = process.argv.indexOf('--job');
const jobFolder = jobIndex >= 0 ? process.argv[jobIndex + 1] : null;
if (!jobFolder) throw new Error('missing --job');
writeFileSync(path.join(jobFolder, 'finish.json'), '{"status":"waiting"}\n');
process.exitCode = 75;
