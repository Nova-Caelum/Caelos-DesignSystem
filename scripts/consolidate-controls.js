// Evaluate with the current control-sheet manifest and the reviewed gallery IDs.
// Archives obsolete review rows; preserves component instances and their states.
async function consolidateControlGallery(manifest, ids) {
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  await figma.setCurrentPageAsync(page);
  const mutated = new Set();
  const get = async id => {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw Error('Missing reviewed node ' + id);
    return node;
  };
  const fonts = page.findAllWithCriteria({types:['TEXT']}).flatMap(t => t.getStyledTextSegments(['fontName']).map(s => s.fontName));
  for (const f of new Map(fonts.map(f => [JSON.stringify(f), f])).values()) await figma.loadFontAsync(f);
  function change(node, value) {
    if (node.characters === value) return;
    node.characters = value;
    mutated.add(node.id);
  }
  const archive = await get(ids.archive);
  let archiveY = Math.max(13000, ...archive.children.map(n => n.y + n.height + 100));
  for (const id of ids.obsoleteRows) {
    const row = await get(id);
    if (row.parent.id === archive.id) continue;
    archive.appendChild(row); row.x = 100; row.y = archiveY;
    archiveY += row.height + 100;
    mutated.add(row.id); mutated.add(archive.id);
  }
  for (const key of ['buttons','chips','badges']) {
    const category = manifest.categories.find(c => c.key === key);
    const root = await get(ids.categories[key]);
    change(root.children[1], category.purpose);
    for (const study of category.studies) {
      const names = new Set(study.sharedConstructionPaths.map(path => Object.values(manifest.constructionTokens).find(t => t.path === path)).filter(Boolean).map(constructionTokenLabel));
      for (const row of root.children.filter(n => n.name.startsWith('Family / ' + study.name + ' / '))) {
        const identity = row.children[0];
        const description = identity.children.filter(n => n.type === 'TEXT')[1];
        change(description, description.characters.split('\n')[0] + '\n' + study.note);
        for (const t of row.findAllWithCriteria({types:['TEXT']})) {
          if (!/^(State construction|Construction)\n/.test(t.characters)) continue;
          const lines = t.characters.split('\n').slice(1).filter(line => !names.has(line));
          change(t, 'State construction\n' + (lines.join('\n') || 'Shared construction only'));
        }
      }
    }
  }
  const delivery = manifest.categories.find(c => c.key === 'badges').pending[0];
  const values = [delivery.name, '1 use case\nCatalog inventory · partial\nUses the shared Badge recipe', delivery.path, 'PARTIAL', 'PARTIAL', delivery.description, 'Variants and states\nBadge shapes and tones\nNo interactive states', 'Construction · ' + delivery.note + '\nPanda · No complete recipe export'];
  for (let i = 0; i < ids.deliveryTexts.length; i++) change(await get(ids.deliveryTexts[i]), values[i]);
  const deliveryRow = await get(ids.deliveryRow);
  deliveryRow.name = 'Family / Delivery status badge'; mutated.add(deliveryRow.id);
  const shared = await get(ids.shared);
  shared.x = 100; shared.y = 100; mutated.add(shared.id);
  const bounds = [{id:shared.id,x:shared.x,y:shared.y,width:shared.width,height:shared.height}];
  for (let column = 0; column < ids.columns.length; column++) {
    let y = shared.y + shared.height + 100;
    for (const id of ids.columns[column]) {
      const root = await get(id); root.x = 100 + column * 1836; root.y = y;
      y += root.height + 100; mutated.add(root.id);
      bounds.push({id:root.id,x:root.x,y:root.y,width:root.width,height:root.height});
    }
  }
  return {mutatedNodeIds:[...mutated],createdNodeIds:[],bounds,archivedRows:ids.obsoleteRows};
}
