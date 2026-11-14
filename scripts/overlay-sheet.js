// Review furniture matches the Clean sheets. It is not a Tier 3 product recipe.
// Existing product references remain instances; unresolved designs stay explicit.
async function renderOverlayReview(manifest) {
  const ids = [], changed = [];
  let page = figma.root.children.find(p => p.name === manifest.pageName);
  if (!page) { page = figma.createPage(); page.name = manifest.pageName; ids.push(page.id); }
  await figma.setCurrentPageAsync(page);
  const fonts = [{family:'Caelum Sans',style:'Regular'}, {family:'Caelum Sans',style:'Medium'}, {family:'Caelum Sans',style:'SemiBold'}];
  const refs = await Promise.all(manifest.composerReferences.map(r => figma.getNodeByIdAsync(r.id)));
  for (const source of refs) {
    if (!source || source.type !== 'COMPONENT') throw Error('Missing Composer source');
    for (const t of source.findAllWithCriteria({types:['TEXT']})) fonts.push(...t.getStyledTextSegments(['fontName']).map(s => s.fontName));
  }
  for (const t of page.findAllWithCriteria({types:['TEXT']})) fonts.push(...t.getStyledTextSegments(['fontName']).map(s => s.fontName));
  await Promise.all([...new Map(fonts.map(f => [JSON.stringify(f),f])).values()].map(f => figma.loadFontAsync(f)));
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const semantic = collections.find(c => c.name === '01 Semantic');
  const dark = semantic.modes.find(m => m.name === 'Dark');
  const variable = (name, collection='01 Semantic') => {
    const owner = collections.find(c => c.name === collection);
    const v = variables.find(v => v.name === name && v.variableCollectionId === owner?.id);
    if (!v) throw Error('Missing variable: ' + collection + '/' + name);
    return v;
  };
  const paint = name => {
    const ink = variable('color/'+name);
    const {r,g,b,a} = ink.resolveForConsumer(page.children[0]).value;
    return figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r,g,b},...(a === undefined ? {} : {opacity:a})}, 'color', ink);
  };
  const base = collections.find(c => c.name === '00 Base');
  const bodySize = variable('type/size/px-14', '00 Base').valuesByMode[base.defaultModeId];
  function frame(parent,name,width,axis='VERTICAL') {
    const n = figma.createAutoLayout(axis); ids.push(n.id); n.name=name; n.fills=[]; n.itemSpacing=16;
    n.resize(width,1); parent.appendChild(n); n.layoutSizingHorizontal='FIXED'; n.layoutSizingVertical='HUG'; n.clipsContent=false; return n;
  }
  function text(parent,value,width,size=bodySize,ink='text-supporting',style='Regular') {
    const n=figma.createText();ids.push(n.id);n.name=value.split('\n')[0].slice(0,100);
    n.fontName={family:'Caelum Sans',style};n.fontSize=size;n.characters=value;n.fills=[paint(ink)];
    n.resize(width,1);n.textAutoResize='HEIGHT';parent.appendChild(n);n.layoutSizingHorizontal='FIXED';return n;
  }
  // A reusable documentation card, deliberately outside the product library.
  let template=page.children.find(n=>n.name==='Review furniture / Evidence card');
  if (!template) {
    template=figma.createComponent();ids.push(template.id);template.name='Review furniture / Evidence card';
    template.description='Documentation only. Reusable evidence text for the Tier 3 review; not a product recipe.';
    template.layoutMode='VERTICAL';template.itemSpacing=12;template.paddingTop=template.paddingBottom=template.paddingLeft=template.paddingRight=20;
    template.resize(444,1);template.layoutSizingVertical='HUG';template.fills=[paint('ground')];template.cornerRadius=12;
    template.x=page.children.reduce((right,n)=>Math.max(right,n.x+n.width),0)+200;template.y=100;
    for(const [label,value,size,style] of [['Title','Evidence',16,'Medium'],['Body','Review content',14,'Regular']]) {
      const n=text(template,value,404,size,label==='Title'?'text-primary':'text-supporting',style);
      const prop=template.addComponentProperty(label,'TEXT',value);n.componentPropertyReferences={characters:prop};
    }
    template.setExplicitVariableModeForCollection(semantic,dark.modeId);
  }
  const properties=template.componentPropertyDefinitions;
  const titleKey=Object.keys(properties).find(k=>k.startsWith('Title#'));
  const bodyKey=Object.keys(properties).find(k=>k.startsWith('Body#'));
  function card(parent,title,body) {
    const n=template.createInstance();ids.push(n.id);parent.appendChild(n);n.setProperties({[titleKey]:title,[bodyKey]:body});return n;
  }
  const fmt=value=>value&&typeof value==='object'&&!Array.isArray(value)?value.hex?value.hex.toUpperCase():value.value+' '+value.unit:Array.isArray(value)?value.join(', '):String(value);
  const rootNodes=[];
  for (let ci=0;ci<manifest.categories.length;ci++) {
    const category=manifest.categories[ci];
    const existing=page.children.find(n=>n.name==='Category / '+category.title);
    if(existing) throw Error('Category already exists; inspect before updating: '+category.title);
    const root=frame(page,'Category / '+category.title,1728);rootNodes.push(root);
    root.x=100+(ci%3)*1840;root.y=650+Math.floor(ci/3)*3100;
    root.paddingLeft=root.paddingRight=root.paddingTop=root.paddingBottom=36;root.itemSpacing=28;root.cornerRadius=18;root.fills=[paint('elevated')];
    root.setExplicitVariableModeForCollection(semantic,dark.modeId);
    text(root,category.title,1656,32,'text-primary','SemiBold');
    text(root,'TIER 3 · DARK v1 · REVIEW CATALOG',1656,12,'peach-gold','SemiBold');
    text(root,'Approval pending Daniel • Implementation: source references only • Runtime verification: unverified',1656,16);
    for(const family of category.families) {
      const row=frame(root,'Family / '+family.title,1656,'HORIZONTAL');row.itemSpacing=24;
      const identity=frame(row,'Identity',252);text(identity,family.title,252,22,'text-primary','Medium');text(identity,family.use,252,14);
      text(identity,'Tier 3\n'+family.members.length+' catalog entries\n'+(family.decisions.join(' · ')||'No family decision recorded'),252,12);
      text(identity,'Approval\n'+family.approval+'\n\nImplementation\n'+family.implementation+'\n\nVerification\n'+family.verification,252,12);
      const content=frame(row,'Grouped evidence',1380);const line=frame(content,'Evidence line · three cards',1380,'HORIZONTAL');line.itemSpacing=16;
      card(line,'Variants & states','Required coverage; these labels are not rendered-state proof.\n\n'+family.variants.join('\n')+'\n\nPanda\n'+family.panda+'\n\nSource files\n'+family.sourceFiles.join('\n'));
      card(line,'Behavior contract',Object.entries(family.behavior).map(([key,value])=>({anchoring:'Position & anchor',opening:'Open / close',outsideDismiss:'Outside click',escape:'Escape',focus:'Focus',scrollAndClipping:'Scroll & clipping',reducedMotion:'Reduced motion'}[key])+ '\n'+value).join('\n\n'));
      card(line,'Open dependencies',family.openDependencies.join('\n\n')+'\n\nPreserved inventory\n'+family.members.map(p=>p.replace('overlays.shared.','').replace('overlays.chat.','chat/')).join(' · '));
      if(family.aliases.length)text(content,'Catalog aliases · existing parameters, not extra visual variants\n'+family.aliases.map(a=>a.path+' → '+a.ingredient+' · '+a.status+' · '+a.decision).join('\n'),1380,12);
    }
    if(category.ingredients.length) {
      text(root,'Construction · exact lower-tier ingredients',1656,20,'text-primary','Medium');
      text(root,'One row per ingredient. Values resolve from the catalog; aliases do not create duplicate swatches. A source reference does not approve every lower-tier choice.',1656,14);
      for(const item of category.ingredients) {
        const r=frame(root,'Ingredient / '+item.path,1656,'HORIZONTAL');r.itemSpacing=24;
        text(r,(item.colorName?item.colorName+' · ':'')+fmt(item.value)+(item.light!==null?'\nLight reference: '+fmt(item.light):''),250,15,'text-primary','Medium');
        text(r,item.path+'\nFigma · '+item.collection+' / '+item.name,800,12);
        text(r,item.status+'\n'+item.decision,558,12);
      }
    }
    if(category.key==='tooltip') {
      text(root,'Material & geometry sample · partial, not a complete Tooltip',1656,16,'text-primary','Medium');
      const sample=frame(root,'Tooltip geometry sample · illustrative span',240,'HORIZONTAL');sample.resize(240,56);sample.layoutSizingVertical='FIXED';sample.fills=[paint('success')];
      for(const key of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius'])sample.setBoundVariable(key,variable('radius/px-11','00 Base'));
      for(const key of ['paddingTop','paddingBottom'])sample.setBoundVariable(key,variable('space/px-10','00 Base'));
      for(const key of ['paddingLeft','paddingRight'])sample.setBoundVariable(key,variable('space/px-13','00 Base'));
      sample.setBoundVariable('opacity',variable('opacity/fraction-0-8','00 Base'));
      text(root,'Sage fill / radius / padding / opacity are bound. Span is review furniture. Text, neutral edge ink and backdrop context are unresolved; no full Tooltip state is claimed.',1656,12);
    }
    if(category.key==='menus') {
      text(root,'Composer dock references · Tier 5 context',1656,20,'text-primary','Medium');
      text(root,'Five existing components retained as instances. They are dock references, not generic menu surfaces or rebuilt Tier 3 recipes.',1656,14);
      const line=frame(root,'Reference line · maximum five',1656,'HORIZONTAL');line.itemSpacing=20;
      for(let i=0;i<refs.length;i++) {
        const width=Math.max(260,refs[i].width);const c=frame(line,'Reference / '+manifest.composerReferences[i].name,width);text(c,manifest.composerReferences[i].name,width,14,'text-primary','Medium');
        const n=refs[i].createInstance();ids.push(n.id);c.appendChild(n);n.setExplicitVariableModeForCollection(semantic,dark.modeId);
        text(c,'Source '+refs[i].id+'\nExisting bindings retained\nPlayback unverified',width,12);
      }
    }
    text(root,'Shared direction\n'+manifest.sharedMaterial+'\n'+manifest.sharedControls,1656,13);
    text(root,'Evidence source · '+manifest.source.repository+' @ '+manifest.source.commit+'\n'+manifest.theme+'\n'+manifest.carryForward,1656,12);
  }
  // Column heights determine placement; no fixed grid cell can clip a tall category.
  const bottoms=[650,650,650];
  for(let i=0;i<rootNodes.length;i++){const n=rootNodes[i],col=i%3;n.y=bottoms[col];bottoms[col]=n.y+n.height+120;}
  template.x=5740;template.y=100;
  const counts={},imageNodes=[],fontFamilies=new Set();
  for(const root of rootNodes)for(const n of [root,...root.findAll(()=>true)]) {
    counts[n.type]=(counts[n.type]||0)+1;
    if(n.type==='TEXT')for(const s of n.getStyledTextSegments(['fontName']))fontFamilies.add(s.fontName.family);
    if('fills'in n&&Array.isArray(n.fills)&&n.fills.some(p=>p.type==='IMAGE'))imageNodes.push({id:n.id,name:n.name,type:n.type,width:n.width,height:n.height});
  }
  return {createdNodeIds:ids,mutatedNodeIds:changed,pageId:page.id,roots:rootNodes.map(n=>({id:n.id,name:n.name,width:n.width,height:n.height})),counts,imageNodes,fontFamilies:[...fontFamilies],templateId:template.id};
}
