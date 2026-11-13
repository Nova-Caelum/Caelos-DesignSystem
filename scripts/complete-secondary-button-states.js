// Evaluate primitive-sheet.js first. All specimen paint values come from control-sheet.py.
async function completeSecondaryButtonStates(figma, manifest) {
  await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(manifest.pageId));
  const root = await figma.getNodeByIdAsync('412:999');
  const variables = await figma.variables.getLocalVariablesAsync();
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const changed = new Set(), created = new Set();
  const states = ['Default','Hover','Pressed','Success','Focus','Disabled'];
  for (const [style,id] of [['Tonal','377:6413'],['Text','377:6426']]) {
    const source = await figma.getNodeByIdAsync(id);
    const study = manifest.categories.find(c=>c.key==='buttons').studies.find(s=>s.name===style);
    for (const t of [root,source].flatMap(n=>n.findAllWithCriteria({types:['TEXT']})))
      for (const part of t.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(part.fontName);
    source.description = study.note; changed.add(source.id);
    for (const motion of ['Normal','Reduced']) {
      const name = state => `Motion=${motion}, State=${state}`;
      const template = source.children.find(n=>n.name===name('Default'));
      const components = {};
      for (const state of states) {
        let component = source.children.find(n=>n.name===name(state));
        if (!component) {component=template.clone(); source.appendChild(component); component.name=name(state);for(const n of [component,...component.findAll(()=>true)])created.add(n.id);}
        components[state]=component;
        const paint = manifest.buttonStatePaints[style.toLowerCase()][state.toLowerCase()];
        const variable = key => {
          const matches=variables.filter(v=>v.name===paint[key].name);
          if(matches.length!==1) throw Error('Missing/ambiguous variable: '+paint[key].name);
          return matches[0];
        };
        const value = key => variable(key).resolveForConsumer(component).value;
        const tokenColor = key => {const {r,g,b}=value(key);return {r,g,b};};
        // Figma color bindings replace alpha; translucent paints are derived on sync.
        const solid = (key,opacity=1) => opacity === 1
          ? figma.variables.setBoundVariableForPaint({type:'SOLID',color:tokenColor(key)},'color',variable(key))
          : {type:'SOLID',color:tokenColor(key),opacity};
        const label=component.children.find(n=>n.type==='TEXT');
        label.characters=state==='Success'?'✓ Success':style==='Tonal'?'Save changes':'Save';
        label.fills=[solid('foreground')];label.effects=[];
        component.effects=[];component.strokes=[];component.fills=[];
        // Previews are intentionally static: a click cannot imply confirmed success.
        await component.setReactionsAsync([]);
        component.description=study.note+'\nState: '+state+'. Static review specimen.';
        if(style==='Tonal') {
          component.fills=[solid('fill',paint.fillOpacity?value('fillOpacity')/100:1)];
          if(paint.angle) {
            const angle=value('angle')*Math.PI/180, dx=Math.sin(angle),dy=-Math.cos(angle);
            const length=Math.abs(component.width*dx)+Math.abs(component.height*dy);
            const ax=component.width*dx/length,ay=component.height*dy/length;
            const gradient={type:'GRADIENT_LINEAR',gradientTransform:[[ax,ay,(1-ax-ay)/2],[-ay,ax,(1+ay-ax)/2]],gradientStops:['Start','End'].map((end,i)=>({position:i,color:{...tokenColor('wash'+end),a:value('wash'+end+'Alpha')/100}}))};
            component.fills=[gradient,...component.fills];
          }
          if(state==='Pressed') {
            component.fills=[{type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:['start','end'].map((end,index)=>({position:index*paint.falloffAt.value,color:{...tokenColor('tintInk'),a:value('tintOpacity')/100*(end==='start'?1:paint.falloffStrength.value)}}))},...component.fills];
            component.effects=[figma.variables.setBoundVariableForEffect({type:'BACKGROUND_BLUR',visible:true,radius:value('blur')},'radius',variable('blur'))];
          }
        }
        if(paint.glowInk) {
          let effect={type:'DROP_SHADOW',visible:true,blendMode:'NORMAL',color:{...tokenColor('glowInk'),a:value('glowOpacity')/100},offset:{x:value('glowOffset'),y:value('glowOffset')},radius:value('glowBlur'),spread:0,showShadowBehindNode:false};
          // Alpha is sync-derived; binding the color would replace it with opaque ink.
          effect=figma.variables.setBoundVariableForEffect(effect,'radius',variable('glowBlur'));
          (style==='Text'?label:component).effects=[effect];
        }
        changed.add(component.id);changed.add(label.id);
      }
      const family=root.children.find(n=>n.name===`Family / ${style} / Motion=${motion}`);
      const identity=family.children.find(n=>n.name==='Identity and construction');
      const note=identity.children.filter(n=>n.type==='TEXT')[1];note.characters='6 variants\n'+study.note;changed.add(note.id);
      const variants=family.children.find(n=>n.name==='Variants · maximum five per line');
      const cards={};
      for(const instance of variants.findAllWithCriteria({types:['INSTANCE']})) {
        const main=await instance.getMainComponentAsync();cards[main.variantProperties.State]=instance.parent.parent;
      }
      const first=variants.children[0];
      let second=variants.children.find(n=>n.name==='Variant line 2');
      if(!second){second=figma.createAutoLayout('HORIZONTAL',{name:'Variant line 2',itemSpacing:first.itemSpacing});variants.appendChild(second);second.resize(first.width,1);second.layoutSizingHorizontal='FIXED';second.layoutSizingVertical='HUG';second.fills=[];created.add(second.id);}
      for(const [index,state] of states.entries()) {
        let card=cards[state];
        if(!card){card=cards.Default.clone();for(const n of [card,...card.findAll(()=>true)])created.add(n.id);}
        (index<5?first:second).insertChild(index<5?index:0,card);
        card.name='Variant / '+name(state);
        const instance=card.findAllWithCriteria({types:['INSTANCE']})[0];
        instance.swapComponent(components[state]);
        const texts=card.children.filter(n=>n.type==='TEXT');
        texts[0].characters=name(state).replace(', ','\n');
        texts[1].characters=`${Math.round(instance.width)} × ${Math.round(instance.height)} px`;
        const sourceText=texts.find(t=>t.characters.includes('Figma')&&!t.characters.startsWith('Construction'));
        if(sourceText)sourceText.characters='Figma\n'+components[state].id+'\n'+source.name;
        const paint=manifest.buttonStatePaints[style.toLowerCase()][state.toLowerCase()];
        const bindings=new Set();
        const collect=x=>{if(x&&typeof x==='object'){if(x.type==='VARIABLE_ALIAS')bindings.add(x.id);else Object.values(x).forEach(collect);}};
        for(const node of [instance,...instance.findAll(()=>true)]) {collect(node.boundVariables);if('fills'in node)collect(node.fills);if('effects'in node)collect(node.effects);}
        const lines=new Set([...bindings].map(id=>constructionBindingLabel(variables.find(v=>v.id===id),manifest,collections)));
        for(const item of Object.values(paint))lines.add(constructionTokenLabel(item));
        const construction=texts.find(t=>t.characters.startsWith('Construction\n'));
        construction.characters='Construction\n'+[...lines].sort().join('\n');
        for(const node of [family,variants,first,second,card,instance,...texts])changed.add(node.id);
      }
    }
  }
  return {createdNodeIds:[...created],mutatedNodeIds:[...changed],states,styles:['Tonal','Text'],motionModes:['Normal','Reduced'],prototype:'Static state specimens; success is host-confirmed only.'};
}
