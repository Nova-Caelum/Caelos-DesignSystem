// Figma migration: evaluate primitive-sheet.js first, then pass control-sheet.py's manifest.
// Only the active Tier 2 Clean library is changed; historical pages stay untouched.
async function consolidateTabs(figma, manifest) {
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  await figma.setCurrentPageAsync(page);
  const category = manifest.categories.find(c => c.key === 'tabs');
  const source = await figma.getNodeByIdAsync(category.studies[0].id);
  const root = page.children.find(n => n.name === 'Category / Tabs');
  const review = await figma.getNodeByIdAsync('377:6684');
  if (!source || !root || !review) throw Error('Inspect missing tab source or review category before retrying');
  const fonts = page.findAllWithCriteria({types:['TEXT']}).flatMap(t => t.getStyledTextSegments(['fontName']).map(s => s.fontName));
  for (const font of new Map(fonts.map(f => [JSON.stringify(f), f])).values()) await figma.loadFontAsync(font);
  const mutatedNodeIds = [], removedNodeIds = [];
  const remove = node => {
    removedNodeIds.push(node.id, ...('findAll' in node ? node.findAll(() => true).map(n => n.id) : []));
    node.remove();
  };
  const variants = [...source.children];
  const tonal = variants.filter(n => n.variantProperties.Appearance === 'Tonal');
  // Migrate references before removing variants, preserving selection/state and overrides.
  for (const old of tonal) {
    const target = variants.find(n => ['Standard','Filled'].includes(n.variantProperties.Appearance) && n.variantProperties.Selection === old.variantProperties.Selection && n.variantProperties.State === old.variantProperties.State);
    if (!target) throw Error('Missing Filled replacement for ' + old.name);
    for (const instance of await old.getInstancesAsync()) {
      let owner = instance;
      while (owner.parent && owner.type !== 'PAGE') owner = owner.parent;
      if (owner.id !== page.id) throw Error('Tab instance on another page requires inspection: ' + instance.id);
      instance.swapComponent(target);
      mutatedNodeIds.push(instance.id);
    }
  }
  for (const node of variants.filter(n => n.variantProperties.Appearance === 'Standard')) {
    node.name = node.name.replace('Appearance=Standard', 'Appearance=Filled');
    mutatedNodeIds.push(node.id);
  }
  for (const node of tonal) remove(node);
  // Existing retained IDs keep their prototype destinations and lower-tier bindings.
  const selections = ['Unselected','Selected'], states = ['Rest','Hover','Focus','Disabled'];
  for (const node of source.children) {
    const p = node.variantProperties;
    node.x = 30 + states.indexOf(p.State) * 176;
    node.y = 26 + ((p.Appearance === 'Underline' ? 2 : 0) + selections.indexOf(p.Selection)) * 86;
    mutatedNodeIds.push(node.id);
  }
  source.resize(source.width, 368);
  source.description = 'Tab · Filled and Underline. Selection: Unselected / Selected. States: Rest / Hover / Focus / Disabled. Geometry and typography use the shared lower-tier construction. Full Panda recipe and runtime keyboard navigation remain unverified.';
  mutatedNodeIds.push(source.id);
  for (const node of [...review.children]) {
    if (node.name === 'Tonal' || node.name.startsWith('Tonal ·')) remove(node);
  }
  for (const node of [review, ...review.findAll(() => true)]) {
    if (node.name.includes('Standard')) {node.name = node.name.replaceAll('Standard','Filled');mutatedNodeIds.push(node.id);}
    if (node.type === 'TEXT' && node.characters.includes('Standard')) {node.characters = node.characters.replaceAll('Standard','Filled');mutatedNodeIds.push(node.id);}
  }
  // Build a replacement before removing old review furniture, retaining the linked category ID.
  root.name = 'Tabs / replacing review furniture';
  let rendered;
  try { rendered = await renderPrimitiveCategory(category, manifest); }
  finally { root.name = 'Category / Tabs'; }
  const replacement = await figma.getNodeByIdAsync(rendered.id);
  for (const child of [...root.children]) remove(child);
  for (const child of [...replacement.children]) {root.appendChild(child);mutatedNodeIds.push(child.id);}
  remove(replacement);
  mutatedNodeIds.push(root.id, review.id);
  return {...rendered, id:root.id,
    createdNodeIds:rendered.createdNodeIds.filter(id => !removedNodeIds.includes(id)),
    mutatedNodeIds:[...new Set([...mutatedNodeIds,...rendered.mutatedNodeIds])].filter(id => !removedNodeIds.includes(id)),
    removedNodeIds, variants:source.children.map(n => ({id:n.id,name:n.name})),
    width:root.width,height:root.height};
}
