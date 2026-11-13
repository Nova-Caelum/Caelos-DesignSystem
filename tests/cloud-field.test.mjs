import catalog from '../token_catalog/02-controls.tokens.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveControlCatalog} from '../src/tier-2/control-catalog.mjs';
const controls = resolveControlCatalog(catalog);
import {controlPreset} from '../src/tier-3/control-preset.mjs';
const vars = controlPreset.globalCss[':root, [data-theme="dark"]'];
const get = name => vars['--caelos-material-' + name];
test('fields inherit every dark Cloud value, including the recovered state and motion envelope', () => {
  for (const [key, val] of Object.entries(vars).filter(([k]) => k.startsWith('--caelos-material-cloud-'))) {
    assert.equal(vars[key.replace('-cloud-', '-field-')], val);
  }
  assert.equal(parseFloat(get('field-angle')), 135);
  assert.equal(parseFloat(get('field-duration')), 320);
  assert.equal(parseFloat(get('field-reduced-duration')), 0);
  for (const [role, value] of Object.entries({'wash-rest':'0', 'wash-hover':'0.23', 'wash-focus':'1', 'disabled-alpha':'0.5'})) {
    assert.equal(get('field-' + role),value);
  }
});
const channels = hex => hex.slice(1).match(/../g).map(x => parseInt(x,16)/255);
const lum = color => color.map(v => v<=0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4).reduce((a,n,i) => a + n*[0.2126,0.7152,0.0722][i],0);
test('normal primary ink stays cream and readable over every active tint', () => {
  assert.equal(get('button-foreground'), '#EDE3CF');
  const bed = channels(get('button-bed')), tint = parseFloat(get('button-tint'))/100;
  for (const state of ['default','pressed','success']) {
    const fill = channels(get('button-'+state)).map((v,i) => v*tint+bed[i]*(1-tint));
    assert.ok((lum(channels(get('button-foreground')))+0.05)/(lum(fill)+0.05)>=4.5,state);
  }
});

test('primary hover and focus share lower-tier paint without changing pressed acknowledgement', () => {
  const states = controls.controls.shared.button.$extensions['app.caelos'].statePaints.primary;
  assert.deepEqual(states.hover, states.focus);
  assert.notDeepEqual(states.pressed, states.hover);
  for (const value of Object.values(states.hover)) assert.match(value, /^\{primitives\./);
});
test('shared blue hover/focus ink remains readable on the dark button bed', () => {
  const ink = lum(channels(get('button-focus-foreground')));
  const bed = lum(channels(get('button-bed')));
  assert.ok((ink + 0.05)/(bed + 0.05) >= 4.5);
});

test('primary wash uses existing Cloud tokens and preserves text contrast over its full ramp', () => {
  for (const key of ['angle','wash-start','wash-end','wash-start-alpha','wash-end-alpha'])
    assert.equal(get('button-surface-'+key),get('cloud-'+key));
  const blend=(ink,bed,alpha)=>ink.map((v,i)=>v*alpha+bed[i]*(1-alpha));
  const start=channels(get('button-surface-wash-start')), end=channels(get('button-surface-wash-end'));
  const a=parseFloat(get('button-surface-wash-start-alpha'))/100, b=parseFloat(get('button-surface-wash-end-alpha'))/100;
  for(const state of ['default','pressed','hover','focus']) {
    const focused=['hover','focus'].includes(state), bed=channels(get('button-bed'));
    const base=focused?bed:blend(channels(get('button-'+state)),bed,parseFloat(get('button-tint'))/100);
    const ink=channels(get(focused?'button-focus-foreground':'button-foreground'));
    for(let step=0;step<=100;step++) {
      const t=step/100, alpha=a*(1-t)+b*t;
      const color=start.map((v,i)=>(v*a*(1-t)+end[i]*b*t)/alpha);
      assert.ok((lum(ink)+.05)/(lum(blend(color,base,alpha))+.05)>=4.5,state+' at '+step+'%');
    }
  }
  const recipe=controlPreset.theme.extend.recipes.primaryButtonInk.base;
  assert.equal(recipe['&[data-state=success]:not(:active, :disabled)'].backgroundImage,'none');
  assert.equal(recipe['&:disabled'].boxShadow,'none');
});

test('secondary buttons share hover/focus and preserve confirmed success over pointer states', () => {
  const paints = controls.controls.shared.button.$extensions['app.caelos'].statePaints;
  const recipes = controlPreset.theme.extend.recipes;
  for (const style of ['tonal','text']) {
    assert.deepEqual(paints[style].hover, paints[style].focus);
    const recipe = recipes[style + 'ButtonInk'].base;
    assert.ok(recipe['&:is(:hover, :focus-visible):not(:active, :disabled, [data-state=success])']);
    assert.ok(recipe['&:active:not(:disabled, [data-state=success])']);
    assert.ok(recipe['&[data-state=success]:not(:disabled)']);
    assert.equal(recipe['&:disabled'][style === 'tonal' ? 'boxShadow' : 'textShadow'], 'none');
  }
  const text = recipes.textButtonInk.base;
  assert.equal(text.background, 'transparent');
  for (const value of Object.values(text).filter(v => v && typeof v === 'object'))
    assert.ok(!Object.keys(value).some(key => key.startsWith('background')));
});

test('tonal pressed inherits the complete glass material including accessibility fallbacks', async () => {
  const {materialRecipe} = await import('../src/material-preset.mjs');
  const pressed = controlPreset.theme.extend.recipes.tonalButtonInk.base['&:active:not(:disabled, [data-state=success])'];
  for (const [key, value] of Object.entries(materialRecipe.variants.texture.glass))
    assert.deepEqual(pressed[key], value, key);
  assert.equal(get('tonal-pressed-fillOpacity'), '23%');
  assert.equal(get('tonal-pressed-saturation'), '1.25');
  assert.equal(get('tonal-pressed-falloffAt'), '72%');
});

test('tonal wash preserves cream, blue and success-green contrast on the approved dark bed', () => {
  const blend=(ink,bed,alpha)=>ink.map((v,i)=>v*alpha+bed[i]*(1-alpha));
  for(const state of ['default','hover','focus','success']) {
    const role=key=>get('tonal-'+state+'-'+key);
    const base=blend(channels(role('fill')),channels(get('button-bed')),parseFloat(role('fillOpacity'))/100);
    const start=channels(role('washStart')),end=channels(role('washEnd'));
    const a=parseFloat(role('washStartAlpha'))/100,b=parseFloat(role('washEndAlpha'))/100;
    for(let step=0;step<=100;step++) {
      const t=step/100,alpha=a*(1-t)+b*t;
      const color=start.map((v,i)=>(v*a*(1-t)+end[i]*b*t)/alpha);
      assert.ok((lum(channels(role('foreground')))+.05)/(lum(blend(color,base,alpha))+.05)>=4.5,state+' at '+step+'%');
    }
  }
});

test('secondary success uses semantic green and text engagement consumes its own glow tokens', () => {
  const paints = controls.controls.shared.button.$extensions['app.caelos'].statePaints;
  for (const style of ['tonal','text']) {
    assert.equal(paints[style].success.foreground, '{sys.color.success}');
    assert.equal(get(style + '-success-foreground'), get('button-success'));
  }
  assert.equal(get('text-hover-glowOpacity'), '50%');
  assert.equal(get('text-focus-glowOpacity'), '50%');
  assert.equal(get('text-pressed-glowOpacity'), undefined);
  const text = controlPreset.theme.extend.recipes.textButtonInk.base;
  const hover = text['&:is(:hover, :focus-visible):not(:active, :disabled, [data-state=success])'];
  for (const key of ['glowOffset','glowBlur','glowInk','glowOpacity'])
    assert.ok(hover.textShadow.includes('--caelos-material-text-hover-' + key));
});


test('field hover is blue and typing focus is primary, preserving Cloud wash and disabled exclusion', () => {
  const input = controls.controls.shared.input;
  assert.equal(input.foreground.$value, '{primitives.shared.typography.tone.muted}');
  assert.equal(input['supporting-ink'].$value, '{primitives.shared.typography.tone.dim}');
  const recipe = controlPreset.theme.extend.recipes.fieldSurface.base;
  const hover = recipe['&:hover:not(:focus-within, :disabled, [data-disabled=true], :has(:disabled))'];
  const focus = recipe['&:focus-within:not(:disabled, [data-disabled=true], :has(:disabled))'];
  assert.equal(focus.color, 'var(--caelos-material-field-focus-foreground)');
  assert.notEqual(focus.color, recipe.color);
  assert.equal(get('field-focus-foreground'), '#EDE3CF');
  assert.notEqual(hover.color, focus.color);
  assert.equal(hover.color, 'var(--caelos-material-field-hover-foreground)');
  assert.equal(hover['&::before'].opacity, 'var(--caelos-material-field-wash-hover)');
  assert.equal(recipe['&:is(:disabled, [data-disabled=true], :has(:disabled))']['&::before'].opacity, 'var(--caelos-material-field-wash-rest)');
  assert.equal(get('field-foreground'), '#9B958B');
});


test('secondary pressed feedback uses Ready Blue without glow in all motion preferences', () => {
  const recipes = controlPreset.theme.extend.recipes;
  const selector = '&:active:not(:disabled, [data-state=success])';
  for (const style of ['tonal','text']) {
    const pressed = recipes[style + 'ButtonInk'].base[selector];
    assert.equal(get(style + '-pressed-foreground'), '#8E96CC');
    assert.notEqual(get(style + '-pressed-foreground'), get(style + '-hover-foreground'));
    assert.notEqual(get(style + '-pressed-foreground'), get(style + '-default-foreground'));
    assert.equal(pressed[style === 'text' ? 'textShadow' : 'boxShadow'], 'none');
    // The visual feedback is unconditional, not hidden in a motion media query.
    assert.equal(pressed.color, 'var(--caelos-material-' + style + '-pressed-foreground)');
  }
  assert.equal(recipes.textButtonInk.base[selector].textDecorationLine, 'underline');
  assert.ok(!('textDecorationLine' in recipes.tonalButtonInk.base[selector]));
});
