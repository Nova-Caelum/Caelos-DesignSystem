// Figma Plugin API renderer. Supply a catalog-derived category and target page ID.
async function renderFoundationCategory(category, pageId, oldId) {
  const page = await figma.getNodeByIdAsync(pageId);
  await figma.setCurrentPageAsync(page);
  const old = oldId ? await figma.getNodeByIdAsync(oldId) : page.children.find(n => n.name === 'Category / ' + category.title);
  const fonts = ['Regular', 'Medium', 'SemiBold'].map(style => ({family:'Caelum Sans', style}));
  fonts.push({family:'Caelum Mono', style:'Regular'}, {family:'Yrsa', style:'Regular'});
  if (old) for (const t of old.findAllWithCriteria({types:['TEXT']})) {
    fonts.push(...t.getStyledTextSegments(['fontName']).map(s => s.fontName));
  }
  for (const font of new Map(fonts.map(f => [JSON.stringify(f),f])).values()) await figma.loadFontAsync(font);
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const base = collections.find(c => c.name === '00 Base');
  const all = await figma.variables.getLocalVariablesAsync();
  const variables = new Map(all.filter(v => v.variableCollectionId === base.id).map(v => [v.name,v]));
  const ids = [];
  const paint = name => {
    const variable = variables.get(name);
    if (!variable) throw Error('Missing colour variable: ' + name);
    const {r,g,b,a = 1} = variable.valuesByMode[base.defaultModeId];
    return figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r,g,b},opacity:a},'color',variable);
  };
  function frame(parent, name, width, axis = 'VERTICAL') {
    const node = figma.createAutoLayout(axis);
    ids.push(node.id); node.name = name; node.fills = []; node.itemSpacing = 12;
    node.resize(width,1); parent.appendChild(node);
    node.layoutSizingHorizontal = 'FIXED'; node.layoutSizingVertical = 'HUG';
    return node;
  }
  function text(parent, value, width, size = variables.get('type/size/px-14').valuesByMode[base.defaultModeId], ink = 'text-primary', style = 'Regular', family = 'Caelum Sans') {
    const node = figma.createText(); ids.push(node.id);
    node.name = value.split('\n')[0].slice(0,100); node.fontName = {family,style}; node.fontSize = size;
    node.characters = value; node.fills = [paint('color/' + ink)];
    node.resize(width,1); node.textAutoResize = 'HEIGHT'; parent.appendChild(node);
    node.layoutSizingHorizontal = 'FIXED'; return node;
  }
  function display(item) {
    const v = item.value;
    if (item.type === 'color') return v.hex.toUpperCase();
    if (Array.isArray(v)) return 'cubic-bezier\n' + v.join(', ');
    if (typeof v === 'object') return v.value + ' ' + v.unit;
    if (item.path.startsWith('base.opacity.')) return Number((v * 100).toFixed(4)) + '%';
    return String(v);
  }
  function specimen(parent, item) {
    const width = 260, variable = variables.get(item.name);
    if (!variable) throw Error('Missing foundation variable: ' + item.name);
    const card = frame(parent, 'Variant / ' + item.path, width);
    const label = text(card, item.label, width, 14, 'text-primary', 'Medium');
    label.resize(width,48); label.textAutoResize = 'NONE';
    const value = text(card, display(item), width, 22, 'text-primary', 'Medium');
    value.resize(width,60); value.textAutoResize = 'NONE';
    if (item.type === 'color') {
      const caption = all.find(v => v.name === 'hex/' + item.path.split('.').at(-1));
      if (caption) { value.fontSize = 16; value.setBoundVariable('characters', caption); }
    }
    const view = frame(card, 'Specimen / ' + item.path, width, 'HORIZONTAL');
    view.resize(width,72); view.layoutSizingVertical = 'FIXED'; view.counterAxisAlignItems = 'CENTER';
    view.paddingLeft = 12; view.paddingRight = 12; view.fills = [paint('color/ground')]; view.cornerRadius = 6;
    function rectangle(w, h, colour = 'structural-violet') {
      const shape = figma.createRectangle(); ids.push(shape.id); view.appendChild(shape);
      shape.resize(w,h); shape.fills = [paint('color/' + colour)]; return shape;
    }
    const p = item.path, v = item.value;
    if (item.type === 'color') {
      const shape = rectangle(236,48); shape.cornerRadius = 6; shape.fills = [paint(item.name)];
    } else if (p.startsWith('base.type.family.')) {
      if (String(v).includes('Micro')) text(view,'Font asset unavailable',236,13,'peach-gold');
      else text(view,'Aa · 0O · Caelos',236,24,'text-primary','Regular',v).setBoundVariable('fontFamily',variable);
    } else if (p.startsWith('base.type.size.')) {
      text(view,'Aa · Caelos',236,v.value).setBoundVariable('fontSize',variable);
    } else if (p.startsWith('base.type.line.')) {
      const a = text(view,'Aa · line height',236,14); a.lineHeight = {unit:'PIXELS',value:v.value}; a.setBoundVariable('lineHeight',variable);
    } else if (p.startsWith('base.type.weight.')) {
      text(view,'Aa · Caelos',236,20,'text-primary',{400:'Regular',500:'Medium',600:'SemiBold'}[v]).setBoundVariable('fontWeight',variable);
    } else if (p.startsWith('base.radius.')) {
      const shape = rectangle(156,48); shape.cornerRadius = v.value;
      for (const edge of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius']) shape.setBoundVariable(edge,variable);
    } else if (p.startsWith('base.space.') || p.startsWith('base.size.')) {
      if (v.value > 236) text(view,'Dimension exceeds preview\nSee exact value above',236,13,'text-supporting');
      else if (v.value === 0) text(view,'0 · no gap',236,13,'text-supporting');
      else rectangle(v.value,20).setBoundVariable('width',variable);
    } else if (p.startsWith('base.opacity.')) {
      const shape = rectangle(156,40,'text-primary'); shape.cornerRadius = 6; shape.setBoundVariable('opacity',variable);
    } else {
      text(view,p.startsWith('base.motion.')?'Static parameter\nInteraction review required':p.startsWith('base.border.')?'Width only\nNo hard outline implied':'Parameter\nSee exact value above',236,13,'text-supporting');
    }
    text(card, item.status.toUpperCase(),width,12,item.status === 'canon'?'success':'peach-gold','SemiBold');
    text(card,'Figma · ' + item.name + '\nCatalog · ' + item.path,width,12,'text-supporting');
    text(card,'Evidence · ' + item.evidence,width,12,'text-supporting');
    if (item.uses.length) text(card,'Used by\n' + item.uses.join('\n'),width,12,'text-supporting');
    if (item.former.length > 1 || item.former[0] !== item.path) text(card,'Former names\n' + item.former.join('\n'),width,12,'text-supporting');
  }
  const root = frame(page,'Category / ' + category.title,1728);
  root.x = old?.x ?? 100; root.y = old?.y ?? 100;
  root.paddingLeft = root.paddingRight = root.paddingTop = root.paddingBottom = 36;
  root.itemSpacing = 28; root.fills = [paint('color/elevated')]; root.cornerRadius = 18;
  text(root,category.title,1656,32,'text-primary','SemiBold');
  text(root,category.purpose,1656,16,'text-supporting');
  text(root,'TIER 0 · Raw foundations • source values retained • new grouping awaits visual approval',1656,12,'text-supporting');
  for (const row of category.rows) {
    const family = frame(root,'Family / ' + row.name,1656,'HORIZONTAL'); family.itemSpacing = 24;
    const identity = frame(family,'Identity and construction',252);
    text(identity,row.name,252,21,'text-primary','Medium');
    text(identity,row.items.length + ' variants\nRaw values · no lower-tier dependency\nPanda token export · not implemented',252,13,'text-supporting');
    const variants = frame(family,'Variants · maximum five per line',1380);
    for (let start = 0; start < row.items.length; start += category.maxPerLine) {
      const line = frame(variants,'Variant line ' + (1 + start / category.maxPerLine),1380,'HORIZONTAL'); line.itemSpacing = 20;
      for (const item of row.items.slice(start,start + category.maxPerLine)) specimen(line,item);
    }
  }
  if (old) old.remove();
  return {id:root.id,ids,category:category.key,families:category.rows.length,tokens:category.rows.reduce((n,r)=>n+r.items.length,0),width:root.width,height:root.height};
}
