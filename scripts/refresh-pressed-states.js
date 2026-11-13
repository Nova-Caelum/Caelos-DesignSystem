// Targeted refresh: preserve existing surfaces, geometry, other states and user edits.
// Evaluate the construction label helpers from primitive-sheet.js first.
async function refreshPressedStates(figma, manifest) {
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  await figma.setCurrentPageAsync(page);
  const variables = await figma.variables.getLocalVariablesAsync();
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const changed = new Set(), audit = [], screenshots = [];
  const load = async node => {
    for (const s of node.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(s.fontName);
  };
  const text = async (node, value) => {
    if (node.characters === value) return;
    await load(node); node.characters = value; changed.add(node.id);
  };
  const collect = (value, ids) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'VARIABLE_ALIAS') ids.add(value.id);
    else Object.values(value).forEach(child => collect(child, ids));
  };
  for (const [style, sourceId, categoryKey] of [
    ['tonal','377:6413','buttons'], ['text','377:6426','buttons'], ['chip','474:1024','chips'],
  ]) {
    const category = manifest.categories.find(c => c.key === categoryKey);
    const study = category.studies.find(s => s.id === sourceId);
    const source = await figma.getNodeByIdAsync(sourceId);
    const root = page.children.find(n => n.name === 'Category / ' + category.title);
    const paint = style === 'chip' ? manifest.compactControls.chipPaints.pressed : manifest.buttonStatePaints[style].pressed;
    const foreground = variables.find(v => v.name === paint.foreground.name && collections.find(c => c.id === v.variableCollectionId)?.name === paint.foreground.collection);
    if (!foreground) throw Error('Missing catalog foreground: ' + paint.foreground.name);
    const decoration = manifest.buttonStateDecorations[style]?.pressed ?? 'none';
    const targets = source.children.filter(n => n.variantProperties.State === 'Pressed');
    const instances = [];
    for (const node of root.findAllWithCriteria({types:['INSTANCE']})) {
      const master = await node.getMainComponentAsync();
      if (targets.some(t => t.id === master.id)) instances.push(node);
    }
    source.description = study.note; changed.add(source.id);
    for (const node of [...targets, ...instances]) {
      const label = node.findAllWithCriteria({types:['TEXT']}).find(n => n.name === 'Label');
      await load(label);
      label.fills = label.fills.map(p => figma.variables.setBoundVariableForPaint(p, 'color', foreground));
      label.textDecoration = decoration.toUpperCase();
      for (const item of [node, label]) {
        item.effects = item.effects.filter(e => e.type !== 'DROP_SHADOW'); changed.add(item.id);
      }
      if (node.type === 'COMPONENT') node.description = study.note + '\nState: Pressed. Static review specimen.';
      if (node.type === 'INSTANCE') {
        const card = node.parent.parent;
        const annotation = card.children.find(n => n.type === 'TEXT' && /^(State construction|Construction)\n/.test(n.characters));
        const ids = new Set();
        for (const n of [node, ...node.findAll(() => true)]) {
          collect(n.boundVariables, ids);
          for (const prop of ['fills','strokes','effects']) if (prop in n) collect(n[prop], ids);
        }
        const ingredients = Object.values(manifest.constructionTokens);
        const shared = new Set(study.sharedConstructionPaths.map(path => ingredients.find(t => t.path === path)).filter(Boolean).map(constructionTokenLabel));
        const lines = new Set([...ids].map(id => constructionBindingLabel(variables.find(v => v.id === id), manifest, collections)).filter(line => !shared.has(line)));
        for (const item of Object.values(paint)) lines.add(constructionTokenLabel(item));
        if (decoration !== 'none') lines.add('Text decoration · ' + decoration + ' · recipe behavior');
        lines.add('Pressed glow · none');
        if (style !== 'text') lines.add('Runtime only · glass saturation and adaptive overlap; static Figma specimen.');
        await text(annotation, 'State construction\n' + [...lines].sort().join('\n'));
        if (screenshots.length < 3 && !screenshots.some(s => s.style === style)) screenshots.push({style,id:card.parent.id});
      }
      const actual = label.fills[0];
      if (actual.boundVariables?.color?.id !== foreground.id || label.textDecoration !== decoration.toUpperCase()) throw Error('Pressed binding failed: ' + node.id);
      audit.push({id:node.id,style,name:node.name,foreground:foreground.name,decoration,effects:node.effects.map(e=>e.type),labelEffects:label.effects.length});
    }
    for (const family of root.children.filter(n => n.name.startsWith('Family / ' + study.name + ' / '))) {
      const note = family.children[0].children.find(n => n.type === 'TEXT' && /^\d+ variants\n/.test(n.characters));
      await text(note, note.characters.split('\n')[0] + '\n' + study.note);
    }
  }
  // Annotations can change section height; retain the existing three-column layout.
  const roots = page.children.filter(n => n.name.startsWith('Category / '));
  for (const x of new Set(roots.map(n => n.x))) {
    const column = roots.filter(n => n.x === x).sort((a,b) => a.y-b.y);
    let y = column[0].y;
    for (const root of column) {if (root.y !== y) {root.y = y; changed.add(root.id);} y = root.y + root.height + 100;}
  }
  return {createdNodeIds:[],mutatedNodeIds:[...changed],audit,screenshots};
}
