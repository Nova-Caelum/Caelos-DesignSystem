import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../scripts/reconcile-control-bindings.js', import.meta.url), 'utf8');
function fixture({ oldValue = 16, targetValue = 15, expected = 16, mixed = false, scoped = false, targetType = 'FLOAT' } = {}) {
  const variable = (id, name, value, resolvedType = 'FLOAT') => ({ id, name, variableCollectionId:'c', resolvedType, resolveForConsumer:()=>({value}) });
  const old = variable('old','old',oldValue), target = variable('target','target',targetValue,targetType);
  const node = {id:'sample',type:scoped?'ELLIPSE':'TEXT',characters:'Example',boundVariables:scoped?{width:{id:'old'},height:{id:'old'}}:{fontSize:mixed?[{id:'old'},{id:'unknown'}]:[{id:'old'}]},findAll:()=>[],getStyledTextSegments:()=>[{fontName:{family:'Example',style:'Regular'}}],setBoundVariable(prop,v){this.boundVariables[prop]={id:v.id};},setRangeBoundVariable(){}};
  const study = {id:'study',type:'COMPONENT',findAll:fn=>[node].filter(fn)};
  const root = {name:'Category / Avatars',findAll:fn=>[node].filter(fn)};
  const page = {id:'page',children:[root]};
  const figma = {currentPage:page,getNodeByIdAsync:async id=>({page,study}[id]),variables:{getLocalVariableCollectionsAsync:async()=>[{id:'c',name:'Collection'}],getLocalVariablesAsync:async()=>[old,target]},loadFontAsync:async()=>{}};
  const manifest = {pageId:'page',categories:[{key:'avatars',title:'Avatars',studies:[{id:'study'}]}],constructionTokens:{target:{path:'base.target',collection:'Collection',name:'target'}}};
  const row={collection:'Collection',name:'old',target:'base.target',expected};
  const plan=scoped?{mappings:[],scopedMappings:[{...row,category:'avatars',nodeType:'ELLIPSE',properties:['width','height']}]}:{mappings:[row]};
  const run=vm.runInNewContext(source+';reconcileControlBindings', {figma});
  return {node,run:apply=>run(manifest,plan,apply)};
}
test('approved approximation applies once, with a mutation-free preview and repeat',async()=>{
  const f=fixture();
  assert.equal((await f.run(false)).plannedEdits,1);
  assert.equal(f.node.boundVariables.fontSize[0].id,'old');
  assert.equal((await f.run(true)).bindingsChanged,1);
  assert.equal(f.node.boundVariables.fontSize.id,'target');
  assert.equal((await f.run(false)).plannedEdits,0);
});
test('unexpected source value fails before mutation',async()=>{
  const f=fixture({oldValue:17});
  await assert.rejects(f.run(true),/Unaudited source value/);
  assert.equal(f.node.boundVariables.fontSize[0].id,'old');
});
test('exact matches require no approximation and incompatible types fail',async()=>{
  const exact=fixture({oldValue:14,targetValue:14,expected:null});
  assert.equal((await exact.run(true)).bindingsChanged,1);
  const bad=fixture({targetType:'STRING'});
  await assert.rejects(bad.run(true),/Type mismatch/);
  assert.equal(bad.node.boundVariables.fontSize[0].id,'old');
});
test('ambiguous mixed text fails before mutation',async()=>{
  const f=fixture({mixed:true});
  await assert.rejects(f.run(true),/Mixed binding needs manual review/);
  assert.equal(f.node.boundVariables.fontSize[0].id,'old');
});
test('scoped badge mapping preserves value and only changes dimensions',async()=>{
  const f=fixture({oldValue:14,targetValue:14,scoped:true});
  assert.equal((await f.run(true)).bindingsChanged,2);
  assert.equal(f.node.boundVariables.width.id,'target');
  assert.equal(f.node.boundVariables.height.id,'target');
  assert.equal((await f.run(false)).plannedEdits,0);
  const bad=fixture({oldValue:14,targetValue:15,scoped:true});
  await assert.rejects(bad.run(true),/Invalid scoped mapping/);
  assert.equal(bad.node.boundVariables.width.id,'old');
});
