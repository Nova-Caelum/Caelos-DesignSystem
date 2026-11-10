"""Compile the review sheet from catalog data; pipe its categories to foundation-sheet.js."""
import json
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]
leaves = runpy.run_path(str(ROOT / 'scripts/figma-catalog.py'))['leaves']

# Review categories describe physical quantities, never their consuming component.
CATEGORIES = {
    'color': ('Colour', 'Product palette colours. Each swatch shows its name, function and palette-backed hex.'),
    'space': ('Spacing', 'Reusable gaps, padding and insets. Values retain their existing approval status; this does not approve every off-grid use.'),
    'type': ('Typography', 'Font families and independent size, line-height, weight and optical parameters.'),
    'radius': ('Corner radius', 'Reusable corner curvature. A consuming recipe chooses its radius; fills and glows follow that shape.'),
    'size': ('Sizes', 'Reusable dimensions for widths, heights and glyphs. Large dimensions are labelled rather than drawn beyond the card.'),
    'border': ('Edge widths', 'Width parameters only. These do not authorize a hard outline. Focus uses the approved ink colour and soft glow.'),
    'motion': ('Motion', 'Duration, easing, distance, scale and spring parameters. Static specimens do not verify transitions; interaction approval remains separate.'),
    'opacity': ('Opacity', 'One shared opacity scale for fills, washes, tint and glow. Catalog fractions are bound as Figma percentages.'),
    'blur': ('Blur', 'Reusable blur radii. Their application to a backdrop or element belongs in the consuming recipe.'),
    'saturation': ('Saturation', 'Colour saturation multipliers. 1 means unchanged.'),
    'coverage': ('Coverage', 'Normalized overlap input for adaptive glass. The adaptive response belongs to the material recipe.'),
    'position': ('Gradient position', 'Normalized stop positions. The consuming gradient defines the colour and direction.'),
    'angle': ('Angles', 'Reusable gradient directions, expressed in degrees.'),
    'stack': ('Stack order', 'Relative layer ordering; this is not a complete application z-index scale.'),
    'ratio': ('Layout ratios', 'Unitless proportions. The consuming recipe supplies the reference dimension.'),
}

def manifest():
    base = list(leaves(json.loads((ROOT / 'token_catalog/00-foundations.tokens.json').read_text())))
    uses = {}
    for file in sorted((ROOT / 'token_catalog').glob('*.tokens.json')):
        if file.name.startswith('00-foundations'):
            continue
        for path, token in leaves(json.loads(file.read_text())):
            target = token['$value'][1:-1]
            uses.setdefault(target, set()).add(path)
    result = []
    for group, (title, purpose) in CATEGORIES.items():
        families = {}
        for path, token in base:
            if path.split('.')[1] != group:
                continue
            meta = token['$extensions']['app.caelos']
            family = meta['family']
            if group == 'motion' and family == 'base.motion.spring':
                # Spring coefficients are different quantities, not interchangeable variants.
                family = path
            label = meta.get('displayName', path.split('.')[-1])
            item = dict(path=path, name=meta['figmaName'], type=token['$type'], value=token['$value'],
                        label=label, status=meta['status'], evidence=meta.get('decision', 'No decision reference recorded'),
                        former=meta['formerPaths'], uses=sorted(uses.get(path, [])))
            families.setdefault(family, []).append(item)
        rows = []
        for family, items in families.items():
            def order(item):
                value = item['value']
                if isinstance(value, dict) and 'value' in value:
                    return (0, value['value'])
                if isinstance(value, (int, float)):
                    return (0, value)
                return (1, item['path'])
            if group != 'color':
                items.sort(key=order)
            rows.append(dict(name=family.removeprefix('base.').replace('.', ' / '), items=items))
        if rows:
            result.append(dict(key=group, title=title, purpose=purpose, rows=rows, maxPerLine=5))
    return result

if __name__ == '__main__':
    print(json.dumps(manifest(), separators=(',', ':')))
