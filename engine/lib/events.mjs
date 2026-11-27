import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const eventKinds = new Set([
  'run.start', 'run.pause', 'run.resume', 'run.stop', 'run.end',
  'node.enter', 'node.exit', 'node.fail',
]);

function validateEvent(event, line, expectedSequence) {
  const fail = (reason) => {
    throw new Error(`events.jsonl line ${line} ${reason}; repair or restore the event log`);
  };
  if (event === null || typeof event !== 'object' || Array.isArray(event)) fail('must be an object');
  if (event.seq !== expectedSequence) fail(`has sequence ${event.seq}; expected ${expectedSequence}`);
  if (!eventKinds.has(event.kind)) fail(`has unknown event ${event.kind}`);
  if (typeof event.run_id !== 'string' || !event.run_id) fail('has no run_id');
  if (typeof event.ts !== 'string' || Number.isNaN(Date.parse(event.ts))) fail('has an invalid timestamp');
  if (event.kind.startsWith('node.')) {
    if (typeof event.node !== 'string' || !event.node) fail('has no node name');
  } else if (event.node !== null) {
    fail('must use a null node for a run event');
  }
  return event;
}

export function readEvents(folder) {
  const file = path.join(folder, 'events.jsonl');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    if (!line.trim()) throw new Error(`events.jsonl line ${index + 1} is blank; repair or restore the event log`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`events.jsonl line ${index + 1} is not valid JSON; repair or restore the event log`);
    }
    return validateEvent(event, index + 1, index + 1);
  });
}

export function createEventWriter(folder, previous) {
  const file = path.join(folder, 'events.jsonl');
  const runId = previous.find(({ kind }) => kind === 'run.start')?.run_id ?? randomUUID();
  let sequence = previous.length;
  return {
    runId,
    emit(kind, node = null, extra = {}) {
      const event = {
        seq: ++sequence,
        kind,
        run_id: runId,
        node,
        ts: new Date().toISOString(),
        ...extra,
      };
      validateEvent(event, sequence, sequence);
      appendFileSync(file, `${JSON.stringify(event)}\n`);
      return event;
    },
  };
}

export function finishedSteps(events) {
  return new Set(events.filter(({ kind }) => kind === 'node.exit').map(({ node }) => node));
}
