import assert from 'node:assert/strict';
import test from 'node:test';
import { materialPreset, materialRecipe } from '../src/material-preset.mjs';
import catalog from '../token_catalog/01-primitives.tokens.json' with { type: 'json' };
import base from '../token_catalog/00-foundations.tokens.json' with { type: 'json' };

test('one glass material consumes the approved saturation in both themes', () => {
  const glass = catalog.primitives.shared.glass;
  assert.equal(glass.saturation.$value, '{sys.material.glass.saturation}');
  assert.equal(base.base.saturation['factor-1-25'].$value, 1.25);
  assert.ok(!('panel' in glass) && !('menu' in glass));
  assert.ok(!('portal' in materialRecipe.variants.texture));
  const style = materialRecipe.variants.texture.glass;
  assert.ok(style.backdropFilter.includes('--caelos-material-glass-saturation'));
  for (const vars of Object.values(materialPreset.globalCss)) {
    assert.equal(Number(vars['--caelos-material-glass-saturation']), base.base.saturation['factor-1-25'].$value);
    assert.ok(!Object.keys(vars).some(key => /material-(panel|menu)-/.test(key)));
  }
  assert.equal(style['@media (prefers-reduced-transparency: reduce)'].backdropFilter, 'none');
});
test('registered finishes and automatic layers agree with the ledger', () => {
  const surface = catalog.primitives.shared.surface.$extensions['app.caelos'];
  assert.deepEqual(Object.keys(materialRecipe.variants.texture).sort(), [...surface.variants.texture].sort());
  for (const [layer, finish] of Object.entries(surface.autoTexture)) {
    assert.equal(materialRecipe.variants.layer[layer]['--caelos-auto-image'], materialRecipe.variants.texture[finish].backgroundImage);
  }
});

test('adaptive filtering is shared by explicit and automatic glass, isolated per surface', () => {
  const input = catalog.primitives.shared.surface.$extensions['app.caelos'].backdropOverlap.input;
  assert.equal(input, '--sys-glass-auto-blur');
  assert.equal(materialRecipe.base[input], 'var(--caelos-material-overlap-covered)');
  const style = materialRecipe.variants.texture.glass;
  assert.ok(style.backdropFilter.includes('clamp(var(--caelos-material-overlap-clear), var(' + input + '), var(--caelos-material-overlap-covered))'));
  assert.ok(!style.backgroundColor.includes(input) && !style.backgroundImage.includes(input));
  for (const fallback of Object.keys(style).filter(k => k.startsWith('@'))) {
    assert.equal(style[fallback].backdropFilter, 'none');
    assert.equal(style[fallback].backgroundColor, 'var(--caelos-material-body)');
  }
  assert.equal(materialRecipe.variants.layer.elevated['--caelos-auto-filter'], materialRecipe.variants.texture.glass.backdropFilter);
  assert.ok(!materialRecipe.variants.texture.sage.backdropFilter.includes(input));
});


test('graph uses foundation-sized dots in both themes and automatic graph layers', () => {
  const graph = catalog.primitives.shared.graph;
  assert.equal(graph['dot-size'].$value, '{base.space.px-2}');
  assert.ok(!('line' in graph));
  const texture = materialRecipe.variants.texture.graph;
  assert.match(texture.backgroundImage, /^radial-gradient\(circle,/);
  assert.ok(!texture.backgroundImage.includes('linear-gradient'));
  for (const vars of Object.values(materialPreset.globalCss)) {
    const diameter = base.base.space['px-2'].$value;
    assert.equal(vars['--caelos-material-graph-dot-size'], `${diameter.value}${diameter.unit}`);
    assert.equal(vars['--caelos-material-graph-dot-radius'], `${diameter.value / 2}${diameter.unit}`);
    assert.equal(vars['--caelos-material-graph-pitch'], '27px');
    assert.equal(parseFloat(vars['--caelos-material-graph-opacity']), base.base.opacity['fraction-0-07'].$value * 100);
    assert.ok(!('--caelos-material-graph-line' in vars));
  }
  for (const layer of ['chrome', 'ground']) {
    assert.equal(materialRecipe.variants.layer[layer]['--caelos-auto-image'], texture.backgroundImage);
    assert.equal(materialRecipe.variants.layer[layer]['--caelos-auto-size'], texture.backgroundSize);
  }
});
