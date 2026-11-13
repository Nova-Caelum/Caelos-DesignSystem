// Evaluate primitive-sheet.js before this targeted refresh of the existing clean sheet.
async function refreshBadgeStudy(figma, manifest) {
  const page=await figma.getNodeByIdAsync(manifest.pageId);
  await figma.setCurrentPageAsync(page);
  const changed=new Set(), evidence=[];
  const fonts=new Map();
  for(const t of page.findAllWithCriteria({types:['TEXT']}))
    for(const s of t.getStyledTextSegments(['fontName'])) fonts.set(JSON.stringify(s.fontName),s.fontName);
  await Promise.all([...fonts.values()].map(font=>figma.loadFontAsync(font)));
  const setText=(node,value)=>{if(node.characters!==value){node.characters=value;changed.add(node.id);}};
  const shared=manifest.categories.find(c=>c.key==='shared-controls');
  const root=page.children.find(n=>n.name==='Category / '+shared.title);
  const archive=await figma.getNodeByIdAsync('412:998');
  // Preserve retired review cards in the archive; never remove their foundations.
  for(const group of shared.rows) {
    const family=root.children.find(n=>n.name==='Family / '+group.name);
    for(const t of family.findAllWithCriteria({types:['TEXT']}).filter(t=>t.characters.includes('\nCatalog · '))) {
      const path=t.characters.split('\nCatalog · ')[1];
      const item=group.items.find(i=>i.path===path), card=t.parent;
      if(!item) {
        changed.add(card.parent.id); archive.appendChild(card);card.x=0;card.y=12000;
        changed.add(card.id);changed.add(archive.id);
      } else {
        const uses=card.children.find(n=>n.type==='TEXT'&&n.characters.startsWith('Used by\n'));
        if(uses) setText(uses,'Used by\n'+item.uses.join('\n'));
      }
    }
  }
  const appended=await renderPrimitiveCategory(shared,manifest,true);
  for(const id of appended.mutatedNodeIds)changed.add(id);
  for(const group of shared.rows) {
    const family=root.children.find(n=>n.name==='Family / '+group.name);
    const wrapper=family.children.find(n=>n.name==='Variants · maximum five per line');
    const cards=wrapper.children.flatMap(line=>[...line.children]);
    for(let i=0;i<group.items.length;i++) {
      const card=cards.find(c=>c.findAllWithCriteria({types:['TEXT']}).some(t=>t.characters.endsWith('\nCatalog · '+group.items[i].path)));
      const line=wrapper.children[Math.floor(i/5)];
      if(line.children[i%5]!==card) {
        line.insertChild(i%5,card);changed.add(line.id);changed.add(card.id);
      }
    }
  }
  const category=manifest.categories.find(c=>c.key==='badges'), study=category.studies[0];
  const gallery=page.children.find(n=>n.name==='Category / '+category.title);
  const data=manifest.compactControls;
  for(const family of gallery.children.filter(n=>n.name.startsWith('Family / Badge / '))) {
    const note=family.children[0].children.find(n=>n.type==='TEXT'&&n.characters.startsWith('4 variants\n'));
    setText(note,'4 variants\n'+study.note);
    for(const instance of family.findAllWithCriteria({types:['INSTANCE']})) {
      const master=await instance.getMainComponentAsync();
      const card=instance.parent.parent, shape=master.variantProperties.Shape, tone=master.variantProperties.Tone.toLowerCase();
      const size=card.children.find(n=>n.type==='TEXT'&&/ × .* px$/.test(n.characters));
      setText(size,instance.width+' × '+instance.height+' px');
      const ingredients=[data.badgeShapes[shape],data.badgeTones[tone],...Object.values(data.badgeMaterial)];
      const construction=card.children.find(n=>n.type==='TEXT'&&/^(State|Tone) construction\n/.test(n.characters));
      setText(construction,'Tone construction\n'+[...new Set(ingredients.map(constructionTokenLabel))].join('\n'));
      evidence.push({id:instance.id,source:master.id,shape,tone,width:instance.width,height:instance.height,
        padding:[instance.paddingLeft,instance.paddingRight,instance.paddingTop,instance.paddingBottom],
        radius:instance.topLeftRadius,fills:instance.fills.length,strokes:instance.strokes.length,
        effects:instance.effects.map(e=>e.type),reactions:instance.reactions.length});
    }
  }
  // Only move category containers to accommodate their expanded annotations.
  const columns=[['Buttons','Fields','Composer references'],['Chips','Tabs','Triggers and links'],['Badges','Avatars','Indicators']];
  for(const column of columns) {
    let y=root.y+root.height+100;
    for(const title of column) {
      const n=page.children.find(n=>n.name==='Category / '+title);
      if(n.y!==y){n.y=y;changed.add(n.id);}
      y+=n.height+100;
    }
  }
  return {createdNodeIds:appended.createdNodeIds,mutatedNodeIds:[...changed],badges:evidence,
    galleryId:gallery.id,galleryBounds:{x:gallery.x,y:gallery.y,width:gallery.width,height:gallery.height}};
}
