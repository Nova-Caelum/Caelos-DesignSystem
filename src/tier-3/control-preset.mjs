import controls from '../../token_catalog/02-controls.tokens.json' with { type: 'json' };
import dark from '../../token_catalog/00-semantic.dark.tokens.json' with { type: 'json' };
import { cloudStyle, tokenWriter, ref, writeCloudVars, materialPreset, materialRecipe } from '../material-preset.mjs';
const {input, button} = controls.controls.shared;
const fieldGroup = 'field';
const surface = button.$extensions['app.caelos'].surfaceTreatment;
const writer = tokenWriter(dark);
writeCloudVars(fieldGroup, input.cloud, writer);
for (const key of ['foreground','focus-foreground','disabled-foreground','bed','default','hover','pressed','success','disabled-bed','tint'])
  writer.add('button-' + key, button[key], key === 'tint');
const glow = group => {
  const role = key => ref(group + '-' + key);
  return [role('inset'), role('inset'), role('focus-glow-blur'),
    'color-mix(in srgb, ' + role('focus-glow-ink') + ' ' + role('focus-glow-opacity') + ', transparent)'].join(' ');
};
for (const [group, tokens] of [[fieldGroup,input],['button',button]]) {
  for (const key of ['focus-glow-blur','focus-glow-ink','focus-glow-opacity','focus-foreground','foreground'])
    writer.add(group + '-' + key, tokens[key], key === 'focus-glow-opacity');
}
writer.add('button-inset', button['glow-offset']);
for (const [key, value] of Object.entries(surface)) {
  writer.add('button-surface-' + key, {$value:value}, key.endsWith('-alpha') || key === 'glow-opacity');
}
writer.values['--caelos-material-button-surface-angle'] += 'deg';
const finish = key => ref('button-surface-' + key);
const wash = 'linear-gradient(' + finish('angle') + ', ' + ['start','end'].map(end =>
  'color-mix(in srgb, ' + finish('wash-' + end) + ' ' + finish('wash-' + end + '-alpha') + ', transparent)').join(', ') + ')';
const restingGlow = [finish('glow-offset'), finish('glow-offset'), finish('glow-blur'),
  'color-mix(in srgb, ' + finish('glow-ink') + ' ' + finish('glow-opacity') + ', transparent)'].join(' ');
export const fieldSurfaceRecipe = { className: 'caelos-field-surface', base: {
  color: ref('field-foreground'),
  ...cloudStyle(fieldGroup, { color: ref('field-focus-foreground'), boxShadow: glow(fieldGroup) }),
} };
const buttonFill = state => 'color-mix(in srgb, ' + ref('button-' + state) + ' ' + ref('button-tint') + ', ' + ref('button-bed') + ')';
export const primaryButtonInkRecipe = { className: 'caelos-primary-button-ink', base: {
  color: ref('button-foreground'), backgroundColor: buttonFill('default'),
  backgroundImage: wash, boxShadow: restingGlow,
  '&:is(:hover, :focus-visible):not(:active, :disabled, [data-state=success])': {
    color: ref('button-focus-foreground'), backgroundColor: ref('button-bed'), boxShadow: glow('button'),
  },
  '&:active:not(:disabled)': {backgroundColor: buttonFill('pressed')},
  '&[data-state=success]:not(:active, :disabled)': {backgroundColor: buttonFill('success'), backgroundImage: 'none', boxShadow: 'none'},
  '&:disabled': { color: ref('button-disabled-foreground'), backgroundColor: ref('button-disabled-bed'), backgroundImage: 'none', boxShadow: 'none' },
} };
// Each paint parameter comes directly from the catalog's lower-tier references.
const statePaints = button.$extensions['app.caelos'].statePaints;
for (const style of ['tonal', 'text']) for (const [state, paint] of Object.entries(statePaints[style])) {
  for (const [key, value] of Object.entries(paint)) {
    const name = style + '-' + state + '-' + key;
    writer.add(name, {$value: value}, /Opacity$|Alpha$|^falloffAt$/.test(key));
    if (key === 'angle') writer.values['--caelos-material-' + name] += 'deg';
  }
}
const stateRole = (style, state) => key => ref(style + '-' + state + '-' + key);
function tonalWash(state) {
  const role = stateRole('tonal', state);
  return {
    backgroundColor: 'color-mix(in srgb, ' + role('fill') + ' ' + role('fillOpacity') + ', transparent)',
    backgroundImage: 'linear-gradient(' + role('angle') + ', ' + ['Start','End'].map(end =>
      'color-mix(in srgb, ' + role('wash' + end) + ' ' + role('wash' + end + 'Alpha') + ', transparent)').join(', ') + ')',
  };
}
const engaged = '&:is(:hover, :focus-visible):not(:active, :disabled, [data-state=success])';
const pressed = '&:active:not(:disabled, [data-state=success])';
const succeeded = '&[data-state=success]:not(:disabled)';
export const tonalButtonInkRecipe = { className: 'caelos-tonal-button-ink', base: {
  ...materialRecipe.base,
  color: stateRole('tonal','default')('foreground'), ...tonalWash('default'), boxShadow: 'none',
  [engaged]: {color: ref('button-focus-foreground'), boxShadow: glow('button')},
  [pressed]: {...materialRecipe.variants.texture.glass, color: stateRole('tonal','pressed')('foreground'), boxShadow: 'none'},
  [succeeded]: {...tonalWash('success'), color: stateRole('tonal','success')('foreground'), boxShadow: 'none', backdropFilter: 'none'},
  '&:disabled': {color: stateRole('tonal','disabled')('foreground'), backgroundColor: stateRole('tonal','disabled')('fill'), backgroundImage: 'none', boxShadow: 'none', backdropFilter: 'none'},
} };
export const textButtonInkRecipe = { className: 'caelos-text-button-ink', base: {
  color: stateRole('text','default')('foreground'), background: 'transparent', boxShadow: 'none', textShadow: 'none',
  [engaged]: {color: ref('button-focus-foreground'), textShadow: glow('button')},
  [pressed]: {color: stateRole('text','pressed')('foreground'), textShadow: glow('button')},
  [succeeded]: {color: stateRole('text','success')('foreground'), textShadow: 'none'},
  '&:disabled': {color: stateRole('text','disabled')('foreground'), textShadow: 'none'},
} };
export const controlPreset = {
  name: 'caelos-controls', presets: [materialPreset],
  globalCss: { ...materialPreset.globalCss, ':root, [data-theme="dark"]': { ...materialPreset.globalCss[':root, [data-theme="dark"]'], ...writer.values } },
  theme: { extend: { recipes: { fieldSurface: fieldSurfaceRecipe, primaryButtonInk: primaryButtonInkRecipe, tonalButtonInk: tonalButtonInkRecipe, textButtonInk: textButtonInkRecipe } } },
};
