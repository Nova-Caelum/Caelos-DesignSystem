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
      assert.equal(Number(vars['--caelos-material-' + role + '-saturation']), base.base.material.saturation[role].$value);
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
