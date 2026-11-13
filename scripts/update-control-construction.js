// Evaluate primitive-sheet.js first. Updates existing clean-sheet labels in place.
// Paint/radius aliases on button specimens are replaced only when their stored
// alias is exactly the catalog's lower-tier reference; no value matching guesses.
async function updateControlConstruction(manifest) {
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const all = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(all.map(v => [v.id, v]));
  const byName = new Map(all.map(v => [collections.find(c => c.id === v.variableCollectionId).name + '/' + v.name, v]));
  const buttons = manifest.categories.find(c => c.key === 'buttons');
  const replacements = new Map();
  for (const item of buttons.rows.flatMap(r => r.items)) {
    const old = byName.get('02 Control recipes/' + item.name);
    const target = byName.get(item.construction.collection + '/' + item.construction.name);
    if (!old || !target) throw Error('Missing variable for ' + item.path);
    if (!Object.values(old.valuesByMode).every(v => v.type === 'VARIABLE_ALIAS' && v.id === target.id)) throw Error('Catalog binding mismatch: ' + item.path);
    replacements.set(old.id, target);
  }
  const roots = page.children.filter(n => n.name.startsWith('Category / '));
  const texts = roots.flatMap(n => n.findAllWithCriteria({types:['TEXT']}));
  const masters = [];
  for (const study of buttons.studies) masters.push(await figma.getNodeByIdAsync(study.id));
  const buttonRoot = roots.find(n => n.name === 'Category / Buttons');
  const instances = buttonRoot.findAllWithCriteria({types:['INSTANCE']});
  const nodes = [...masters, ...instances].flatMap(n => [n,...n.findAll(() => true)]);
  const fonts = [...texts, ...nodes.filter(n => n.type === 'TEXT')].flatMap(t => t.getStyledTextSegments(['fontName']).map(s => s.fontName));
  for (const f of new Map(fonts.map(f => [JSON.stringify(f), f])).values()) await figma.loadFontAsync(f);
  const changed = new Set();
  let bindingsChanged = 0;
  for (const n of new Map(nodes.map(n => [n.id,n])).values()) {
    for (const [prop, alias] of Object.entries(n.boundVariables ?? {})) {
      const target = alias?.type === 'VARIABLE_ALIAS' && replacements.get(alias.id);
      if (target) {n.setBoundVariable(prop, target);changed.add(n.id);bindingsChanged++;}
    }
    for (const prop of ['fills','strokes']) {
      if (!(prop in n) || !Array.isArray(n[prop])) continue;
      let count = 0;
      const paints = n[prop].map(p => {
        const target = replacements.get(p.boundVariables?.color?.id);
        if (!target) return p;
        count++;
        return figma.variables.setBoundVariableForPaint(p, 'color', target);
      });
      if (count) {n[prop]=paints;changed.add(n.id);bindingsChanged+=count;}
    }
  }
  const items = new Map(manifest.categories.flatMap(c => c.rows.flatMap(r => r.items)).map(i => [i.path,i]));
  let labelsChanged=0;
  for (const t of texts.filter(t => t.characters.startsWith('Construction\n'))) {
    const siblings = t.parent.children;
    const catalogText = siblings.find(n => n.type === 'TEXT' && n.characters.includes('\nCatalog · '));
    let label;
    if (catalogText) {
      const item = items.get(catalogText.characters.split('\nCatalog · ')[1]);
      if (!item) throw Error('Unmapped catalog card ' + t.id);
      label = constructionTokenLabel(item.construction);
    } else {
      const specimen = siblings.find(n => n.name === 'Specimen');
      if (!specimen) continue;
      const ids = new Set();
      function collect(x) {if (!x || typeof x !== 'object') return; if(x.type === 'VARIABLE_ALIAS') ids.add(x.id);else for(const v of Object.values(x)) collect(v);}
      for (const n of specimen.findAll(() => true)) {
        collect(n.boundVariables);
        if ('fills' in n && Array.isArray(n.fills)) for(const p of n.fills) collect(p.boundVariables);
        if ('effects' in n) for(const e of n.effects) collect(e.boundVariables);
      }
      label = [...new Set([...ids].map(id => constructionBindingLabel(byId.get(id),manifest,collections)))].sort().join('\n') || 'No variable binding found';
    }
    const next = 'Construction\n' + label;
    if(t.characters !== next) {t.characters=next;changed.add(t.id);labelsChanged++;}
  }
  // Keep dimensions and review notes tied to the specimens and current catalog.
  function setText(node,value){if(node && node.characters!==value){node.characters=value;changed.add(node.id);labelsChanged++;}}
  for(const category of manifest.categories){
    const root=roots.find(n=>n.name==='Category / '+category.title);
    for(const family of root.children.filter(n=>n.name.startsWith('Family / '))){
      const identity=family.children.find(n=>n.name==='Identity and construction');
      const note=identity?.children.find(n=>n.type==='TEXT'&&n.characters.includes(' variants\n'));
      const name=family.name.slice('Family / '.length);
      const study=category.studies.find(s=>name===s.name||name.startsWith(s.name+' / '));
      if(study){const count=family.findAll(n=>n.name==='Specimen').length;setText(note,count+' variants\n'+study.note);}
      const entry=category.pending?.find(e=>e.name===name);
      const card=entry&&family.findAll(n=>n.name==='Variant / '+entry.path)[0];
      if(card){
        setText(note,'1 variants\nCatalog inventory · '+entry.status+'\nNo complete recipe implied');
        setText(card.children[1],entry.status.toUpperCase());
        setText(card.children[2],entry.status.toUpperCase());
        setText(card.children.find(n=>n.type==='TEXT'&&n.characters.startsWith('Construction · ')),'Construction · '+(entry.note||'Lower-tier recipe mapping is still open.')+'\nPanda · '+(entry.recipe||'No complete recipe export'));
      }
    }
    for(const specimen of root.findAll(n=>n.name==='Specimen')){
      const card=specimen.parent;
      if(!card.children.some(n=>n.type==='TEXT'&&n.characters.includes('\nSource · ')))continue;
      const instance=specimen.children[0];
      if(instance)setText(card.children[1],Math.round(instance.width*100)/100+' × '+Math.round(instance.height*100)/100+' px');
    }
  }
  // Keep each existing category in its column after label text reflows.
  for (const x of new Set(roots.map(n => n.x))) {
    const column = roots.filter(n => n.x === x).sort((a,b) => a.y-b.y);
    let y=column[0].y;
    for(const n of column) {if(n.y!==y){n.y=y;changed.add(n.id);}y=n.y+n.height+100;}
  }
  return {mutatedNodeIds:[...changed],bindingsChanged,labelsChanged};
}
