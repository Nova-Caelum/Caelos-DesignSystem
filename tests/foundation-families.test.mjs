import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

function python(source) {
  const result = spawnSync('python3', ['-B', '-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('review manifest covers every foundation once, grouped by quantity without duplicate values', () => {
  python(`
import copy, json, runpy
from pathlib import Path
sheet = runpy.run_path('scripts/foundation-sheet.py')
manifest = sheet['manifest']()
base = dict(sheet['leaves'](json.loads(Path('token_catalog/00-foundations.tokens.json').read_text())))
items = [item for category in manifest for row in category['rows'] for item in row['items']]
assert len(items) == len(base)
assert {item['path'] for item in items} == set(base)
assert len({c['key'] for c in manifest}) == len(manifest)
for category in manifest:
    assert category['maxPerLine'] == 5
    for row in category['rows']:
        def unique(values):
            keys = [json.dumps([v['type'],v['value']],sort_keys=True) for v in values]
            return len(keys) == len(set(keys))
        assert unique(row['items']), row['name']
        assert not unique(row['items'] + [copy.deepcopy(row['items'][0])])
        for item in row['items']:
            assert item['value'] == base[item['path']]['$value']
            assert item['name'] and item['evidence'] and item['status']
            assert item['path'].split('.')[1] == category['key']
`);
});

test('migration metadata is excluded from live comparison without hiding alias drift', () => {
  python(`
import copy, runpy
compare = runpy.run_path('scripts/figma-catalog.py')['compare']
plan = [{'name':'Base','modes':['Base'],'variables':[
    {'name':'_compat/old','type':'FLOAT','values':{'Base':{'alias':'Base/space/px-8'}},'hidden':True,'migrateFrom':['old']},
    {'name':'space/px-8','type':'FLOAT','values':{'Base':8},'migrateFrom':['padding']}
]}]
live = copy.deepcopy(plan)
for v in live[0]['variables']:
    v.pop('hidden',None)
    v.pop('migrateFrom',None)
assert compare(plan,live)
live[0]['variables'][0]['values']['Base']['alias'] = 'Base/space/px-12'
assert not compare(plan,live)
`);
});

test('Figma migration preserves bound IDs, hides duplicate aliases and resolves cross-collection targets', async () => {
  const collections = [{id:'base',name:'00 Base',defaultModeId:'m',modes:[{modeId:'m',name:'Base'}]},
    {id:'controls',name:'Controls',defaultModeId:'c',modes:[{modeId:'c',name:'Default'}]}];
  const variable = (id,name,collection,value,mode='m') => ({id,name,variableCollectionId:collection,resolvedType:'FLOAT',
    valuesByMode:{[mode]:value},setValueForMode(key,value){this.valuesByMode[key]=value;}});
  const variables = [variable('bound-padding','padding','base',8),variable('bound-gap','gap','base',8),
    variable('button','button/padding','controls',0,'c')];
  const context = vm.createContext({figma:{variables:{
    getLocalVariableCollectionsAsync:async()=>collections,
    getLocalVariablesAsync:async()=>variables,
    createVariable(){throw Error('Existing IDs must be retained');},
    createVariableAlias:v=>({type:'VARIABLE_ALIAS',id:v.id})
  }}});
  vm.runInContext(readFileSync('scripts/figma-variables.js','utf8'),context);
  const base = [{name:'00 Base',modes:['Base'],variables:[
    {name:'space/px-8',type:'FLOAT',values:{Base:8},migrateFrom:['padding']},
    {name:'_compat/gap',type:'FLOAT',values:{Base:{alias:'00 Base/space/px-8'}},migrateFrom:['gap'],hidden:true}
  ]}];
  await context.libraryVariables(base,true);
  assert.equal(variables[0].id,'bound-padding');
  assert.equal(variables[0].name,'space/px-8');
  assert.equal(variables[1].valuesByMode.m.id,'bound-padding');
  assert.equal(variables[1].hiddenFromPublishing,true);
  await context.libraryVariables([{name:'Controls',modes:['Default'],variables:[
    {name:'button/padding',type:'FLOAT',values:{Default:{alias:'00 Base/space/px-8'}}}
  ]}],true);
  assert.equal(variables[2].valuesByMode.c.id,'bound-padding');
  await context.libraryVariables(base,true);
  assert.equal(variables.length,3);
});
