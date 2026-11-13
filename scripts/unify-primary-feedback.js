// Evaluate primitive-sheet.js first and pass control-sheet.py's current manifest.
// Retain source, variant and review-card IDs; only the active Clean page is changed.
async function unifyPrimaryFeedback(figma, manifest) {
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  await figma.setCurrentPageAsync(page);
  const category = manifest.categories.find(c => c.key === 'buttons');
  const study = category.studies.find(s => s.name === 'Primary');
  const source = await figma.getNodeByIdAsync(study.id);
  const root = page.children.find(n => n.name === 'Category / Buttons');
  const fonts = page.findAllWithCriteria({types:['TEXT']}).flatMap(t => t.getStyledTextSegments(['fontName']).map(s => s.fontName));
  for (const font of new Map(fonts.map(f => [JSON.stringify(f), f])).values()) await figma.loadFontAsync(font);
  const createdNodeIds = [], mutatedNodeIds = [];
  for (const motion of ['Normal', 'Reduced']) {
    const states = Object.fromEntries(source.children.filter(n => n.variantProperties.Motion === motion).map(n => [n.variantProperties.State, n]));
    const {Default:rest, Hover:hover, Pressed:pressed, Focus:focus} = states;
    const glow = focus.children.find(n => n.name === 'Surface-edge glow');
    const target = hover.children.find(n => ['Action tint','Surface-edge glow'].includes(n.name));
    target.name = glow.name;
    for (const key of ['fills','effects','opacity','x','y']) target[key] = glow[key];
    target.resize(glow.width, glow.height);
    target.setBoundVariable('opacity', await figma.variables.getVariableByIdAsync(glow.boundVariables.opacity.id));
    if (!hover.children.some(n => n.name === 'Focus bed')) {
      const bed = focus.children.find(n => n.name === 'Focus bed').clone();
      hover.insertChild(1, bed);
      createdNodeIds.push(bed.id);
    }
    const label = hover.children.find(n => n.type === 'TEXT');
    label.fills = focus.children.find(n => n.type === 'TEXT').fills;
    mutatedNodeIds.push(hover.id, target.id, label.id);
    // Remove misleading success transitions. Existing hover/focus links are retained.
    // The Figma connector currently rejects new CHANGE_TO destinations in this set.
    await rest.setReactionsAsync([]);
    await pressed.setReactionsAsync([]);
    mutatedNodeIds.push(rest.id, pressed.id);
    states.Success.description = 'Optional confirmed-result preview: save, send, or another completed operation whose result is not immediately visible. Never an automatic stage after a click or a menu opening.';
    mutatedNodeIds.push(states.Success.id);
  }
  source.description = 'Primary button: Hover and Focus share blue foreground and a soft surface-edge glow. Pressed acknowledges activation immediately. Success is optional actual-result confirmation. Prototype wiring is partial; press/release, runtime keyboard behavior and timing remain unverified.';
  mutatedNodeIds.push(source.id);
  const variables = await figma.variables.getLocalVariablesAsync();
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const family of root.children.filter(n => n.name.startsWith('Family / Primary /'))) {
    const identity = family.children.find(n => n.name === 'Identity and construction');
    const note = identity.children.find(n => n.type === 'TEXT' && n.characters.includes('Partial recipe'));
    note.characters = '6 variants\n' + study.note;
    mutatedNodeIds.push(note.id);
    for (const instance of family.findAllWithCriteria({types:['INSTANCE']})) {
      const master = await instance.getMainComponentAsync();
      if (master?.variantProperties.State !== 'Hover') continue;
      const bindings = new Set();
      const collect = x => {if (x && typeof x === 'object') {if (x.type === 'VARIABLE_ALIAS') bindings.add(x.id);else Object.values(x).forEach(collect);}};
      for (const node of [instance,...instance.findAll(()=>true)]) {
        collect(node.boundVariables);
        if ('fills' in node) collect(node.fills);
        if ('effects' in node) collect(node.effects);
      }
      const names = [...new Set([...bindings].map(id => constructionBindingLabel(variables.find(v => v.id === id),manifest,collections)))].sort();
      const card = instance.parent.parent;
      const text = card.children.find(n => n.type === 'TEXT' && n.characters.startsWith('Construction\n'));
      text.characters = 'Construction\n' + names.join('\n');
      mutatedNodeIds.push(text.id,instance.id);
    }
  }
  return {createdNodeIds, mutatedNodeIds:[...new Set(mutatedNodeIds)], removedNodeIds:[], sourceId:source.id, reviewId:root.id};
}
