"""Compile Tier 1 review metadata from the catalog, without copying token values."""
import json
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]
leaves = runpy.run_path(str(ROOT / 'scripts/figma-catalog.py'))['leaves']

CATEGORIES = {
    'typography': ('Typography', 'Text roles, font families, size, line height and tone. Existing composed roles remain studies where catalog coverage is partial.'),
    'icon': ('Icons', 'One specimen per glyph, with every recorded use together. Marks retain their artwork; dimensions and ink use foundation aliases.'),
    'spacing': ('Layout', 'Spacing relationships and density variants. The preview demonstrates a relationship; its recipe supplies the foundation-backed gap or inset.'),
    'surface': ('Surfaces', 'Layer colours and shared geometry. Fill and glow inherit the consuming surface curve; these parameters do not authorize hard outlines.'),
    'materials': ('Materials', 'Graph, cloud and glass construction. Dark mode is the v1 review scope. Static glass samples do not prove runtime overlap measurement.'),
    'scrollArea': ('Scrolling', 'Thumb, track and state parameters. Structural Violet is the current ink; obsolete colour comparisons are kept out of this review.'),
    'foundation': ('Separators', 'Fade studies and their existing aliases. Complete fade-stop roles remain unresolved; thickness does not imply a hard border.'),
    'recipes-focus': ('Focus', 'Hover-blue text or icon with a soft, shape-following glow. This is a state treatment, not a keyboard element or sharp outline.'),
}
# Existing component sets on the user-created duplicate page; never change the originals.
STUDIES = {
    'typography': [('Text roles', '362:4775')],
    'icon': [('Glyph', '362:4234')],
    'spacing': [('Relationships', '362:4829')],
    'surface': [('Surface layers', '362:4759')],
    'materials': [('Surface finish', '362:5099'), ('Cloud states', '362:5072'), ('Adaptive glass', '362:5255')],
    'scrollArea': [('Thumb states', '362:4858')],
    'foundation': [('Fade orientation', '362:4873')],
    'recipes-focus': [('Rest', '362:4884'), ('Focus', '362:4887')],
}

def manifest():
    source = json.loads((ROOT / 'token_catalog/01-primitives.tokens.json').read_text())
    tables = {}
    for mode in ['dark', 'light']:
        table = {}
        for filename in ['00-foundations.tokens.json', '00-semantic.dark.tokens.json', f'00-semantic.{mode}.tokens.json', '01-primitives.tokens.json']:
            table.update(dict(leaves(json.loads((ROOT / 'token_catalog' / filename).read_text()))))
        tables[mode] = table
    def resolve(path, mode):
        chain = []
        while True:
            if path in chain:
                raise ValueError('Alias cycle: ' + path)
            chain.append(path)
            value = tables[mode][path]['$value']
            if not isinstance(value, str) or not value.startswith('{'):
                return value, chain
            path = value[1:-1]
    uses = {}
    for file in sorted((ROOT / 'token_catalog').glob('*.tokens.json')):
        if file.name.startswith('00-'):
            continue
        for path, token in leaves(json.loads(file.read_text())):
            uses.setdefault(token['$value'][1:-1], set()).add(path)
    result = []
    for key, (title, purpose) in CATEGORIES.items():
        families = {}
        for path, token in leaves(source):
            group = path.split('.')[2]
            if ('materials' if group in ['graph', 'glass', 'cloud'] else group) != key:
                continue
            meta = token['$extensions']['app.caelos']
            dark, chain = resolve(path, 'dark')
            light, light_chain = resolve(path, 'light')
            family = '.'.join(path.split('.')[2:-1])
            item = dict(path=path, name=meta.get('figmaName', path.replace('.', '/')), type=token['$type'], value=dark,
                        label=(tables['dark'][chain[-1]].get('$extensions', {}).get('app.caelos', {}).get('displayName', '') + ' · ' + path.split('.')[-1]).strip(' ·') if token['$type'] == 'color' else path.split('.')[-1], status=meta['status'], evidence=meta.get('decision', ', '.join(meta.get('decisions', [])) or 'No decision reference recorded'),
                        uses=sorted(uses.get(path, [])), chain=chain[1:], light=light if light != dark else None,
                        lightChain=light_chain[1:] if light != dark else [], description=token.get('$description', ''))
            css = None
            suffix = path.removeprefix('primitives.shared.')
            if suffix.startswith(('cloud.', 'graph.')):
                css = suffix.replace('.', '-')
            elif suffix.startswith('surface.layer.'):
                css = suffix.removeprefix('surface.').replace('.', '-')
            elif suffix.startswith(('glass.panel.', 'glass.menu.')):
                css = suffix.removeprefix('glass.').replace('.', '-')
            elif suffix in ['glass.' + n for n in ['body', 'foreground', 'tint-ink', 'sage', 'sage-blur', 'overlap-clear', 'overlap-covered', 'saturation-neutral', 'sage-opacity', 'falloff-at']]:
                css = suffix.removeprefix('glass.')
            item['css'] = '--caelos-material-' + css if css else None
            families.setdefault(family, []).append(item)
        result.append(dict(key=key, title=title, purpose=purpose, maxPerLine=5,
                           rows=[dict(name=name.replace('.', ' / '), items=items) for name, items in families.items()],
                           studies=[dict(name=name, id=id) for name, id in STUDIES[key]]))
    covered = [item['path'] for category in result for row in category['rows'] for item in row['items']]
    expected = [path for path, _ in leaves(source)]
    if len(covered) != len(set(covered)) or set(covered) != set(expected):
        raise ValueError('Every primitive token must appear exactly once in the review sheet')
    # Include unimplemented inventory entries explicitly, without inventing a visual implementation.
    pending = []
    for group_name, group in source['primitives'].items():
        if group_name.startswith('$'):
            continue
        for name, entry in group.items():
            if name.startswith('$'):
                continue
            meta = entry.get('$extensions', {}).get('app.caelos', {})
            if meta.get('status') == 'open':
                pending.append(dict(path=f'primitives.{group_name}.{name}', name=name,
                    description=entry.get('$description', ''), variants=meta.get('variants', {}), states=meta.get('states', [])))
    glossary = source['primitives']['shared']['icon']['$extensions']['app.caelos']['glossary']
    meanings = {}
    for group, entries in glossary.items():
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict) and 'glyph' in entry:
                    meanings.setdefault(entry['glyph'], []).append(entry.get('action', entry.get('meaning', '')))
    return dict(pageId='362:4233', sourcePageId='187:5380', templatePageId='234:6889',
                categories=result, pending=pending, meanings=meanings,
                glyphFit=runpy.run_path(str(ROOT / 'scripts/glyph-fit-plan.py'))['glyph_plan'](),
                tokenCount=sum(len(r['items']) for c in result for r in c['rows']))

if __name__ == '__main__':
    print(json.dumps(manifest(), separators=(',', ':')))
