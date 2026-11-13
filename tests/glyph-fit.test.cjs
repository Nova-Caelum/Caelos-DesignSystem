const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { unionPaintBounds, glyphFitPlan, glyphFitViolations, paintedGlyphNodes } = require('../scripts/glyph-fit.js');
const rect = (x, y, width, height) => ({x, y, width, height});
const paint = opacity => ({visible:true,opacity});
const plan = JSON.parse(execFileSync('python3', ['-B', 'scripts/glyph-fit-plan.py'], { encoding: 'utf8' }));
test('glyph policy resolves the foundation and records intrinsic Dot explicitly', () => {
  assert.equal(plan.coverage, 0.95);
  assert.deepEqual(plan.intrinsicGlyphs, ['Dot']);
});
test('paint union includes separated strokes rather than the imported frame', () => {
  assert.deepEqual(unionPaintBounds([rect(4,9,12,2),rect(9,4,2,12)]), rect(4,4,12,12));
});
test('uniform fit preserves non-square geometry and fits the limiting dimension', () => {
  const fit = glyphFitPlan(rect(5,7.5,10,5), rect(0,0,20,20), plan.coverage);
  assert.equal(fit.scale, 1.9);
  assert.equal(fit.width, 20);
  assert.equal(fit.height, 20);
});
test('intrinsic Dot tightens the frame without enlarging artwork', () => {
  const fit = glyphFitPlan(rect(8,8,3,3), rect(0,0,20,20), plan.coverage, true);
  assert.equal(fit.scale, 1);
  assert.equal(fit.width, 3 / plan.coverage);
});
test('validator accepts a centered fit and rejects planted undersizing and offset', () => {
  const frame = rect(0,0,20,20);
  assert.deepEqual(glyphFitViolations(rect(0.5,0.5,19,19),frame,plan.coverage), []);
  assert.deepEqual(glyphFitViolations(rect(2,2,16,16),frame,plan.coverage), ['coverage']);
  assert.deepEqual(glyphFitViolations(rect(1.5,0.5,19,19),frame,plan.coverage), ['centering']);
});
test('invalid and absent artwork fail closed', () => {
  assert.throws(() => unionPaintBounds([]));
  assert.throws(() => unionPaintBounds([null]));
  assert.throws(() => unionPaintBounds([rect(0,0,NaN,2)]));
  assert.throws(() => glyphFitPlan(rect(0,0,1,1),rect(0,0,20,20),0));
});
test('invisible paint and hidden descendants do not count as glyph artwork', () => {
  const root = {findAll: () => nodes};
  const base = {type:'VECTOR',...paint(1),parent:root,fills:[],strokes:[paint(1)]};
  const nodes = [base,{...base,visible:false},{...base,strokes:[]},{...base,parent:{visible:false,parent:root}}];
  assert.deepEqual(paintedGlyphNodes(root), [base]);
});
