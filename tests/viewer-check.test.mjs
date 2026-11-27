import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runViewerCheck } from '../viewer/check-viewer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/viewer-check/recorded-dom.json'), 'utf8'));

function createFakeDriver(record) {
  return {
    async inspectEntry(entry) {
      const recorded = record.entries[entry];
      if (!recorded) return { found: false, states: [], cards: [], sideBySide: false };
      return {
        found: true,
        states: recorded.states,
        sideBySide: recorded.sideBySide,
        cards: recorded.cards.map((card) => ({ ...card, live: card.live && { ...card.live } })),
      };
    },
    async interact(card, interaction) {
      return card.live?.[interaction] === true;
    },
  };
}

async function runCase(entries) {
  const folder = await mkdtemp(path.join(tmpdir(), 'viewer-check-test-'));
  const out = path.join(folder, 'results.json');
  try {
    const result = await runViewerCheck({ driver: createFakeDriver(fixture), entries, out });
    return { result, results: JSON.parse(await readFile(out, 'utf8')) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('the fixture Button entry passes and records every state as shown and responding', async () => {
  const { result, results } = await runCase(['controls.shared.Button']);

  assert.equal(result.exitCode, 0, result.message);
  assert.equal(results.summary.failed, 0);
  assert.deepEqual(results.entries[0].states.map(({ state, shown, responding, named }) => ({ state, shown, responding, named })), [
    { state: 'default', shown: true, responding: true, named: true },
    { state: 'hover', shown: true, responding: true, named: true },
    { state: 'pressed', shown: true, responding: true, named: true },
    { state: 'success', shown: true, responding: true, named: true },
    { state: 'focus', shown: true, responding: true, named: true },
    { state: 'disabled', shown: true, responding: true, named: true },
  ]);
});

test('an entry with no cards exits 1 and names the entry', async () => {
  const { result, results } = await runCase(['controls.shared.NoCards']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.NoCards/);
  assert.equal(results.entries[0].states[0].shown, false);
});

test('a shown dead component exits 1 and names the entry and state', async () => {
  const { result, results } = await runCase(['controls.shared.Dead']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.Dead/);
  assert.match(result.message, /default/);
  assert.equal(results.entries[0].states[0].responding, false);
  assert.equal(results.entries[0].states[0].clickResponded, true);
  assert.equal(results.entries[0].states[0].keyResponded, false);
});

test('an unknown entry id exits 1', async () => {
  const { result } = await runCase(['controls.shared.Unknown']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.Unknown/);
});

test('attack: a shown live element without a readable name exits 1', async () => {
  const { result, results } = await runCase(['controls.shared.Nameless']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.Nameless/);
  assert.equal(results.entries[0].states[0].named, false);
});

test('a shown card without a live element exits 1', async () => {
  const { result, results } = await runCase(['controls.shared.NoLive']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.NoLive/);
  assert.equal(results.entries[0].states[0].live, false);
});
