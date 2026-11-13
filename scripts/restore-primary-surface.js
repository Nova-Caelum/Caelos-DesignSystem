// Evaluate primitive-sheet.js first; pass control-sheet.py's catalog-derived manifest.
// Gradient direction and stop alpha are derived from existing variables at sync time:
// Figma has no variable binding for a gradient transform or a stop's alpha.
// Binding a stop color replaces its alpha with the opaque palette value, so
// the full gradient is sync-derived; its source tokens are listed in each card.
async function restorePrimarySurface(figma, manifest) {
  await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(manifest.pageId));
  const page = figma.currentPage;
  const source = await figma.getNodeByIdAsync('377:6244');
  const root = page.children.find(n => n.name === 'Category / Buttons');
  const allVars = await figma.variables.getLocalVariablesAsync();
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variable = name => {
    const found = allVars.filter(v => v.name === name);
    if (found.length !== 1) throw Error('Ambiguous or missing variable: ' + name);
    return found[0];
  };
  const createdNodeIds=[], mutatedNodeIds=[];
  for (const text of [source, root].flatMap(n=>n.findAllWithCriteria({types:['TEXT']})))
    for(const part of text.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(part.fontName);
  const baseGlow = await figma.getNodeByIdAsync('377:6258');
  const baseBed = await figma.getNodeByIdAsync('377:6259');
  for (const component of source.children) {
    const state=component.variantProperties.State;
    if(state==='Success') {
      const label=component.children.find(n=>n.type==='TEXT');
      label.characters='✓ Success';
      await component.setReactionsAsync([]);
      component.description='Confirmed completion only. Reset on the next host edit or eligible action, never by timer or by clicking Success. Runtime helper: createActionFeedback(). Host wiring is still required.';
      mutatedNodeIds.push(component.id,label.id);
      continue;
    }
    if(state==='Disabled') continue;
    if(['Default','Pressed'].includes(state)) {
      let glow=component.children.find(n=>n.name==='Resting surface glow');
      if(!glow) {glow=baseGlow.clone();component.insertChild(0,glow);createdNodeIds.push(glow.id);}
      glow.name='Resting surface glow';
      const glowInk=variable('primitives/shared/surface/button/default');
      const {r,g,b}=glowInk.resolveForConsumer(component).value;
      glow.fills=[figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r,g,b}},'color',glowInk)];
      glow.setBoundVariable('opacity',variable('opacity/fraction-0-07'));
      glow.effects=[figma.variables.setBoundVariableForEffect({type:'LAYER_BLUR',visible:true,radius:variable('blur/px-12').resolveForConsumer(component).value},'radius',variable('blur/px-12'))];
      let bed=component.children.find(n=>n.name==='Resting surface bed');
      if(!bed) {bed=baseBed.clone();component.insertChild(1,bed);createdNodeIds.push(bed.id);}
      bed.name='Resting surface bed';
      for(const node of [glow,bed]) {node.resize(component.width,component.height);node.x=0;node.y=0;node.constraints={horizontal:'STRETCH',vertical:'STRETCH'};mutatedNodeIds.push(node.id);}
    }
    let wash=component.children.find(n=>n.name==='Cloud color wash');
    if(!wash) {wash=baseBed.clone();component.insertChild(component.children.length-1,wash);createdNodeIds.push(wash.id);}
    wash.name='Cloud color wash';wash.resize(component.width,component.height);wash.x=0;wash.y=0;
    wash.constraints={horizontal:'STRETCH',vertical:'STRETCH'};
    const value=name=>variable(name).resolveForConsumer(component).value;
    const angle=value('primitives/shared/cloud/angle')*Math.PI/180;
    // Convert CSS direction to Figma's normalized start/end transform, accounting for aspect ratio.
    const dx=Math.sin(angle),dy=-Math.cos(angle), length=Math.abs(component.width*dx)+Math.abs(component.height*dy);
    const ax=component.width*dx/length, ay=component.height*dy/length;
    const gradientTransform=[[ax,ay,(1-ax-ay)/2],[-ay,ax,(1+ay-ax)/2]];
    wash.fills=[{type:'GRADIENT_LINEAR',gradientTransform,gradientStops:['start','end'].map((end,i)=>({position:i,color:{...value('primitives/shared/cloud/wash-'+end),a:value('primitives/shared/cloud/wash-'+end+'-alpha')/100}}))}];
    mutatedNodeIds.push(wash.id,component.id);
  }
  const study=manifest.categories.find(c=>c.key==='buttons').studies.find(s=>s.name==='Primary');
  source.description=study.note;mutatedNodeIds.push(source.id);
  for(const family of root.children.filter(n=>n.name.startsWith('Family / Primary /'))) {
    const identity=family.children.find(n=>n.name==='Identity and construction');
    const note=identity.children.find(n=>n.type==='TEXT'&&n.characters.includes('Partial recipe'));
    note.characters='6 variants\n'+study.note;mutatedNodeIds.push(note.id);
    for(const instance of family.findAllWithCriteria({types:['INSTANCE']})) {
      const bindings=new Set();
      const collect=x=>{if(x&&typeof x==='object'){if(x.type==='VARIABLE_ALIAS')bindings.add(x.id);else Object.values(x).forEach(collect);}};
      for(const node of [instance,...instance.findAll(()=>true)]) {collect(node.boundVariables);if('fills'in node)collect(node.fills);if('effects'in node)collect(node.effects);}
      const names=[...new Set([...bindings].map(id=>constructionBindingLabel(allVars.find(v=>v.id===id),manifest,collections)))].sort();
      const main=await instance.getMainComponentAsync();
      if(!['Success','Disabled'].includes(main.variantProperties.State)) {
        for(const path of ['primitives/shared/cloud/angle','primitives/shared/cloud/wash-start','primitives/shared/cloud/wash-end','primitives/shared/cloud/wash-start-alpha','primitives/shared/cloud/wash-end-alpha'])
          names.push(constructionBindingLabel(variable(path),manifest,collections)+' · sync-derived');
      }
      const card=instance.parent.parent;
      const text=card.children.find(n=>n.type==='TEXT'&&n.characters.startsWith('Construction\n'));
      text.characters='Construction\n'+names.join('\n');mutatedNodeIds.push(text.id,instance.id);
    }
  }
  return {createdNodeIds,mutatedNodeIds:[...new Set(mutatedNodeIds)],sourceId:source.id,reviewId:root.id};
}
