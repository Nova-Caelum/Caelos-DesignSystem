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
