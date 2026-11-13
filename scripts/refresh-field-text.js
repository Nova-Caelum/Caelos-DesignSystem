// Evaluate primitive-sheet.js first; update existing field masters and their clean-sheet annotations.
async function refreshFieldText(figma, manifest) {
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  await figma.setCurrentPageAsync(page);
  const changed = new Set(), changedVariables = [];
  const fonts = new Map();
  for (const t of page.findAllWithCriteria({types:['TEXT']}))
    for (const s of t.getStyledTextSegments(['fontName'])) fonts.set(JSON.stringify(s.fontName), s.fontName);
  await Promise.all([...fonts.values()].map(f => figma.loadFontAsync(f)));
  const variables = await figma.variables.getLocalVariablesAsync();
  const byName = new Map(variables.map(v => [v.name, v]));
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const category = manifest.categories.find(c => c.key === 'fields');
  const gallery = page.children.find(n => n.name === 'Category / Fields');
  const items = category.rows.flatMap(r => r.items);
  const setText = (n, value) => { if (n.characters !== value) {n.characters = value; changed.add(n.id);} };
  const focusItem = items.find(i => i.path === 'controls.shared.input.focus-foreground');
  const primary = byName.get(focusItem.construction.name);
  if (!primary) throw Error('Missing primary text primitive');
  const collection = collections.find(c => c.name === '02 Control recipes');
  let focus = byName.get(focusItem.name);
  if (!focus) focus = figma.variables.createVariable(focusItem.name, collection, 'COLOR');
  focus.scopes = ['TEXT_FILL'];
  focus.setVariableCodeSyntax('WEB', 'var(' + focusItem.css + ')');
  for (const mode of collection.modes) focus.setValueForMode(mode.modeId, figma.variables.createVariableAlias(primary));
  byName.set(focus.name, focus);
  changedVariables.push(focus.id);
  const appended = await renderPrimitiveCategory(category, manifest, true);
  for (const id of appended.mutatedNodeIds) changed.add(id);
  for (const role of ['foreground','supporting-ink','hover-foreground','focus-foreground']) {
    const item = items.find(i => i.path === 'controls.shared.input.' + role);
    const variable = byName.get(item.name), target = byName.get(item.construction.name);
    if (!variable || !target) throw Error('Missing field role: ' + role);
    variable.name = item.name; byName.set(item.name, variable);
    for (const mode of Object.keys(variable.valuesByMode)) variable.setValueForMode(mode, figma.variables.createVariableAlias(target));
    changedVariables.push(variable.id);
    const path = gallery.findAllWithCriteria({types:['TEXT']}).find(t => t.characters.endsWith('\nCatalog · ' + item.path));
    const card = path.parent;
    setText(path, 'Figma · ' + item.name + '\nCatalog · ' + item.path);
    setText(card.children.find(t => t.type === 'TEXT' && t.characters.startsWith('Panda · ')), 'Panda · ' + (item.css ? 'var(' + item.css + ')' : 'No standalone token export'));
    setText(card.children[0], item.label);
    setText(card.children[1], item.value.hex.toUpperCase());
    setText(card.children.find(t => t.type === 'TEXT' && t.characters.startsWith('Construction\n')), 'Construction\n' + constructionTokenLabel(item.construction));
  }
  const source = await figma.getNodeByIdAsync(category.studies[0].id);
  const blue = byName.get('controls/shared/input/hover-foreground');
  const dim = byName.get('controls/shared/input/supporting-ink');
  for (const master of source.children) {
    const text = master.findAllWithCriteria({types:['TEXT']}).find(t => t.name === 'Field text');
    const state = master.variantProperties.State;
    const target = state === 'Focus' ? focus : state === 'Hover' ? blue : state === 'Rest' && master.variantProperties.Form === 'Search' ? dim : null;
    if (target) {text.fills = text.fills.map(p => figma.variables.setBoundVariableForPaint(p, 'color', target)); changed.add(text.id);}
  }
  setText(gallery.children[1], category.purpose);
  const evidence = [];
  for (const family of gallery.children.filter(n => n.name.startsWith('Family / Field / '))) {
    const note = family.children[0].children.find(n => n.type === 'TEXT' && /^\d+ variants\n/.test(n.characters));
    setText(note, note.characters.split('\n')[0] + '\n' + category.studies[0].note);
    for (const instance of family.findAllWithCriteria({types:['INSTANCE']})) {
      const master = await instance.getMainComponentAsync();
      if (master.parent.id !== source.id) continue;
      if (master.variantProperties.State === 'Focus') {
        const text = instance.findAllWithCriteria({types:['TEXT']}).find(t => t.name === 'Field text');
        text.fills = text.fills.map(p => figma.variables.setBoundVariableForPaint(p, 'color', focus));
        changed.add(text.id);
      }
      const bindings = new Set();
      const collect = x => {if (!x || typeof x !== 'object') return; if(x.type === 'VARIABLE_ALIAS') bindings.add(x.id); else for(const v of Object.values(x)) collect(v);};
      for (const n of [instance, ...instance.findAll(() => true)]) {
        collect(n.boundVariables);
        if ('fills' in n) collect(n.fills);
        if ('strokes' in n) collect(n.strokes);
        if ('effects' in n) collect(n.effects);
      }
      const labels = [];
      for (const id of bindings) labels.push(constructionBindingLabel(await figma.variables.getVariableByIdAsync(id), manifest, collections));
      const card = instance.parent.parent;
      const annotation = card.children.find(n => n.type === 'TEXT' && /^(State construction|Construction)\n/.test(n.characters));
      setText(annotation, annotation.characters.split('\n')[0] + '\n' + [...new Set(labels)].sort().join('\n'));
      const inks = instance.findAllWithCriteria({types:['TEXT']}).filter(t => ['Label','Field text','Description'].includes(t.name)).map(t => ({name:t.name,fill:t.fills}));
      evidence.push({id:instance.id,variant:master.name,inks});
    }
  }
  const composer = page.children.find(n => n.name === 'Category / Composer references');
  const y = gallery.y + gallery.height + 100;
  if(composer.y !== y) {composer.y = y; changed.add(composer.id);}
  return {createdNodeIds:appended.createdNodeIds,mutatedNodeIds:[...changed],changedVariables:[...new Set(changedVariables)],evidence};
}
