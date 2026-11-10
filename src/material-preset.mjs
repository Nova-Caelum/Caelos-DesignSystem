import foundations from '../token_catalog/00-foundations.tokens.json' with { type: 'json' };
import dark from '../token_catalog/00-semantic.dark.tokens.json' with { type: 'json' };
import light from '../token_catalog/00-semantic.light.tokens.json' with { type: 'json' };
import primitives from '../token_catalog/01-primitives.tokens.json' with { type: 'json' };

const { glass, graph, surface } = primitives.primitives.shared;
const auto = surface.$extensions['app.caelos'].autoTexture;
const ref = (name) => `var(--caelos-material-${name})`;

function themeVars(semantic) {
  const roots = { ...foundations, ...semantic };
  function resolve(token) {
    const v = token.$value;
    if (typeof v === 'string') return resolve(v.slice(1, -1).split('.').reduce((node, part) => node[part], roots));
    if (token.$type === 'color') return v.hex;
    return token.$type === 'dimension' ? `${v.value}${v.unit}` : v;
  }
  const values = {};
  function add(name, token, percentage = false) {
    const v = resolve(token);
    values['--caelos-material-' + name] = percentage ? (v * 100) + '%' : String(v);
  }
  for (const name of ['body', 'foreground', 'tint-ink', 'sage', 'sage-blur', 'overlap-clear', 'overlap-covered', 'saturation-neutral']) add(name, glass[name]);
  add('sage-opacity', glass['sage-opacity'], true);
  add('falloff-at', glass['falloff-at'], true);
  for (const kind of ['panel', 'menu']) {
    for (const [prop, token] of Object.entries(glass[kind])) {
      add(kind + '-' + prop, token, prop === 'base-alpha' || prop === 'tint');
    }
    values['--caelos-material-' + kind + '-end'] = (resolve(glass[kind].tint) * resolve(glass['falloff-strength']) * 100) + '%';
  }
  for (const name of ['ink', 'line', 'pitch', 'opacity']) add('graph-' + name, graph[name], name === 'opacity');
  for (const [name, token] of Object.entries(surface.layer)) {
    // Only ground has an approved light layer; use the light material body for open layers.
    add('layer-' + name, semantic.sys.color[name] ? token : glass.body);
  }
  return values;
}

const mix = (ink, amount) => `color-mix(in srgb, ${ink} ${amount}, transparent)`;
const layerInk = 'var(--caelos-surface-layer)';
const plain = { backgroundColor: layerInk, backgroundImage: 'none', backdropFilter: 'none' };
const lineInk = mix(ref('graph-ink'), ref('graph-opacity'));
const rule = `${lineInk} ${ref('graph-line')}, transparent ${ref('graph-line')}`;
const grid = {
  ...plain, backgroundImage: `linear-gradient(to right, ${rule}), linear-gradient(to bottom, ${rule})`,
  backgroundSize: `${ref('graph-pitch')} ${ref('graph-pitch')}`,
};
const opaque = (fill) => ({ backgroundColor: fill, backgroundImage: 'none', backdropFilter: 'none' });
function glassStyle(kind) {
  const role = (k) => ref(kind + '-' + k);
  const sage = kind === 'sage';
  const fill = sage ? ref('sage') : ref('body');
  const fallback = opaque(fill);
  const input = surface.$extensions['app.caelos'].backdropOverlap.input;
  const overlap = `clamp(${ref('overlap-clear')}, var(${input}), ${ref('overlap-covered')})`;
  const neutral = ref('saturation-neutral');
  const filter = `blur(calc(${role('blur')} * ${overlap})) saturate(calc(${neutral} + (${role('saturation')} - ${neutral}) * ${overlap}))`;
  return {
    backgroundColor: mix(fill, sage ? ref('sage-opacity') : role('base-alpha')),
    backgroundImage: sage ? 'none' : `linear-gradient(to right, ${mix(ref('tint-ink'), role('tint'))}, ${mix(ref('tint-ink'), role('end'))} ${ref('falloff-at')})`,
    backdropFilter: sage ? `blur(${ref('sage-blur')})` : filter,
    '@media (prefers-reduced-transparency: reduce)': fallback,
    '@supports not (backdrop-filter: none)': fallback,
  };
}
const panel = glassStyle('panel');
const autoProps = {backgroundColor: 'fill', backgroundImage: 'image', backgroundSize: 'size', backdropFilter: 'filter'};
function autoVars(style) {
  return Object.fromEntries(Object.entries(style).map(([key, value]) =>
    key.startsWith('@') ? [key, autoVars(value)] : ['--caelos-auto-' + autoProps[key], value]));
}
export const materialRecipe = {
  className: 'caelos-material',
  base: { color: ref('foreground'), [surface.$extensions['app.caelos'].backdropOverlap.input]: ref('overlap-covered') },
  variants: {
    layer: Object.fromEntries(Object.entries(auto).map(([name, finish]) => [name, {
      '--caelos-surface-layer': ref('layer-' + name),
      ...autoVars(finish === 'graph' ? grid : { backgroundSize: 'auto', ...panel }),
    }])),
    texture: {
      auto: Object.fromEntries(Object.entries(autoProps).map(([property, name]) => [property, 'var(--caelos-auto-' + name + ')'])),
      plain, graph: grid, glass: panel, portal: glassStyle('menu'), sage: glassStyle('sage'),
    },
  },
  defaultVariants: surface.$extensions['app.caelos'].defaultVariants,
};
export const materialPreset = {
  name: 'caelos-materials',
  globalCss: { ':root, [data-theme="dark"]': themeVars(dark), '[data-theme="light"]': themeVars(light) },
  theme: { extend: { recipes: { material: materialRecipe } } },
};
