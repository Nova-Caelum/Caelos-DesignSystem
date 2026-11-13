/* Shared Figma glyph fitting. Evaluate this file in use_figma, then call fitGlyphGallery. */
function unionPaintBounds(rectangles) {
  if (!rectangles.length || rectangles.some(r => !r || ![r.x, r.y, r.width, r.height].every(Number.isFinite))) {
    throw new Error('Missing or non-finite painted bounds');
  }
  const x = Math.min(...rectangles.map(r => r.x));
  const y = Math.min(...rectangles.map(r => r.y));
  const width = Math.max(...rectangles.map(r => r.x + r.width)) - x;
  const height = Math.max(...rectangles.map(r => r.y + r.height)) - y;
  if (width <= 0 || height <= 0) throw new Error('Empty painted bounds');
  return { x, y, width, height };
}
function glyphFitPlan(bounds, frame, coverage, intrinsic = false) {
  if (!(coverage > 0 && coverage <= 1) || ![frame.width, frame.height].every(v => Number.isFinite(v) && v > 0)) {
    throw new Error('Invalid glyph frame or coverage');
  }
  unionPaintBounds([bounds]);
  const side = Math.max(bounds.width, bounds.height) / coverage;
  const width = intrinsic ? side : frame.width;
  const height = intrinsic ? side : frame.height;
  return { width, height, scale: Math.min(width * coverage / bounds.width, height * coverage / bounds.height) };
}
function glyphFitViolations(bounds, frame, coverage, tolerance = 0.002) {
  unionPaintBounds([bounds]);
  const errors = [];
  if (Math.abs(Math.max(bounds.width / frame.width, bounds.height / frame.height) - coverage) > tolerance) errors.push('coverage');
  if (Math.abs(bounds.x + bounds.width / 2 - frame.x - frame.width / 2) > tolerance ||
      Math.abs(bounds.y + bounds.height / 2 - frame.y - frame.height / 2) > tolerance) errors.push('centering');
  return errors;
}
function paintedGlyphNodes(root) {
  // Frames have render bounds even with no paint; they must not count as artwork.
  return root.findAll(n => ['VECTOR', 'ELLIPSE', 'RECTANGLE', 'LINE', 'POLYGON', 'STAR', 'BOOLEAN_OPERATION'].includes(n.type))
    .filter(n => {
      for (let p = n; p && p !== root; p = p.parent) if (!p.visible || p.opacity === 0) return false;
      return ['fills', 'strokes'].some(key => Array.isArray(n[key]) && n[key].some(p => p.visible !== false && p.opacity !== 0));
    });
}
async function fitGlyphGallery(figma, config, apply = false, onlyGlyphs = null) {
  const page = await figma.getNodeByIdAsync(config.pageId);
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  const set = await figma.getNodeByIdAsync(config.componentSetId);
  const gallery = await figma.getNodeByIdAsync(config.galleryId);
  const coverageVar = await figma.variables.getVariableByIdAsync(config.coverageVariableId);
  if (!coverageVar) throw new Error('Coverage variable is missing');
  const mutated = new Set();
  const result = [];
  const instances = gallery.findAllWithCriteria({ types: ['INSTANCE'] });
  const specimens = new Map();
  for (const instance of instances) {
    const main = await instance.getMainComponentAsync();
    if (main && main.parent && main.parent.id === set.id) specimens.set(main.id, instance);
  }
  for (const master of set.children) {
    const glyph = master.name.replace(/^Glyph=/, '');
    if (onlyGlyphs && !onlyGlyphs.includes(glyph)) continue;
    const instance = specimens.get(master.id);
    if (!instance || master.children.length !== 1) throw new Error('Expected one artwork and one specimen: ' + glyph);
    const artwork = master.children[0];
    const measure = () => unionPaintBounds(paintedGlyphNodes(instance).map(n => n.absoluteRenderBounds));
    const before = measure();
    const frameBefore = { width: instance.width, height: instance.height };
    const coverage = coverageVar.resolveForConsumer(instance).value;
    if (Math.abs(coverage - config.coverage) > 0.000001) throw new Error('Catalog/Figma coverage drift');
    const intrinsic = config.intrinsicGlyphs.includes(glyph);
    const plan = glyphFitPlan(before, frameBefore, coverage, intrinsic);
    const descendants = artwork.findAll(() => true);
    const strokes = descendants.filter(n => typeof n.strokeWeight === 'number').map(n => [n, n.strokeWeight]);
    if (apply) {
      // The icon's imported viewport is not the artwork center. Keep the glyph
      // frame in parent auto-layout, but position its internal artwork by bounds.
      if (master.layoutMode !== 'NONE') artwork.layoutPositioning = 'ABSOLUTE';
      if (intrinsic) {
        for (const node of [master, instance]) {
          node.setBoundVariable('width', null); node.setBoundVariable('height', null);
          node.resizeWithoutConstraints(plan.width, plan.height); mutated.add(node.id);
        }
      }
      // Figma render bounds include strokes. Re-measure after restoring line weights,
      // rather than estimating outlines from the SVG viewport or changing stroke weight.
      for (let attempt = 0; !intrinsic && attempt < 16; attempt++) {
        const bounds = measure();
        const next = glyphFitPlan(bounds, instance, coverage);
        if (Math.abs(next.scale - 1) < 0.00002) break;
        artwork.rescale(next.scale);
        for (const [node, weight] of strokes) node.strokeWeight = weight;
        mutated.add(artwork.id); descendants.forEach(n => mutated.add(n.id));
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const bounds = measure();
        const frame = instance.absoluteBoundingBox;
        const dx = frame.x + instance.width / 2 - bounds.x - bounds.width / 2;
        const dy = frame.y + instance.height / 2 - bounds.y - bounds.height / 2;
        if (Math.abs(dx) <= 0.002 && Math.abs(dy) <= 0.002) break;
        artwork.x += dx;
        artwork.y += dy;
      }
      mutated.add(artwork.id);
      master.description = `Artwork coverage: primitives.shared.icon.artwork-coverage. ${intrinsic ? 'Intrinsic artwork preserved; frame derived from coverage.' : 'Frame size preserved; geometry uniformly fitted with source stroke weights.'} Control recipes own tap-target padding.`;
      mutated.add(master.id);
    }
    const after = measure();
    const frame = instance.absoluteBoundingBox;
    const errors = glyphFitViolations(after, frame, coverage);
    const strokeChanges = strokes.filter(([node, weight]) => Math.abs(node.strokeWeight - weight) > 0.000001).length;
    if (strokeChanges) errors.push('stroke-weight');
    if (intrinsic && (Math.abs(after.width - before.width) > 0.002 || Math.abs(after.height - before.height) > 0.002)) errors.push('intrinsic-size');
    if (!intrinsic && (instance.width !== frameBefore.width || instance.height !== frameBefore.height)) errors.push('frame-size');
    result.push({ glyph, masterId: master.id, instanceId: instance.id, before, after, frame, coverage, intrinsic, strokeChanges, errors });
  }
  return { mutatedNodeIds: [...mutated], count: result.length, failures: result.filter(r => r.errors.length), results: result };
}
if (typeof module !== 'undefined') module.exports = { unionPaintBounds, glyphFitPlan, glyphFitViolations, paintedGlyphNodes };

async function updateGlyphLabels(figma, config, results) {
  const gallery = await figma.getNodeByIdAsync(config.galleryId);
  const fonts = gallery.findAllWithCriteria({ types: ['TEXT'] }).flatMap(t => t.getStyledTextSegments(['fontName']).map(s => s.fontName));
  for (const font of new Map(fonts.map(f => [JSON.stringify(f), f])).values()) await figma.loadFontAsync(font);
  const ids = [];
  const rounded = value => Number(value.toFixed(2));
  for (const item of results) {
    const instance = await figma.getNodeByIdAsync(item.instanceId);
    const card = instance.parent.parent;
    const texts = card.children.filter(n => n.type === 'TEXT');
    texts[1].characters = `Frame · ${rounded(item.frame.width)} × ${rounded(item.frame.height)} px\nArt · ${rounded(item.after.width)} × ${rounded(item.after.height)} px`;
    ids.push(texts[1].id);
    const construction = texts.find(n => n.characters.startsWith('Construction'));
    const lines = construction.characters.split('\n').filter(line => !line.startsWith('Computed ·') && !(item.intrinsic && line === 'primitives/shared/icon/size'));
    lines.push('Computed · ' + config.primitiveName);
    construction.characters = lines.join('\n'); ids.push(construction.id);
  }
  return ids;
}
