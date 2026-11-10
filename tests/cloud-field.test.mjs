import test from 'node:test';
import assert from 'node:assert/strict';
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
  for (const [role, value] of Object.entries({'wash-rest':'0', 'wash-hover':'0.22', 'wash-focus':'1', 'disabled-alpha':'0.5'})) {
    assert.equal(get('field-' + role),value);
  }
});
const channels = hex => hex.slice(1).match(/../g).map(x => parseInt(x,16)/255);
const lum = color => color.map(v => v<=0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4).reduce((a,n,i) => a + n*[0.2126,0.7152,0.0722][i],0);
test('normal primary ink stays cream and readable over every active tint', () => {
  assert.equal(get('button-foreground'), '#EDE3CF');
  const bed = channels(get('button-bed')), tint = parseFloat(get('button-tint'))/100;
  for (const state of ['default','hover','pressed','success']) {
    const fill = channels(get('button-'+state)).map((v,i) => v*tint+bed[i]*(1-tint));
    assert.ok((lum(channels(get('button-foreground')))+0.05)/(lum(fill)+0.05)>=4.5,state);
  }
});
