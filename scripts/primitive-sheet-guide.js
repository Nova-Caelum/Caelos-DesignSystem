// Add the reading guide and explicitly unimplemented inventory; arrange like Tier 0.
async function finishPrimitiveSheet(manifest) {
  const page=await figma.getNodeByIdAsync(manifest.pageId);await figma.setCurrentPageAsync(page);
  const ids=[],mutated=[];
  if(page.children.some(n=>n.name==='Tier 1 / Review guide'))throw Error('Guide already exists; inspect before updating');
  for(const style of ['Regular','Medium','SemiBold'])await figma.loadFontAsync({family:'Caelum Sans',style});
  const fonts=page.findAllWithCriteria({types:['TEXT']}).flatMap(t=>t.getStyledTextSegments(['fontName']).map(s=>s.fontName));
  for(const font of new Map(fonts.map(f=>[JSON.stringify(f),f])).values())await figma.loadFontAsync(font);
  const focus=page.children.find(n=>n.name==='Category / Focus');
  const rest=focus?.children.find(n=>n.name==='Family / Rest'),focused=focus?.children.find(n=>n.name==='Family / Focus');
  if(rest&&focused){
    const line=rest.children[1].children[0],other=focused.children[1].children[0];
    for(const card of [...other.children]){line.appendChild(card);mutated.push(card.id);}
    rest.name='Family / Interaction states';
    const heading=rest.children[0].children[0],caption=rest.children[0].children[1];
    heading.characters='Interaction states';caption.characters=caption.characters.replace('1 variants','2 variants');
    mutated.push(rest.id,heading.id,caption.id,focused.id);focused.remove();
  }
  const vars=await figma.variables.getLocalVariablesAsync(),byName=new Map(vars.map(v=>[v.name,v]));
  const base=(await figma.variables.getLocalVariableCollectionsAsync()).find(c=>c.name==='00 Base');
  const paint=name=>{const v=byName.get('color/'+name);if(!v)throw Error('Missing variable color/'+name);const {r,g,b,a=1}=v.resolveForConsumer(page.children[0]).value;return figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r,g,b},opacity:a},'color',v);};
  function frame(parent,name,width,axis='VERTICAL'){const n=figma.createAutoLayout(axis);ids.push(n.id);n.name=name;n.fills=[];n.itemSpacing=12;n.resize(width,1);parent.appendChild(n);n.layoutSizingHorizontal='FIXED';n.layoutSizingVertical='HUG';return n;}
  function text(parent,s,w,size=byName.get('type/size/px-12').valuesByMode[base.defaultModeId],ink='text-supporting',style='Regular'){const n=figma.createText();ids.push(n.id);n.name=s.split('\n')[0].slice(0,90);n.fontName={family:'Caelum Sans',style};n.fontSize=size;n.characters=s;n.fills=[paint(ink)];n.resize(w,1);n.textAutoResize='HEIGHT';parent.appendChild(n);n.layoutSizingHorizontal='FIXED';return n;}
  const guide=frame(page,'Tier 1 / Review guide',7200);guide.x=100;guide.y=-300;
  text(guide,'Tier 1 · Primitive families',7200,32,'text-primary','SemiBold');
  text(guide,manifest.tokenCount+' catalog parameters · 9 categories including open inventory. Each family stays together, with no more than five variants per line. Specimens show the existing components; parameter rows below expose their foundation sources.',7200,16);
  text(guide,'READING THE SHEET · Name and purpose → value and variable-bound specimen → construction and evidence → review status and downstream uses.\nCanon / partial / provisional retain catalog status; they are not new approval. STUDY means an existing visual specimen awaiting review. OPEN is a historical inventory status, not proof that no glyph or study exists; those may appear elsewhere on this sheet. Dark mode is v1; light values are reference-only.\nPanda names are shown only where a CSS export exists in the material preset. Other entries say no standalone export. Static motion, glass overlap and unsupported gradient parameters still need runtime verification. The original Tier 1 page is preserved; duplicated source masters are hidden on this page.',7200,13);
  // Upgrade annotations on the already-rendered token cards from the same manifest.
  for(const category of manifest.categories){const root=page.children.find(n=>n.name==='Category / '+category.title);if(!root)throw Error('Missing category '+category.title);
    const texts=root.findAllWithCriteria({types:['TEXT']});
    for(const group of category.rows)for(const item of group.items){const label=texts.find(n=>n.characters.includes('Catalog · '+item.path)&&n.characters.endsWith(item.path));if(!label)throw Error('Missing card '+item.path);const card=label.parent;
      if(!card.children.some(n=>n.type==='TEXT'&&n.characters.startsWith('Panda · ')))text(card,'Panda · '+(item.css?'var('+item.css+')':'No standalone token export'),260);
    }
    for(const t of root.findAllWithCriteria({types:['TEXT']}))if(t.characters.includes('Tier 1 parameters → Tier 0')){t.characters=t.characters.replace('Panda token export · not implemented','Panda · see individual cards');mutated.push(t.id);}
  }
  const open=frame(page,'Category / Open inventory',1728);open.paddingLeft=open.paddingRight=open.paddingTop=open.paddingBottom=36;open.itemSpacing=28;open.fills=[paint('elevated')];open.cornerRadius=18;
  text(open,'Open inventory',1656,32,'text-primary','SemiBold');text(open,'Historical entries still marked open in the catalog. Some overlap the glyphs or studies above; their recipe status and tier placement need reconciliation.',1656,16);
  text(open,'TIER 1 · Inventory only • no fabricated specimens • implementation and tier placement await reconciliation',1656,12);
  for(const scope of [...new Set(manifest.pending.map(p=>p.path.split('.')[1]))]){
    const entries=manifest.pending.filter(p=>p.path.split('.')[1]===scope),r=frame(open,'Family / '+scope,1656,'HORIZONTAL');r.itemSpacing=24;
    const identity=frame(r,'Identity and construction',252);text(identity,scope+' inventory',252,21,'text-primary','Medium');text(identity,entries.length+' open entries\nNo complete construction or Panda export\nListed variants are historical declarations, not verified implementations',252,13);
    const vs=frame(r,'Entries · maximum five per line',1380);let line;
    for(let i=0;i<entries.length;i++){if(i%5===0){line=frame(vs,'Inventory line '+(1+Math.floor(i/5)),1380,'HORIZONTAL');line.itemSpacing=20;}const e=entries[i],c=frame(line,'Open / '+e.path,260);text(c,e.name,260,14,'text-primary','Medium');text(c,'OPEN · INVENTORY STATUS',260,12,'peach-gold','SemiBold');text(c,e.description||'No purpose recorded',260,12);text(c,'Catalog · '+e.path,260,12);text(c,'Declared variants\n'+(Object.entries(e.variants).map(([k,v])=>k+' · '+v.join(', ')).join('\n')||'None recorded'),260,12);if(e.states.length)text(c,'Declared states\n'+e.states.join(', '),260,12);}
  }
  const columns=[['Typography','Focus','Separators'],['Icons','Open inventory'],['Materials'],['Layout','Surfaces','Scrolling']];
  for(let col=0;col<columns.length;col++){let y=100;for(const title of columns[col]){const n=page.children.find(n=>n.name==='Category / '+title);n.x=100+col*1836;n.y=y;y+=n.height+108;mutated.push(n.id);}}
  return {createdNodeIds:ids,mutatedNodeIds:mutated,guideId:guide.id,openId:open.id,pending:manifest.pending.length,categories:page.children.filter(n=>n.name.startsWith('Category / ')).map(n=>({id:n.id,name:n.name,width:n.width,height:n.height,x:n.x,y:n.y}))};
}
