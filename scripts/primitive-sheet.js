// A construction card names its immediate lower-tier ingredient, not an alias trail.
function constructionTokenLabel(item) {
  const v = item.value;
  const value = v && typeof v === 'object' && !Array.isArray(v)
    ? (v.hex ? v.hex.toUpperCase() : v.value + ' ' + v.unit)
    : Array.isArray(v) ? v.join(', ') : String(v);
  const tier = item.path.startsWith('base.') || item.path.startsWith('sys.') ? 'T0' : 'T1';
  return item.name + ' · ' + value + ' · ' + tier;
}
function constructionBindingLabel(variable, manifest, collections) {
  const collection = collections.find(c => c.id === variable.variableCollectionId);
  const item = manifest.constructionTokens?.[collection?.name + '/' + variable.name];
  return item ? constructionTokenLabel(item) : variable.name + (manifest.tier === 2 ? ' · NOT IN CATALOG' : '');
}
// Figma Plugin API renderer shared by the catalog-derived primitive and control sheets.
// Evaluate glyph-fit.js first; icon generation includes fitting and measured labels.
// Page furniture follows foundation-sheet.js. Furniture dimensions are not product tokens.
async function renderPrimitiveCategory(category, manifest, appendMissingTokens = false) {
  if (category.key === 'icon' && (typeof fitGlyphGallery !== 'function' || typeof updateGlyphLabels !== 'function' || !manifest.glyphFit)) throw Error('Load glyph-fit.js and the current manifest before rendering icons');
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  if(figma.currentPage.id!==page.id)await figma.setCurrentPageAsync(page);
  const existingRoot = page.children.find(n => n.name === 'Category / ' + category.title);
  if (existingRoot && !appendMissingTokens) throw Error('Category already exists; inspect before replacing');
  if (appendMissingTokens && !existingRoot) throw Error('Missing category to extend');
  const fonts = [{family:'Caelum Sans',style:'Regular'},{family:'Caelum Sans',style:'Medium'},{family:'Caelum Sans',style:'SemiBold'}];
  for (const t of page.findAllWithCriteria({types:['TEXT']})) fonts.push(...t.getStyledTextSegments(['fontName']).map(s=>s.fontName));
  for (const f of new Map(fonts.map(f=>[JSON.stringify(f),f])).values()) await figma.loadFontAsync(f);
  const all = await figma.variables.getLocalVariablesAsync();
  const variables = new Map(all.map(v=>[v.name,v]));
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const base = collections.find(c=>c.name==='00 Base');
  const semantic = collections.find(c=>c.name==='01 Semantic');
  const dark = semantic.modes.find(m=>m.name==='Dark');
  const ids = [], specimens = [], gaps = [], mutatedNodeIds = [];
  const paint = name => {
    const v=variables.get(name); if(!v) throw Error('Missing variable '+name);
    const {r,g,b,a=1}=v.resolveForConsumer(page.children[0]).value;
    return figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r,g,b},opacity:a},'color',v);
  };
  function frame(parent,name,width,axis='VERTICAL') {
    const n=figma.createAutoLayout(axis);ids.push(n.id);n.name=name;n.fills=[];n.itemSpacing=12;n.resize(width,1);parent.appendChild(n);
    n.layoutSizingHorizontal='FIXED';n.layoutSizingVertical='HUG';if(appendMissingTokens && !ids.includes(parent.id))mutatedNodeIds.push(parent.id);return n;
  }
  function text(parent,value,width,size=variables.get('type/size/px-14').valuesByMode[base.defaultModeId],ink='text-primary',style='Regular') {
    const n=figma.createText();ids.push(n.id);n.name=value.split('\n')[0].slice(0,100);n.fontName={family:'Caelum Sans',style};n.fontSize=size;
    n.characters=value;n.fills=[paint('color/'+ink)];n.resize(width,1);n.textAutoResize='HEIGHT';parent.appendChild(n);n.layoutSizingHorizontal='FIXED';return n;
  }
  function display(item,value=item.value) {
    if (value && typeof value==='object' && !Array.isArray(value)) return value.hex?value.hex.toUpperCase():value.value+' '+value.unit;
    if(Array.isArray(value))return 'cubic-bezier\n'+value.join(', ');
    if(item.path==='primitives.shared.icon.artwork-coverage')return Number((value*100).toFixed(4))+'%';
    if(item.chain?.some(p=>p.startsWith('base.opacity.')))return Number((value*100).toFixed(4))+'%';
    return String(value);
  }
  function badge(card,status) {text(card,status.toUpperCase(),260,12,status==='canon'?'success':'peach-gold','SemiBold');}
  function card(parent,label,value) {
    const n=frame(parent,'Variant / '+label,260);
    const l=text(n,label,260,14,'text-primary','Medium');l.resize(260,manifest.tier===2?72:48);l.textAutoResize='NONE';
    const v=text(n,value,260,22,'text-primary','Medium');v.resize(260,60);v.textAutoResize='NONE';
    return n;
  }
  function view(card,height=72) {
    const n=frame(card,'Specimen',260,'HORIZONTAL');n.resize(260,height);n.layoutSizingVertical='FIXED';n.counterAxisAlignItems='CENTER';n.primaryAxisAlignItems='CENTER';
    n.paddingLeft=n.paddingRight=8;n.fills=[paint('color/ground')];n.cornerRadius=6;n.clipsContent=false;return n;
  }
  function tokenCard(parent,item) {
    const variable=variables.get(item.name);if(!variable)throw Error('Missing primitive variable '+item.name);
    const c=card(parent,item.label,display(item)),v=view(c);
    const terminal=item.chain.at(-1);
    if(item.type==='color'){
      const r=figma.createRectangle();ids.push(r.id);v.appendChild(r);r.resize(236,48);r.cornerRadius=6;r.fills=[paint(item.name)];
    } else if(terminal.startsWith('base.type.family.')){
      const t=text(v,'Aa · 0O · Caelos',236,24);t.setBoundVariable('fontFamily',variable);
    } else if(terminal.startsWith('base.type.size.')){
      const t=text(v,'Aa · Caelos',236,item.value.value);t.setBoundVariable('fontSize',variable);
    } else if(terminal.startsWith('base.type.line.')){
      const t=text(v,'Aa · line height',236,14);t.lineHeight={unit:'PIXELS',value:item.value.value};t.setBoundVariable('lineHeight',variable);
    } else if(terminal.startsWith('base.opacity.')){
      const r=figma.createRectangle();ids.push(r.id);v.appendChild(r);r.resize(156,40);r.cornerRadius=6;r.fills=[paint('color/text-primary')];r.setBoundVariable('opacity',variable);
    } else if(terminal.startsWith('base.radius.')){
      const r=figma.createRectangle();ids.push(r.id);v.appendChild(r);r.resize(156,48);r.fills=[paint('color/structural-violet')];for(const edge of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius'])r.setBoundVariable(edge,variable);
    } else if(item.type==='dimension' && item.value.value>0 && item.value.value<=236 && !terminal.startsWith('base.blur.')){
      const r=figma.createRectangle();ids.push(r.id);v.appendChild(r);r.resize(item.value.value,20);r.fills=[paint('color/structural-violet')];r.setBoundVariable('width',variable);
    } else text(v,item.type==='duration'||item.type==='cubicBezier'?'Static parameter\nInteraction review required':'Parameter\nSee exact value above',236,13,'text-supporting');
    badge(c,item.status);
    text(c,'Figma · '+item.name+'\nCatalog · '+item.path,260,12,'text-supporting');
    text(c,'Construction\n'+(item.construction ? constructionTokenLabel(item.construction) : item.chain[0]),260,12,'text-supporting');
    text(c,'Panda · '+(item.css?'var('+item.css+')':'No standalone token export'),260,12,'text-supporting');
    if(item.light!==null)text(c,'Light mode · '+display(item,item.light)+'\nRetained for reference; v1 review is dark',260,12,'text-supporting');
    text(c,'Evidence · '+item.evidence,260,12,'text-supporting');
    if(item.description)text(c,item.description,260,12,'text-supporting');
    if(item.uses.length)text(c,'Used by\n'+item.uses.join('\n'),260,12,'text-supporting');
    specimens.push({id:v.id,path:item.path,variableId:variable.id});
  }
  function row(root,name,count,construction) {
    const r=frame(root,'Family / '+name,1656,'HORIZONTAL');r.itemSpacing=24;
    const identity=frame(r,'Identity and construction',252);text(identity,name,252,21,'text-primary','Medium');
    text(identity,count+' variants\n'+construction,252,13,'text-supporting');
    return frame(r,'Variants · maximum five per line',1380);
  }
  const root=existingRoot || frame(page,'Category / '+category.title,1728);
  if (!appendMissingTokens) {
    root.x=100+category.column*1836;root.y=category.y??100;root.paddingLeft=root.paddingRight=root.paddingTop=root.paddingBottom=36;
    root.itemSpacing=28;root.fills=[paint('color/elevated')];root.cornerRadius=18;root.setExplicitVariableModeForCollection(semantic,dark.modeId);
    text(root,category.title,1656,32,'text-primary','SemiBold');text(root,category.purpose,1656,16,'text-supporting');
    text(root,'TIER '+(manifest.tier??1)+' · Lower-tier aliases • catalog status retained • clean grouping awaits visual approval',1656,12,'text-supporting');
  }
  const groups=[];
  for(const group of appendMissingTokens ? [] : category.studies){
    const source=await figma.getNodeByIdAsync(group.id);if(!source)throw Error('Missing source '+group.id);
    const children=source.type==='COMPONENT_SET'?source.children:[source];
    const split = group.splitAxes || ['typography','spacing'].includes(category.key) || (category.key==='materials' && group.name!=='Cloud states');
    if(split){const buckets=new Map();for(const child of children){const parts=child.name.split(',').map(p=>p.trim());const key=group.splitAxes?parts.filter(p=>group.splitAxes.includes(p.split('=')[0])).join(', '):parts[0];if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(child);}for(const [name,items]of buckets)groups.push({...group,name:group.name+' / '+(group.splitAxes?name:name.split('=').at(-1)),source,children:items});}
    else groups.push({...group,source,children});
  }
  if(!appendMissingTokens && category.key==='recipes-focus')groups.splice(0,groups.length,{name:'Interaction states',source:groups[0].source,children:groups.flatMap(g=>g.children)});
  if(category.key==='composer'){
    const buckets=new Map();
    for(const group of groups){const key=group.source.name.split(' / ').at(-1);if(!buckets.has(key))buckets.set(key,{...group,name:key,children:[]});buckets.get(key).children.push(...group.children);}
    groups.splice(0,groups.length,...buckets.values());
  }
  for(const group of groups){
    const {source,children}=group;
    const vs=row(root,group.name,children.length,group.note??(category.key==='materials'?'Recipe · material({ texture, layer })\nDark v1 · static study; behavior unverified':'Existing component specimens\nFoundation bindings retained\nPanda token export · not implemented'));
    let line;
    for(let i=0;i<children.length;i++){
      if(i%5===0){line=frame(vs,'Variant line '+(1+Math.floor(i/5)),1380,'HORIZONTAL');line.itemSpacing=20;}
      const master=children[i], label=master.name;
      const sampleText=category.key==='typography'?master.findAllWithCriteria({types:['TEXT']})[0]:null;
      const value=sampleText?sampleText.fontSize+' px / '+(sampleText.lineHeight.value ?? 'auto')+' px\n'+sampleText.fontName.family:Math.round(master.width*100)/100+' × '+Math.round(master.height*100)/100+' px';
      const c=card(line,label,value);
      const v=view(c,Math.max(72,master.height+16));
      const instance=master.type==='COMPONENT'?master.createInstance():master.clone();ids.push(instance.id);v.appendChild(instance);
      instance.setExplicitVariableModeForCollection(semantic,dark.modeId);
      // A separator's length is review furniture; thickness and fade remain unchanged.
      if(instance.width>244 && category.key==='foundation')instance.resize(236,instance.height);
      const nodes=[instance,...('findAll' in instance?instance.findAll(()=>true):[])];
      const bindings=new Set();
      function collect(x){if(!x||typeof x!=='object')return;if(x.type==='VARIABLE_ALIAS')bindings.add(x.id);else for(const value of Object.values(x))collect(value);}
      for(const n of nodes){if('boundVariables'in n)collect(n.boundVariables);if('fills'in n&&Array.isArray(n.fills))for(const fill of n.fills)collect(fill.boundVariables);if('effects'in n)for(const e of n.effects)collect(e.boundVariables);}
      const names=[...new Set([...bindings].map(id=>{const v=all.find(v=>v.id===id);return v?constructionBindingLabel(v,manifest,collections):id;}))].sort();
      badge(c,category.key==='icon'?'catalog glossary':'study · visual review required');
      text(c,'Figma · '+(category.key==='recipes-focus'?group.name:source.name)+'\nSource · '+master.id,260,12,'text-supporting');
      text(c,'Construction\n'+(names.join('\n')||'No variable binding found'),260,12,'text-supporting');
      const glyph=label.replace(/^.*=\s*/,'').trim();
      if(category.key==='icon')text(c,'Used by\n'+(manifest.meanings[glyph]?.join('\n')||'Available glyph · no specific use recorded'),260,12,'text-supporting');
      if(category.key==='materials')text(c,'Static study. Gradient geometry and unsupported filter parameters are not live variable bindings; see construction parameters below. Overlap behavior requires runtime review.',260,12,'text-supporting');
      if(category.key==='foundation')text(c,'Fade-stop roles remain open. Preview span is illustrative; thickness retains its binding.',260,12,'text-supporting');
      if(!names.length)gaps.push({id:instance.id,source:master.id,reason:'No variable binding found'});
      specimens.push({id:instance.id,source:master.id,bindingCount:bindings.size});
    }
  }
  for(const group of category.rows){
    const family = appendMissingTokens && root.children.find(n => n.name === 'Family / '+group.name && n.findAllWithCriteria({types:['TEXT']}).some(t => t.characters.includes('Catalog · ')));
    const vs=family ? family.children.find(n => n.name === 'Variants · maximum five per line') : row(root,group.name,group.items.length,'Tier '+(manifest.tier??1)+' parameters → lower tiers\nPanda · see individual cards');
    const recorded = new Set(vs.findAllWithCriteria({types:['TEXT']}).filter(t=>t.characters.includes('\nCatalog · ')).map(t=>t.characters.split('\nCatalog · ')[1]));
    for(const item of group.items.filter(i=>!recorded.has(i.path))) {
      let line=vs.children.at(-1);
      if(!line || line.children.length>=5){line=frame(vs,'Variant line '+(vs.children.length+1),1380,'HORIZONTAL');line.itemSpacing=20;}
      tokenCard(line,item);
    }
    if(family){const count=family.children[0].children.find(n=>n.type==='TEXT' && n.characters.includes(' variants\n'));const label=group.items.length+' variants\nTier '+manifest.tier+' parameters → lower tiers\nPanda · see individual cards';if(count && count.characters!==label){count.characters=label;mutatedNodeIds.push(count.id);}}
  }
  for(const entry of appendMissingTokens ? [] : category.pending??[]) {
    const vs=row(root,entry.name,1,'Catalog inventory · '+entry.status+'\nNo complete recipe implied');
    const c=card(vs,entry.path,entry.status.toUpperCase());
    badge(c,entry.status);text(c,entry.description,260,14);
    text(c,'Variants and states\n'+Object.entries(entry.variants).map(([axis,values])=>axis+' · '+(Array.isArray(values)?values.join(', '):String(values))).join('\n')+'\n'+entry.states.join(', '),260,12,'text-supporting');
    text(c,'Construction · '+(entry.note||'Lower-tier recipe mapping is still open.')+'\nPanda · '+(entry.recipe||'No complete recipe export'),260,12,'text-supporting');
  }
  let glyphFit = null;
  if (category.key === 'icon') {
    const config = {...manifest.glyphFit, galleryId:root.id,
      coverageVariableId:variables.get(manifest.glyphFit.primitiveName).id};
    glyphFit = await fitGlyphGallery(figma, config, true);
    mutatedNodeIds.push(...glyphFit.mutatedNodeIds);
    mutatedNodeIds.push(...await updateGlyphLabels(figma, config, glyphFit.results));
  }
  // Return failures and all affected IDs even if a fit needs correction.
  return {id:root.id,createdNodeIds:ids,mutatedNodeIds:[...new Set(mutatedNodeIds)],glyphFit,category:category.key,width:root.width,height:root.height,specimens,gaps};
}
