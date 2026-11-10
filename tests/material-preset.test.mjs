import assert from 'node:assert/strict';
import test from 'node:test';
import { materialPreset, materialRecipe } from '../src/material-preset.mjs';
import catalog from '../token_catalog/01-primitives.tokens.json' with { type: 'json' };
import base from '../token_catalog/00-foundations.tokens.json' with { type: 'json' };

test('panel and portal consume their own saturation roles in both themes', () => {
  for (const [finish, role] of [['glass', 'panel'], ['portal', 'menu']]) {
    assert.equal(catalog.primitives.shared.glass[role].saturation.$value, '{sys.material.' + role + '.saturation}');
    const style = materialRecipe.variants.texture[finish];
    assert.ok(style.backdropFilter.includes('--caelos-material-' + role + '-saturation'));
    for (const vars of Object.values(materialPreset.globalCss)) {
      assert.equal(Number(vars['--caelos-material-' + role + '-saturation']), base.base.saturation[role === 'panel' ? 'factor-1-2' : 'factor-1-35'].$value);
    }
    assert.equal(style['@media (prefers-reduced-transparency: reduce)'].backdropFilter, 'none');
  }
});
test('registered finishes and automatic layers agree with the ledger', () => {
  const surface = catalog.primitives.shared.surface.$extensions['app.caelos'];
  assert.deepEqual(Object.keys(materialRecipe.variants.texture).sort(), [...surface.variants.texture].sort());
  for (const [layer, finish] of Object.entries(surface.autoTexture)) {
    assert.equal(materialRecipe.variants.layer[layer]['--caelos-auto-image'], materialRecipe.variants.texture[finish].backgroundImage);
  }
});

test('adaptive filtering is shared by panel, portal and auto glass, isolated per surface', () => {
  const input = catalog.primitives.shared.surface.$extensions['app.caelos'].backdropOverlap.input;
  assert.equal(input, '--sys-glass-auto-blur');
  assert.equal(materialRecipe.base[input], 'var(--caelos-material-overlap-covered)');
  for (const key of ['glass', 'portal']) {
    const style = materialRecipe.variants.texture[key];
    assert.ok(style.backdropFilter.includes('clamp(var(--caelos-material-overlap-clear), var(' + input + '), var(--caelos-material-overlap-covered))'));
    assert.ok(!style.backgroundColor.includes(input) && !style.backgroundImage.includes(input));
    for (const fallback of Object.keys(style).filter(k => k.startsWith('@'))) {
      assert.equal(style[fallback].backdropFilter, 'none');
      assert.equal(style[fallback].backgroundColor, 'var(--caelos-material-body)');
    }
  }
  assert.equal(materialRecipe.variants.layer.elevated['--caelos-auto-filter'], materialRecipe.variants.texture.glass.backdropFilter);
  assert.ok(!materialRecipe.variants.texture.sage.backdropFilter.includes(input));
});
