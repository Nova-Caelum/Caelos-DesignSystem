import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('live comparisons detect mode, type, value, legacy variable and alias-target drift', () => {
  const result = spawnSync('python3', ['-c', `
import copy, runpy
compare = runpy.run_path('scripts/figma-catalog.py')['compare']
row = {'name':'chip/pad','type':'FLOAT','values':{'Default':{'alias':'00 Base/padding'}}}
plan = [{'name':'Controls','modes':['Default'],'variables':[row]}]
assert compare(plan, copy.deepcopy(plan))
for field, value in [('name','chip/old'), ('type','STRING'), ('values',{'Default':2}),
                     ('values',{'Default':{'alias':'Semantic/padding'}})]:
    live = copy.deepcopy(plan)
    live[0]['variables'][0][field] = value
    assert not compare(plan, live)
for key, extra in [('modes','Other'), ('variables',dict(row,name='legacy'))]:
    live = copy.deepcopy(plan)
    live[0][key].append(extra)
    assert not compare(plan, live)
assert not compare(plan, [])
`], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('each visible palette caption follows the colour or usage that owns it', () => {
  const result = spawnSync('python3', ['-c', `
import json, runpy
from pathlib import Path
caption = runpy.run_path('scripts/figma-catalog.py')['palette_caption']
root = Path('token_catalog')
base = json.loads((root / '00-foundations.tokens.json').read_text())['base']['color']
for role, token in base.items():
    def display():
        return caption('base.color.' + role, token, 'Base')
    assert display() == ('hex/' + role, 'Approved palette — ' + token['$value']['hex'].upper())
    token['$value']['hex'] = '#' + format(int(token['$value']['hex'][1:], 16) ^ 1, '06x')
    assert display()[1].endswith(token['$value']['hex'].upper())
for mode in ['Dark', 'Light']:
    colors = json.loads((root / ('00-semantic.' + mode.lower() + '.tokens.json')).read_text())['sys']['color']
    for role, token in colors.items():
        name, text = caption('sys.color.' + role, token, mode)
        assert name == 'use/' + mode.lower() + '/' + role
        assert text == 'Use · ' + token['$description']
`], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('node opacity bindings use percentages and other numeric variables retain their units', () => {
  const result = spawnSync('python3', ['-c', `
import runpy
number = runpy.run_path('scripts/figma-catalog.py')['figma_number']
for fraction, percent in [(0, 0), (0.15, 15), (0.24, 24), (1, 100)]:
    assert number('base.opacity.fraction-0-15', fraction) == percent
assert number('base.size.px-6', {'value': 6, 'unit': 'px'}) == 6
for mode in ['light', 'dark']:
    for field in ['base-alpha','tint']:
        assert number('base.material.' + mode + '.' + field, 0.5) == 50
assert number('base.saturation.factor-1-25', 1.25) == number('unscaled', 1.25)
assert number('base.position.fraction-0-72', 0.72) == number('unscaled', 0.72)
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test('catalog compilation preserves shared compatibility aliases across theme modes', () => {
  const result = spawnSync('python3', ['-c', `
import json, runpy
from pathlib import Path
compile_catalog = runpy.run_path('scripts/figma-catalog.py')['compile_catalog']
root = Path('token_catalog')
def read_snapshot(*args):
    if args[0] == 'ls-tree':
        return '\\n'.join(sorted(p.name for p in root.glob('*.tokens.json')))
    return (root / args[-1].split('/')[-1]).read_text()
compile_catalog.__globals__['git'] = read_snapshot
plan = compile_catalog('working')
semantic = next(c for c in plan if c['name'] == '01 Semantic')
for role in ['base-alpha', 'blur', 'saturation', 'tint']:
    row = next(v for v in semantic['variables'] if v['name'] == '_compat/sys/material/menu/' + role)
    assert row['hidden']
    assert row['values'] == {mode: {'alias': '01 Semantic/sys/material/glass/' + role} for mode in ['Dark', 'Light']}
`], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
