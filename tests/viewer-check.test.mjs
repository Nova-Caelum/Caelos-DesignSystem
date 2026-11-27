import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveInteractionLocator, runViewerCheck } from '../viewer/check-viewer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/viewer-check/recorded-dom.json'), 'utf8'));

function createFakeDriver(record) {
  return {
    async inspectEntry(entry) {
      const recorded = record.entries[entry];
      if (!recorded) return { found: false, states: [], cards: [], sideBySide: false };
      return {
        found: true,
        statesValid: Array.isArray(recorded.states)
          && recorded.states.length > 0
          && recorded.states.every((state) => typeof state === 'string' && state.length > 0),
        states: recorded.states,
        sideBySide: recorded.sideBySide,
        cards: recorded.cards.map((card) => ({
          ...card,
          events: card.events && { ...card.events },
          live: card.live && { ...card.live },
          interactionTarget: card.interactionTarget && { ...card.interactionTarget },
        })),
      };
    },
    async interact(card, interaction) {
      const before = card.events?.[interaction];
      const target = card.interactionTarget ?? card.live;
      if (target?.[interaction] === true && Number.isInteger(before)) {
        card.events[interaction] += 1;
      }
      return {
        before,
        after: card.events?.[interaction],
      };
    },
  };
}

test('the Playwright locator resolver prefers the marked inner live control', async () => {
  const inner = { count: async () => 1, first: () => inner };
  const live = { locator: (selector) => {
    assert.equal(selector, '[data-live-control]');
    return inner;
  } };

  assert.equal(await resolveInteractionLocator(live), inner);
});

test('an inner control that forwards passes even when the composite root is dead', async () => {
  const { result } = await runCase(['controls.shared.InnerForwards']);
  assert.equal(result.exitCode, 0, result.message);
});

test('a dead inner control fails by entry name even when the composite root has handlers', async () => {
  const { result, results } = await runCase(['controls.shared.InnerDeadRootForwards']);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.InnerDeadRootForwards/u);
  assert.equal(results.entries[0].states[0].responding, false);
});

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

test('the fixture Button passes with forwarding states and a non-forwarding disabled state', async () => {
  const { result, results } = await runCase(['controls.shared.Button']);

  assert.equal(result.exitCode, 0, result.message);
  assert.equal(results.summary.failed, 0);
  assert.deepEqual(results.entries[0].states.map(({ state, shown, responding, named, clickResponded, keyResponded }) => ({
    state, shown, responding, named, clickResponded, keyResponded,
  })), [
    { state: 'default', shown: true, responding: true, named: true, clickResponded: true, keyResponded: true },
    { state: 'hover', shown: true, responding: true, named: true, clickResponded: true, keyResponded: true },
    { state: 'pressed', shown: true, responding: true, named: true, clickResponded: true, keyResponded: true },
    { state: 'success', shown: true, responding: true, named: true, clickResponded: true, keyResponded: true },
    { state: 'focus', shown: true, responding: true, named: true, clickResponded: true, keyResponded: true },
    { state: 'disabled', shown: true, responding: true, named: true, clickResponded: false, keyResponded: false },
  ]);
});

test('an entry with no cards exits 1 and names the entry', async () => {
  const { result, results } = await runCase(['controls.shared.NoCards']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.NoCards/);
  assert.equal(results.entries[0].states[0].shown, false);
});

test('a dead entry exits 1 and names the entry and state', async () => {
  const { result, results } = await runCase(['controls.shared.Dead']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.Dead/);
  assert.match(result.message, /default/);
  assert.equal(results.entries[0].states[0].responding, false);
  assert.equal(results.entries[0].states[0].clickResponded, false);
  assert.equal(results.entries[0].states[0].keyResponded, false);
});

test('a click-only entry exits 1 and names the entry and state', async () => {
  const { result, results } = await runCase(['controls.shared.ClickOnly']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.ClickOnly/);
  assert.match(result.message, /default/);
  assert.equal(results.entries[0].states[0].clickResponded, true);
  assert.equal(results.entries[0].states[0].keyResponded, false);
});

test('a partly shown entry exits 1 and names every missing state', async () => {
  const { result, results } = await runCase(['controls.shared.PartlyShown']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.PartlyShown\/hover/);
  assert.match(result.message, /controls\.shared\.PartlyShown\/disabled/);
  assert.deepEqual(results.entries[0].states.map(({ state, shown }) => ({ state, shown })), [
    { state: 'default', shown: true },
    { state: 'hover', shown: false },
    { state: 'disabled', shown: false },
  ]);
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

test('a hidden live element exits 1 and names the entry and state', async () => {
  const { result, results } = await runCase(['controls.shared.Hidden']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.Hidden/);
  assert.match(result.message, /default/);
  assert.equal(results.entries[0].states[0].named, false);
});

test('a disabled card that forwards exits 1 and names the entry and state', async () => {
  const { result, results } = await runCase(['controls.shared.DisabledForwards']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.DisabledForwards/);
  assert.match(result.message, /disabled/);
  assert.equal(results.entries[0].states[0].clickResponded, true);
  assert.equal(results.entries[0].states[0].keyResponded, true);
  assert.equal(results.entries[0].states[0].responding, false);
});

test('missing counter attributes cannot pass the fake driver', async () => {
  const { result, results } = await runCase(['controls.shared.MissingCounters']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.MissingCounters/);
  assert.match(result.message, /default/);
  assert.equal(results.entries[0].states[0].responding, false);
});

test('a shown card without a live element exits 1', async () => {
  const { result, results } = await runCase(['controls.shared.NoLive']);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /controls\.shared\.NoLive/);
  assert.equal(results.entries[0].states[0].live, false);
});
