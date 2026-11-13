// Create source sets before rendering categories with primitive-sheet.js.
// Product geometry and paints are resolved exclusively from catalog ingredients.
async function createCompactControls(figma, manifest, updateBadges = false) {
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  await figma.setCurrentPageAsync(page);
  const archive = await figma.getNodeByIdAsync('412:998');
  const template = await figma.getNodeByIdAsync('377:6440');
  const variables = await figma.variables.getLocalVariablesAsync();
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const made = [], changed = [], sources = {};
  const data = manifest.compactControls;
  const lookup = item => {
    const matches = variables.filter(v => v.name === item.name && collections.find(c => c.id === v.variableCollectionId)?.name === item.collection);
    if (matches.length !== 1) throw Error('Missing/ambiguous ingredient ' + item.path);
    return matches[0];
  };
  // Fail before creating assets when a catalog ingredient has not reached Figma.
  const validate = x => { if (x?.path) lookup(x); else if (x && typeof x === 'object') Object.values(x).forEach(validate); };
  validate(data);
  for (const t of page.findAllWithCriteria({types:['TEXT']}))
    for (const s of t.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(s.fontName);
  const bind = (node, property, ingredient) => node.setBoundVariable(property, lookup(ingredient));
  const value = (item, node) => lookup(item).resolveForConsumer(node).value;
  const resolveTokenColor = (item, node) => { const {r,g,b} = value(item,node); return {r,g,b}; };
  const solid = (item,node,alpha=1) => alpha === 1
    ? figma.variables.setBoundVariableForPaint({type:'SOLID',color:resolveTokenColor(item,node)},'color',lookup(item))
    : {type:'SOLID',color:resolveTokenColor(item,node),opacity:alpha};
  function geometry(component,label,g,shape,radii) {
    for (const [property,key] of Object.entries({paddingLeft:'pad-x',paddingRight:'pad-x',paddingTop:'pad-y',paddingBottom:'pad-y',itemSpacing:'gap',minHeight:'height',height:'height'})) bind(component,property,g[key]);
    for (const edge of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius']) bind(component,edge,radii[shape]);
    for (const [property,key] of [['fontFamily','type-family'],['fontSize','type-size'],['lineHeight','type-line'],['fontWeight','type-weight']]) bind(label,property,g[key]);
    component.primaryAxisAlignItems='CENTER';component.counterAxisAlignItems='CENTER';
    component.layoutSizingVertical='FIXED';
    if(shape==='circle') {bind(component,'width',g.height);component.layoutSizingHorizontal='FIXED';}
    else component.layoutSizingHorizontal='HUG';
    component.strokes=[];component.effects=[];component.clipsContent=false;
    label.effects=[];label.textAutoResize='WIDTH_AND_HEIGHT';
  }
  // Figma opacity variables are percentages; catalog opacity values are fractions.
  function chipPaint(component,label,paint) {
    const v = key => value(paint[key],component);
    component.fills=[solid(paint.fill,component,paint.fillOpacity?v('fillOpacity')/100:1)];
    label.fills=[solid(paint.foreground,component)];
    if(paint.angle) {
      const angle=v('angle')*Math.PI/180, dx=Math.sin(angle),dy=-Math.cos(angle);
      const length=Math.abs(component.width*dx)+Math.abs(component.height*dy);
      const ax=component.width*dx/length,ay=component.height*dy/length;
      component.fills=[{type:'GRADIENT_LINEAR',gradientTransform:[[ax,ay,(1-ax-ay)/2],[-ay,ax,(1+ay-ax)/2]],gradientStops:['Start','End'].map((end,i)=>({position:i,color:{...resolveTokenColor(paint['wash'+end],component),a:v('wash'+end+'Alpha')/100}}))},...component.fills];
    }
    if(paint.tintInk) {
      component.fills=[{type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[0,1].map(i=>({position:i*paint.falloffAt.value,color:{...resolveTokenColor(paint.tintInk,component),a:v('tintOpacity')/100*(i?paint.falloffStrength.value:1)}}))},...component.fills];
      component.effects=[figma.variables.setBoundVariableForEffect({type:'BACKGROUND_BLUR',visible:true,radius:v('blur')},'radius',lookup(paint.blur))];
    }
    if(paint.glowInk) component.effects=[figma.variables.setBoundVariableForEffect({type:'DROP_SHADOW',visible:true,blendMode:'NORMAL',color:{...resolveTokenColor(paint.glowInk,component),a:v('glowOpacity')/100},offset:{x:v('glowOffset'),y:v('glowOffset')},radius:v('glowBlur'),spread:0,showShadowBehindNode:false},'radius',lookup(paint.glowBlur))];
  }
  for (const kind of (updateBadges ? ['badge'] : ['chip','badge'])) {
    const setName='Draft / '+(kind==='chip'?'Interactive chip':'Passive badge');
    const existingSet=page.findOne(n=>n.type==='COMPONENT_SET'&&n.name===setName);
    if(updateBadges && !existingSet) throw Error('Missing badge source set');
    if(!updateBadges && existingSet) throw Error('Inspect existing source before rerunning: '+setName);
    const components=[];
    const states=kind==='chip'?['Default','Hover','Focus','Pressed','Disabled']:['Neutral','Info','Success','Danger'];
    for(const shape of ['rounded','pill','circle']) for(const state of states) {
      const name=`Shape=${shape}, ${kind==='chip'?'State':'Tone'}=${state}`;
      const component=updateBadges ? existingSet.children.find(n=>n.name===name) : template.clone();
      if(!component) throw Error('Missing variant '+name);
      if(!updateBadges) archive.appendChild(component);
      component.name=name;
      const label=component.children.find(n=>n.type==='TEXT');
      label.characters=kind==='chip'?(shape==='circle'?'1':'Filter & sort'):(shape==='circle'?'3':{Neutral:'Planning',Info:'In progress',Success:'Complete',Danger:'Blocked'}[state]);
      geometry(component,label,data[kind+'Geometry'],shape,data[kind+'Shapes']);
      if(kind==='chip')chipPaint(component,label,data.chipPaints[state.toLowerCase()]);
      else {
        const tone=data.badgeTones[state.toLowerCase()];
        chipPaint(component,label,{...data.badgeMaterial,foreground:tone,washStart:tone});
      }
      await component.setReactionsAsync([]);
      component.description=manifest.categories.find(c=>c.key===kind+'s').studies[0].note+'\n'+component.name;
      for(const n of [component,...component.findAll(()=>true)])(updateBadges?changed:made).push(n.id);
      components.push(component);
    }
    const set=updateBadges ? existingSet : figma.combineAsVariants(components,archive);
    (updateBadges?changed:made).push(set.id);set.name=setName;
    set.description=manifest.categories.find(c=>c.key===kind+'s').studies[0].note;
    // Source grid positions are review furniture, never product dimensions.
    if(!updateBadges) {
      components.forEach((n,i)=>{n.x=24+(i%states.length)*220;n.y=24+Math.floor(i/states.length)*100;});
      set.resize(states.length*220+48,348);set.x=0;set.y=kind==='chip'?10500:11000;
    }
    sources[kind]=set.id;
  }
  if (!updateBadges) changed.push(archive.id);
  return {sources,createdNodeIds:made,mutatedNodeIds:changed,counts:{chips:updateBadges?0:15,badges:12},prototype:'Static specimens; no simulated menu or success'};
}
