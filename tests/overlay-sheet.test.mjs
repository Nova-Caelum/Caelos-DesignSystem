import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('overlay review preserves inventory coverage, behavior dimensions and lower-tier construction', () => {
  const result = spawnSync('python3', ['-c', `
import copy, json, runpy
from pathlib import Path
module = runpy.run_path('scripts/overlay-sheet.py')
catalog = json.loads(Path('token_catalog/03-overlays.tokens.json').read_text())
manifest = module['manifest'](catalog)
assert manifest['inventoryCount'] == 49
assert manifest['tokenCount'] == 21
assert len(manifest['categories']) == 7
assert manifest['familyCount'] == 12
families = {f['key']: f for f in manifest['families']}
assert set(['action-menu', 'context-menu', 'select-menu']) <= families.keys()
assert all(i['name'] and i['collection'] for f in families.values() for i in f['ingredients'])
assert next(i for i in families['tooltip']['ingredients'] if i['path'] == 'base.radius.px-11')['value'] == {'value':11,'unit':'px'}
assert next(i for i in families['popover']['ingredients'] if i['path'] == 'primitives.shared.glass.saturation')['value'] == 1.25
for mutation in ['duplicate', 'missing', 'unknown-family', 'missing-behavior', 'unknown-token']:
    planted = copy.deepcopy(catalog)
    review = planted['overlays']['$extensions']['app.caelos']['review']
    if mutation == 'duplicate': review['families'][1]['members'].append(review['families'][0]['members'][0])
    if mutation == 'missing': review['families'][0]['members'].pop()
    if mutation == 'unknown-family': review['categories'][0]['families'].append('unknown')
    if mutation == 'missing-behavior': del review['families'][0]['behavior']['focus']
    if mutation == 'unknown-token': review['families'][0]['construction'].append('base.unknown')
    try: module['manifest'](planted)
    except ValueError: pass
    else: raise AssertionError('Plant accepted: ' + mutation)
`], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
