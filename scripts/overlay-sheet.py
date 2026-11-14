"""Compile the Tier 3 review from catalog metadata; no product recipe is emitted."""
import copy
import json
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]
leaves = runpy.run_path(str(ROOT / 'scripts/figma-catalog.py'))['leaves']
BEHAVIORS = {'anchoring', 'opening', 'outsideDismiss', 'escape', 'focus', 'scrollAndClipping', 'reducedMotion'}


def validate_review(catalog):
    root = catalog['overlays']
    review = root['$extensions']['app.caelos']['review']
    inventory = {f'overlays.{scope}.{name}' for scope, group in root.items() if not scope.startswith('$') for name in group if not name.startswith('$')}
    families = review['families']
    keys = [f['key'] for f in families]
    grouped = [key for category in review['categories'] for key in category['families']]
    members = [path for family in families for path in family['members']]
    if len(keys) != len(set(keys)) or sorted(keys) != sorted(grouped):
        raise ValueError('Every family must have exactly one category')
    if len(members) != len(set(members)) or set(members) != inventory:
        raise ValueError('Every inventory entry must belong to exactly one family')
    for family in families:
        if set(family['behavior']) != BEHAVIORS or not all(family['behavior'].values()):
            raise ValueError('All behavior dimensions must be explicit: ' + family['key'])
        if not all(family.get(k) for k in ['approval', 'implementation', 'verification', 'openDependencies', 'sourceFiles']):
            raise ValueError('Missing evidence or status: ' + family['key'])
    return review


def manifest(catalog=None):
    if catalog is None:
        catalog = json.loads((ROOT / 'token_catalog/03-overlays.tokens.json').read_text())
    review = copy.deepcopy(validate_review(catalog))
    tables = {}
    for mode in ['dark', 'light']:
        table = {}
        for filename in ['00-foundations.tokens.json', '00-semantic.dark.tokens.json', f'00-semantic.{mode}.tokens.json', '01-primitives.tokens.json', '02-controls.tokens.json']:
            table.update(dict(leaves(json.loads((ROOT / 'token_catalog' / filename).read_text()))))
        table.update(dict(leaves(catalog)))
        tables[mode] = table

    def resolve(path, mode):
        chain = []
        while path not in chain:
            chain.append(path)
            value = tables[mode][path]['$value']
            if not isinstance(value, str) or not value.startswith('{'):
                return value, chain
            path = value[1:-1]
        raise ValueError('Alias cycle: ' + path)

    def ingredient(path):
        token = tables['dark'][path]
        value, chain = resolve(path, 'dark')
        light, _ = resolve(path, 'light')
        meta = token['$extensions']['app.caelos']
        terminal = tables['dark'][chain[-1]]['$extensions']['app.caelos']
        return dict(path=path, name=meta.get('figmaName', path.replace('.', '/')), collection='00 Base' if path.startswith('base.') else '01 Semantic' if path.startswith('sys.') else '02 Control recipes', value=value, light=light if light != value else None, type=token['$type'], status=meta['status'], colorName=terminal.get('displayName', terminal.get('paletteRole', '')), decision=meta.get('decision', meta.get('note', 'No independent decision recorded')), chain=chain)

    tier3 = dict(leaves(catalog))
    for family in review['families']:
        ingredients = {}
        aliases = []
        for prefix in family.pop('construction'):
            selected = [p for p in tables['dark'] if p == prefix or p.startswith(prefix + '.')]
            if not selected:
                raise ValueError('Missing construction dependency: ' + prefix)
            for path in selected:
                if path in tier3:
                    alias = ingredient(path)
                    target = tier3[path]['$value'][1:-1]
                    if target.startswith('overlays.'):
                        raise ValueError('Tier 3 construction must point down')
                    alias['ingredient'] = target
                    aliases.append(alias)
                    ingredients[target] = ingredient(target)
                else:
                    ingredients[path] = ingredient(path)
        family['ingredients'] = list(ingredients.values())
        family['aliases'] = aliases
        family['panda'] = ('materialRecipe({ finish: "glass" }) · shared material only; complete overlay recipe absent' if any(i['path'].startswith('primitives.shared.glass.') for i in family['ingredients']) else 'No complete Tier 3 recipe export')
        family['sourceUrls'] = ['https://github.com/' + review['source']['repository'] + '/blob/' + review['source']['commit'] + '/' + f for f in family['sourceFiles']]
    # Menu and Select share timing; aliases stay attached to each family, but
    # the construction table is rendered once per category, not as extra swatches.
    by_key = {f['key']: f for f in review['families']}
    for category in review['categories']:
        category['families'] = [by_key[k] for k in category['families']]
        ingredients = {i['path']: i for f in category['families'] for i in f['ingredients']}
        category['ingredients'] = list(ingredients.values())
    coverage = {a['path'] for f in review['families'] for a in f['aliases']}
    if coverage != set(tier3):
        raise ValueError('Unrepresented overlay token')
    review.update(tier=3, pageName='T3 Overlays & feedback Clean', tokenCount=len(tier3), inventoryCount=sum(len(f['members']) for f in review['families']), familyCount=len(review['families']))
    return review


if __name__ == '__main__':
    print(json.dumps(manifest(), separators=(',', ':')))
