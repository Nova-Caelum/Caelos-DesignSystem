// Runs inside Figma. The caller supplies only catalog data for the target library.
async function libraryVariables(plan, apply) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(variables.map(v => [v.id, v]));
  const owned = new Map();
  const qualified = (collection, name) => collection + '/' + name;
  const expected = new Map();
  for (const spec of plan) {
    const matches = collections.filter(c => c.name === spec.name || c.name === 'Caelos Draft / ' + spec.name);
    if (matches.length > 1) throw Error('Ambiguous collection ' + spec.name);
    const c = matches[0] || (apply && figma.variables.createVariableCollection(spec.name));
    if (!c) continue;
    owned.set(c.id, c);
    if (apply) {
      c.name = spec.name;
      if (c.modes[0].name === 'Draft' || c.modes[0].name === 'Mode 1') c.renameMode(c.defaultModeId, spec.modes[0]);
      for (const mode of spec.modes) if (!c.modes.some(m => m.name === mode)) c.addMode(mode);
    }
    for (const row of spec.variables) {
      let v = variables.find(v => v.variableCollectionId === c.id && v.name === row.name);
      if (!v && apply) {
        const old = {'color/golden-sand':'color/gold','color/peach-gold':'color/peach'}[row.name];
        v = variables.find(v => v.variableCollectionId === c.id && v.name === old);
        if (v) v.name = row.name;
        else v = figma.variables.createVariable(row.name, c, row.type);
        byId.set(v.id, v);
      }
      if (!v) continue;
      if (apply && v.resolvedType !== row.type) throw Error('Incompatible type for ' + row.name);
      expected.set(qualified(spec.name,row.name), v);
    }
  }
  function normal(value) {
    if (value && value.type === 'VARIABLE_ALIAS') {
      const target = byId.get(value.id);
      if (!target) return {alias: value.id};
      const group = collections.find(c => c.id === target.variableCollectionId) || owned.get(target.variableCollectionId);
      return {alias: qualified(group ? group.name : target.variableCollectionId,target.name)};
    }
    if (value && typeof value === 'object') return [value.r,value.g,value.b,value.a];
    return value;
  }
  if (apply) for (const spec of plan) {
    const c = [...owned.values()].find(c => c.name === spec.name);
    for (const row of spec.variables) {
      const v = expected.get(qualified(spec.name,row.name));
      for (const mode of c.modes) {
        if (!spec.modes.includes(mode.name)) continue;
        const value = row.values[mode.name];
        const before = v.valuesByMode[mode.modeId];
        // Normal Figma modes require a value. Leave unspecified roles untouched;
        // the independent comparison reports their actual values as drift.
        if (value === undefined) continue;
        if (JSON.stringify(normal(before)) === JSON.stringify(value)) continue;
        let raw = value;
        if (value.alias) {
          const target = expected.get(value.alias);
          if (!target) throw Error('Missing alias ' + value.alias);
          raw = figma.variables.createVariableAlias(target);
        } else if (row.type === 'COLOR') raw = {r:value[0],g:value[1],b:value[2],a:value[3]};
        v.setValueForMode(mode.modeId,raw);
      }
    }
  }
  const result = [];
  for (const c of owned.values()) {
    const rows = [];
    for (const v of byId.values()) if (v.variableCollectionId === c.id) {
      const values = {};
      for (const mode of c.modes) {
        const value = v.valuesByMode[mode.modeId];
        if (value !== undefined) values[mode.name] = normal(value);
      }
      rows.push({name:v.name,type:v.resolvedType,values});
    }
    result.push({name:c.name,modes:c.modes.map(m=>m.name),variables:rows});
  }
  return result;
}
