import controls from '../../token_catalog/02-controls.tokens.json' with { type: 'json' };
import dark from '../../token_catalog/00-semantic.dark.tokens.json' with { type: 'json' };
import { cloudStyle, tokenWriter, ref, writeCloudVars, materialPreset } from '../material-preset.mjs';
const {input, button} = controls.controls.shared;
const fieldGroup = 'field';
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
export const fieldSurfaceRecipe = { className: 'caelos-field-surface', base: {
  color: ref('field-foreground'),
  ...cloudStyle(fieldGroup, { color: ref('field-focus-foreground'), boxShadow: glow(fieldGroup) }),
} };
const buttonFill = state => 'color-mix(in srgb, ' + ref('button-' + state) + ' ' + ref('button-tint') + ', ' + ref('button-bed') + ')';
export const primaryButtonInkRecipe = { className: 'caelos-primary-button-ink', base: {
  color: ref('button-foreground'), backgroundColor: buttonFill('default'),
  '&:is(:hover, :focus-visible):not(:active, :disabled, [data-state=success])': {
    color: ref('button-focus-foreground'), backgroundColor: ref('button-bed'), boxShadow: glow('button'),
  },
  '&:active:not(:disabled)': {backgroundColor: buttonFill('pressed')},
  '&[data-state=success]:not(:active, :disabled)': {backgroundColor: buttonFill('success')},
  '&:disabled': { color: ref('button-disabled-foreground'), backgroundColor: ref('button-disabled-bed') },
} };
export const controlPreset = {
  name: 'caelos-controls', presets: [materialPreset],
  globalCss: { ...materialPreset.globalCss, ':root, [data-theme="dark"]': { ...materialPreset.globalCss[':root, [data-theme="dark"]'], ...writer.values } },
  theme: { extend: { recipes: { fieldSurface: fieldSurfaceRecipe, primaryButtonInk: primaryButtonInkRecipe } } },
};
