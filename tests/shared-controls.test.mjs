import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveControlCatalog } from '../src/tier-2/control-catalog.mjs';
const load = name => JSON.parse(readFileSync(new URL('../token_catalog/' + name + '.tokens.json', import.meta.url)));
const catalog = load('02-controls');
const meta = value => value.$extensions['app.caelos'];
const shared = doc => meta(doc.controls).sharedConstruction;
function leaves(node, prefix = '', out = new Map()) {
  for (const [name, child] of Object.entries(node)) {
    if (name.startsWith('$')) continue;
    const path = prefix ? prefix + '.' + name : name;
    if ('$value' in child) out.set(path, child); else leaves(child, path, out);
  }
  return out;
}
function validateShared(doc) {
  const model = shared(doc);
  const lower = new Map(['00-foundations','00-semantic.dark','01-primitives'].flatMap(file => [...leaves(load(file))]));
  for (const map of [...Object.values(model.parameters), ...Object.values(model.paints)]) {
    for (const reference of Object.values(map)) {
      const path = /^\{([^{}]+)\}$/.exec(reference)?.[1];
      assert.ok(path && lower.has(path), 'Missing or non-lower-tier reference: ' + reference);
    }
  }
  for (const [group, choices] of Object.entries(model.parameters)) {
    assert.equal(new Set(Object.values(choices)).size, Object.keys(choices).length, 'Duplicate choice in ' + group);
  }
  const appearances = Object.values(model.paints).map(paint => JSON.stringify(Object.entries(paint).sort()));
  assert.equal(new Set(appearances).size, appearances.length, 'Duplicate shared appearance');
  resolveControlCatalog(doc);
}
test('shared control choices resolve and have no duplicate ingredients or appearances', () => validateShared(catalog));
for (const [label, value] of [['raw',8], ['missing','{base.space.missing}'], ['same tier','{controls.shared.button.default}']]) {
  test('shared control validation rejects ' + label + ' construction', () => {
    const doc = structuredClone(catalog); shared(doc).parameters.spacing['8px'] = value;
    assert.throws(() => validateShared(doc), /non-lower-tier/);
  });
}
test('shared control validation rejects duplicate choices and appearances', () => {
  const doc = structuredClone(catalog); shared(doc).parameters.spacing.duplicate = shared(doc).parameters.spacing['8px'];
  assert.throws(() => validateShared(doc), /Duplicate choice/);
  delete shared(doc).parameters.spacing.duplicate;
  shared(doc).paints.duplicate = shared(doc).paints['cloud-rest'];
  assert.throws(() => validateShared(doc), /Duplicate shared appearance/);
});
test('unknown geometry and appearance selections fail instead of silently defaulting', () => {
  const doc = structuredClone(catalog); const button = meta(doc.controls.shared.button);
  button.construction['pad-x'] = 'spacing/missing';
  assert.throws(() => resolveControlCatalog(doc), /Unknown shared construction/);
  button.construction['pad-x'] = 'spacing/15px'; button.statePaints.primary.default = 'missing';
  assert.throws(() => resolveControlCatalog(doc), /Unknown shared appearance/);
});
test('buttons and chips reuse the same state appearances; badges remain passive', () => {
  const source = catalog.controls.shared;
  const button = meta(source.button), chip = meta(source.chip), badge = meta(source.badge);
  for (const state of chip.states) assert.equal(chip.statePaints[state], button.statePaints.tonal[state]);
  for (const states of Object.values(button.statePaints)) assert.equal(states.hover, states.focus);
  assert.ok(!('success' in chip.statePaints));
  assert.ok(!('statePaints' in badge));
  const resolved = resolveControlCatalog(catalog).controls.shared;
  for (const slot of ['type-family','type-size','type-line','type-weight']) {
    assert.equal(meta(resolved.button).construction[slot], meta(resolved.chip).construction[slot]);
    assert.equal(meta(resolved.button).construction[slot], meta(resolved.badge).construction[slot]);
  }
});
