import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  baseTree, createContext, exceptionNames, exceptionsFile, guardBaseNone, object, options,
  readCandidateJson, readTreeJson, validateCandidateRuleData,
} from './check-recipes.mjs';

function baselineCounts(data, label) {
  if (!object(data)) throw new Error(`${label}: expected counts by file and rule; fix the baseline format`);
  for (const [file, counts] of Object.entries(data)) {
    if (!file.trim() || !object(counts)) throw new Error(`${label}: expected rule counts for ${file}; fix the baseline entry`);
    for (const [rule, count] of Object.entries(counts)) {
      if (!rule.trim() || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`${label}: invalid count for ${file} (${rule}); use a nonnegative integer`);
      }
    }
  }
  return data;
}

function candidateRelative(file, context) {
  const absolute = path.resolve(context.candidate, file);
  const relative = path.relative(context.candidate, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${file}: baseline must be inside the candidate; pass the path to the tracked baseline`);
  }
  return relative.split(path.sep).join('/');
}

function compareCounts(current, previous, relative, errors) {
  for (const [fileName, counts] of Object.entries(current)) {
    if (!Object.hasOwn(previous, fileName)) {
      errors.push(`${relative}: file ${fileName} was added; remove the added baseline entry and fix new gate errors`);
      continue;
    }
    for (const [rule, count] of Object.entries(counts)) {
      if (!Object.hasOwn(previous[fileName], rule)) {
        errors.push(`${relative}: rule ${rule} was added for ${fileName}; remove the added rule and fix new gate errors`);
      } else if (count > previous[fileName][rule]) {
        errors.push(`${relative}: ${fileName} (${rule}) count rose from ${previous[fileName][rule]} to ${count}; fix the new gate errors and restore or lower the count`);
      }
    }
  }
}

function checkBaseline(file, tree, errors, context, actual) {
  const relative = candidateRelative(file, context);
  if (actual) {
    const actualRelative = actual === '-' ? '<stdin>' : candidateRelative(actual, context);
    let actualData;
    try {
      actualData = actual === '-' ? JSON.parse(readFileSync(0, 'utf8')) : readCandidateJson(actualRelative, context);
    } catch (error) {
      if (actual !== '-' || error.message.includes('supply a readable JSON file')) throw error;
      throw new Error('<stdin>: invalid JSON; supply per-file rule counts');
    }
    const current = baselineCounts(actualData, actualRelative);
    const previous = baselineCounts(readCandidateJson(relative, context), relative);
    compareCounts(current, previous, relative, errors);
    return;
  }
  const current = baselineCounts(readCandidateJson(relative, context), relative);
  if (!tree) return;
  const previous = baselineCounts(readTreeJson(relative, tree, context), `${relative} at base ${tree}`);
  compareCounts(current, previous, relative, errors);
}

try {
  const values = options(process.argv.slice(2), ['--actual', '--base', '--baseline', '--candidate', '--git-root', '--mode']);
  const mode = values.mode ?? 'full';
  if (!['full', 'baseline'].includes(mode)) throw new Error('--mode must be full or baseline');
  if (mode === 'baseline' && !values.baseline) throw new Error('--mode baseline requires --baseline <file>');
  if (values.actual && mode !== 'baseline') throw new Error('--actual requires --mode baseline');
  if (!values.actual) guardBaseNone(values);
  const context = createContext(values);
  const tree = values.actual ? undefined : values.base === 'none' ? undefined : baseTree(values.base, context);
  const errors = [];
  if (!tree && !values.actual) console.log('no base given: ratchet comparison skipped');

  if (mode === 'full') {
    validateCandidateRuleData(context, tree);
    const current = exceptionNames(readCandidateJson(exceptionsFile, context), exceptionsFile);
    if (tree) {
      const previous = exceptionNames(readTreeJson(exceptionsFile, tree, context), `${exceptionsFile} at base ${tree}`);
      for (const name of current) {
        if (!previous.has(name)) {
          errors.push(`${exceptionsFile}: ${name} was added; remove the exception and move its paint to tier 1 or 2`);
        }
      }
    }
  }
  if (values.baseline) checkBaseline(values.baseline, tree, errors, context, values.actual);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Shrink-only catalog ratchet passed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
