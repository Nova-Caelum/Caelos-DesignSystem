import controls from '../../token_catalog/02-controls.tokens.json' with { type: 'json' };
import dark from '../../token_catalog/00-semantic.dark.tokens.json' with { type: 'json' };
import { cloudStyle, tokenWriter, ref, writeCloudVars, materialPreset } from '../material-preset.mjs';
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
export const controlPreset = {
  name: 'caelos-controls', presets: [materialPreset],
  globalCss: { ...materialPreset.globalCss, ':root, [data-theme="dark"]': { ...materialPreset.globalCss[':root, [data-theme="dark"]'], ...writer.values } },
  theme: { extend: { recipes: { fieldSurface: fieldSurfaceRecipe, primaryButtonInk: primaryButtonInkRecipe } } },
};
