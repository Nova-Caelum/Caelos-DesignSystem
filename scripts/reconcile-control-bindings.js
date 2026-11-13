// Explicit audited mappings only. No fuzzy matching, global variable edits, or deletion.
async function reconcileControlBindings(manifest, plan, apply = false) {
  const page=await figma.getNodeByIdAsync(manifest.pageId);
  if(figma.currentPage.id!==page.id)await figma.setCurrentPageAsync(page);
  const collections=await figma.variables.getLocalVariableCollectionsAsync();
  const all=await figma.variables.getLocalVariablesAsync();
  const byName=new Map(all.map(v=>[collections.find(c=>c.id===v.variableCollectionId).name+'/'+v.name,v]));
  const ingredients=new Map(Object.values(manifest.constructionTokens).map(i=>[i.path,i]));
  const replacements=new Map();
  const nodes=new Map();
  for(const category of manifest.categories){
    for(const study of category.studies){const n=await figma.getNodeByIdAsync(study.id);if(!n)throw Error('Missing study '+study.id);for(const x of [n,...n.findAll(()=>true)])nodes.set(x.id,x);}
    const root=page.children.find(n=>n.name==='Category / '+category.title);
    if(!root)throw Error('Missing category '+category.title);
    for(const v of root.findAll(n=>n.name==='Specimen'))for(const n of v.findAll(()=>true))nodes.set(n.id,n);
  }
  const consumer=[...nodes.values()].find(n=>n.type==='COMPONENT');
  function same(a,b){if(typeof a==='number' && typeof b==='number')return Math.abs(a-b)<0.000001;if(a&&b&&typeof a==='object'&&typeof b==='object')return ['r','g','b'].every(k=>same(a[k],b[k]))&&same(a.a??1,b.a??1);return a===b;}
  for(const row of plan.mappings){
    const ingredient=ingredients.get(row.target);
    const source=byName.get(row.collection+'/'+row.name);
    const target=ingredient&&byName.get(ingredient.collection+'/'+ingredient.name);
    if(!source||!target)throw Error('Missing mapping '+row.name+' → '+row.target);
    const old=source.resolveForConsumer(consumer).value,next=target.resolveForConsumer(consumer).value;
    if(!same(old,row.expected??next))throw Error('Unaudited source value '+row.name+': '+JSON.stringify(old));
    if(source.resolvedType!==target.resolvedType)throw Error('Type mismatch '+row.name);
    replacements.set(source.id,target);
  }
  // Plan all scalar/text/paint edits before any mutation. Mixed text is preserved.
  const edits=[];
  for(const n of nodes.values()){
    for(const [prop,binding] of Object.entries(n.boundVariables??{})){
      if(['fills','strokes','effects'].includes(prop))continue;
      const aliases=Array.isArray(binding)?binding:[binding];
      const matches=aliases.map(a=>replacements.get(a?.id));
      if(!matches.some(Boolean))continue;
      if(Array.isArray(binding)){
        if(n.type!=='TEXT'||matches.some(v=>!v)||new Set(matches.map(v=>v.id)).size!==1)throw Error('Mixed binding needs manual review '+n.id+'/'+prop);
      }
      const target=matches[0];if(target)edits.push({n,prop,target});
    }
    for(const prop of ['fills','strokes']){
      if(!Array.isArray(n[prop]))continue;
      if(n[prop].some(p=>replacements.has(p.boundVariables?.color?.id)))edits.push({n,prop,paints:n[prop].map(p=>{const v=replacements.get(p.boundVariables?.color?.id);return v?figma.variables.setBoundVariableForPaint(p,'color',v):p;})});
    }
  }
  for(const row of plan.scopedMappings??[]){
    const ingredient=ingredients.get(row.target);
    const source=byName.get(row.collection+'/'+row.name);
    const target=ingredient&&byName.get(ingredient.collection+'/'+ingredient.name);
    if(!source||!target||source.resolvedType!==target.resolvedType||!same(source.resolveForConsumer(consumer).value,target.resolveForConsumer(consumer).value))throw Error('Invalid scoped mapping '+row.name);
    const category=manifest.categories.find(c=>c.key===row.category);
    const roots=[page.children.find(n=>n.name==='Category / '+category.title)];
    for(const study of category.studies)roots.push(await figma.getNodeByIdAsync(study.id));
    const scoped=new Map(roots.flatMap(r=>r.findAll(n=>n.type===row.nodeType)).map(n=>[n.id,n]));
    for(const n of scoped.values())for(const prop of row.properties)if(n.boundVariables?.[prop]?.id===source.id)edits.push({n,prop,target});
  }
  if(!apply)return {plannedEdits:edits.length,mappings:replacements.size,nodeCount:nodes.size};
  const fonts=[...nodes.values()].filter(n=>n.type==='TEXT').flatMap(n=>n.getStyledTextSegments(['fontName']).map(s=>s.fontName));
  for(const f of new Map(fonts.map(f=>[JSON.stringify(f),f])).values())await figma.loadFontAsync(f);
  const changed=new Set();
  for(const {n,prop,target,paints} of edits){
    if(paints)n[prop]=paints;
    else {n.setBoundVariable(prop,target);if(n.type==='TEXT'&&n.characters.length)n.setRangeBoundVariable(0,n.characters.length,prop,target);}
    changed.add(n.id);
  }
  return {mutatedNodeIds:[...changed],bindingsChanged:edits.length};
}
