// Evaluate primitive-sheet.js first. This refresh changes annotations only.
// Direct bindings come from live specimens; derived paints are included only
// after their rendered values match the recipe. No visual state is rewritten.
async function refreshButtonConstruction(manifest) {
  const page = await figma.getNodeByIdAsync(manifest.pageId);
  await figma.setCurrentPageAsync(page);
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(variables.map(v => [v.id, v]));
  const roots = page.children.filter(n => n.name.startsWith('Category / '));
  const buttons = roots.find(n => n.name === 'Category / Buttons');
  const composer = roots.find(n => n.name === 'Category / Composer references');
  const fields = roots.find(n => n.name === 'Category / Fields');
  const changed = new Set(), planned = [], audit = [];
  const collect = (value, ids) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'VARIABLE_ALIAS') ids.add(value.id);
    else for (const child of Object.values(value)) collect(child, ids);
  };
  const near = (a,b) => Math.abs(a-b) < 0.0001;
  const scalar = item => typeof item.value === 'object' ? item.value.value : item.value;
  const rgb = (color,item) => {
    const hex = item.value.hex.slice(1);
    return ['r','g','b'].every((key,i) => near(color[key],parseInt(hex.slice(i*2,i*2+2),16)/255));
  };
  const requireMatch = (ok, label) => {if (!ok) throw Error('Live paint differs from catalog: ' + label);};
  const ingredients = Object.values(manifest.constructionTokens);
  const cloud = key => ingredients.find(t => t.path === 'primitives.shared.cloud.' + key);
  const category = manifest.categories.find(c => c.key === 'buttons');
  for (const family of buttons.children.filter(n => n.name.startsWith('Family / '))) {
    const study = category.studies.find(s => family.name.startsWith('Family / ' + s.name + ' / '));
    if (!study) continue; // Inventory-only controls have no rendered states.
    const shared = new Set(study.sharedConstructionPaths.map(path => ingredients.find(t => t.path === path)).filter(Boolean).map(constructionTokenLabel));
    for (const specimen of family.findAll(n => n.name === 'Specimen')) {
      const annotation = specimen.parent.children.find(n => n.type === 'TEXT' && /^(State construction|Construction)\n/.test(n.characters));
      if (!annotation) throw Error('Missing construction annotation: ' + specimen.id);
      const nodes = specimen.findAll(() => true), ids = new Set();
      for (const n of nodes) {
        collect(n.boundVariables, ids);
        for (const property of ['fills','strokes','effects']) if (property in n) collect(n[property], ids);
      }
      const bound = [...new Set([...ids].map(id => constructionBindingLabel(byId.get(id),manifest,collections)))].filter(line => !shared.has(line));
      const style = study.name.toLowerCase();
      const state = specimen.parent.name.match(/State=([^,]+)/)[1].toLowerCase();
      const paint = manifest.buttonStatePaints[style][state];
      const root = specimen.children[0];
      const label = nodes.find(n => n.type === 'TEXT' && n.name === 'Label');
      requireMatch(rgb(label.fills[0].color,paint.foreground), style+'/'+state+'/foreground');
      const derived = new Map();
      const add = item => derived.set(item.path, constructionTokenLabel(item) + ' · sync-derived');
      const wash = style === 'primary' ? nodes.find(n => n.name === 'Cloud color wash') : root;
      const gradient = wash?.fills?.find(p => p.type === 'GRADIENT_LINEAR');
      if (gradient) {
        const glass = style === 'tonal' && state === 'pressed';
        const start = glass ? paint.tintInk : style === 'primary' ? cloud('wash-start') : paint.washStart;
        const end = glass ? paint.tintInk : style === 'primary' ? cloud('wash-end') : paint.washEnd;
        const startAlpha = glass ? paint.tintOpacity : style === 'primary' ? cloud('wash-start-alpha') : paint.washStartAlpha;
        const endAlpha = glass ? null : style === 'primary' ? cloud('wash-end-alpha') : paint.washEndAlpha;
        const stops = gradient.gradientStops;
        requireMatch(rgb(stops[0].color,start) && rgb(stops[1].color,end),style+'/'+state+'/wash colors');
        requireMatch(near(stops[0].color.a,scalar(startAlpha)),style+'/'+state+'/wash alpha');
        requireMatch(near(stops[1].color.a,glass ? scalar(startAlpha)*scalar(paint.falloffStrength) : scalar(endAlpha)),style+'/'+state+'/wash end alpha');
        [start,end,startAlpha,...(glass?[paint.falloffAt,paint.falloffStrength]:[endAlpha])].forEach(add);
        if (glass) requireMatch(near(stops[1].position,scalar(paint.falloffAt)),style+'/'+state+'/falloff');
        else {
          const angle = style === 'primary' ? cloud('angle') : paint.angle;
          // The producer uses an aspect-corrected 135-degree transform.
          const ratio = wash.width/(wash.width+wash.height);
          requireMatch(scalar(angle)===135 && near(gradient.gradientTransform[0][0],ratio) && near(gradient.gradientTransform[0][1],1-ratio),style+'/'+state+'/angle');
          add(angle);
        }
      }
      if (style==='tonal' && state!=='disabled') {
        const solid=root.fills.find(p=>p.type==='SOLID');
        requireMatch(rgb(solid.color,paint.fill)&&near(solid.opacity,scalar(paint.fillOpacity)),style+'/'+state+'/body');
        add(paint.fill); add(paint.fillOpacity);
      }
      if (paint.glowInk && style!=='primary') {
        const effect=(style==='text'?label:root).effects.find(e=>e.type==='DROP_SHADOW');
        requireMatch(effect && rgb(effect.color,paint.glowInk) && near(effect.color.a,scalar(paint.glowOpacity)),style+'/'+state+'/glow');
        requireMatch(near(effect.offset.x,scalar(paint.glowOffset))&&near(effect.offset.y,scalar(paint.glowOffset)),style+'/'+state+'/glow offset');
        [paint.glowInk,paint.glowOpacity,paint.glowOffset].forEach(add);
      }
      const boundNames=new Set(bound.map(line=>line.split(' · ')[0]));
      const lines=[...bound,...[...derived.values()].filter(line=>!boundNames.has(line.split(' · ')[0]))].sort();
      const runtime=style==='tonal'&&state==='pressed' ? '\nRuntime only · glass saturation and adaptive overlap; not demonstrated by this static Figma specimen.' : '';
      planned.push([annotation,'State construction\n'+lines.join('\n')+runtime]);
      audit.push({id:specimen.id,style,state,bound:bound.length,derived:derived.size});
    }
    const note=family.children[0].children.find(n=>n.type==='TEXT'&&/^\d+ variants\n/.test(n.characters));
    planned.push([note,note.characters.split('\n')[0]+'\n'+study.note]);
  }
  for (const specimen of composer.findAll(n=>n.name==='Specimen')) {
    const note=specimen.parent.children.find(n=>n.type==='TEXT'&&/^(State construction|Construction)\n/.test(n.characters));
    if (!note) continue;
    const ids=new Set();
    for(const n of specimen.findAll(()=>true)) {
      collect(n.boundVariables,ids);
      for(const prop of ['fills','strokes','effects'])if(prop in n)collect(n[prop],ids);
    }
    const lines=[...new Set([...ids].map(id=>constructionBindingLabel(byId.get(id),manifest,collections)))].sort();
    planned.push([note,'Construction\n'+lines.join('\n')]);
  }
  const fieldStudy=manifest.categories.find(c=>c.key==='fields').studies[0];
  for(const family of fields.children.filter(n=>n.name.startsWith('Family / Field / '))) {
    const note=family.children[0].children.find(n=>n.type==='TEXT'&&/^\d+ variants\n/.test(n.characters));
    planned.push([note,note.characters.split('\n')[0]+'\n'+fieldStudy.note]);
  }
  // Finish all validation before the first mutation.
  const fonts=planned.flatMap(([n])=>n.getStyledTextSegments(['fontName']).map(s=>s.fontName));
  for(const f of new Map(fonts.map(f=>[JSON.stringify(f),f])).values())await figma.loadFontAsync(f);
  for(const [node,value] of planned)if(node.characters!==value){node.characters=value;changed.add(node.id);}
  for(const x of new Set(roots.map(n=>n.x))){
    const column=roots.filter(n=>n.x===x).sort((a,b)=>a.y-b.y);
    let y=column[0].y;
    for(const root of column){if(root.y!==y){root.y=y;changed.add(root.id);}y=root.y+root.height+100;}
  }
  return {mutatedNodeIds:[...changed],createdNodeIds:[],statesAudited:audit.length,annotationsReviewed:planned.length,audit};
}
