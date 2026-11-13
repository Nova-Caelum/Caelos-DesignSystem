// Select shared recipe configuration without creating same-tier token aliases.
// The expanded model exposes only direct lower-tier references to renderers.
export function resolveControlCatalog(source) {
  const result = structuredClone(source);
  const extension = value => value.$extensions['app.caelos'];
  const shared = extension(result.controls).sharedConstruction;
  const parameter = selection => {
    const [group, choice, extra] = selection.split('/');
    const value = shared.parameters[group]?.[choice];
    if (extra || !value) throw new Error('Unknown shared construction choice: ' + selection);
    return value;
  };
  const paint = selection => {
    const value = shared.paints[selection];
    if (!value) throw new Error('Unknown shared appearance: ' + selection);
    return structuredClone(value);
  };
  const mapValues = (values, resolve) => Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolve(value)])
  );
  for (const name of ['button', 'chip', 'badge']) {
    const entry = result.controls.shared[name];
    const meta = extension(entry);
    meta.construction = mapValues(meta.construction, parameter);
    if (meta.shapeRadii) meta.shapeRadii = mapValues(meta.shapeRadii, parameter);
    if (name === 'button') meta.statePaints = mapValues(meta.statePaints, states => mapValues(states, paint));
    if (name === 'chip') meta.statePaints = mapValues(meta.statePaints, paint);
  }
  return result;
}
