import test from 'node:test';
import assert from 'node:assert/strict';
import {createActionFeedback} from '../src/tier-3/action-feedback.mjs';
test('success needs a real result and resets on the next edit, without a timer', () => {
  const seen=[], feedback=createActionFeedback({onChange:s=>seen.push(s)});
  const request=feedback.begin();
  assert.equal(feedback.state,'pending');
  assert.equal(feedback.begin(),undefined);
  assert.equal(feedback.complete({}),false);
  assert.equal(feedback.complete(request),true);
  assert.equal(feedback.state,'success');
  assert.equal(feedback.begin(),undefined);
  feedback.edited();
  assert.equal(feedback.state,'default');
  assert.deepEqual(seen,['pending','success','default']);
  assert.ok(feedback.begin());
});
test('saving an old revision cannot mark new edits as saved', () => {
  const feedback=createActionFeedback(), request=feedback.begin();
  feedback.edited();
  assert.equal(feedback.state,'pending');
  feedback.complete(request);
  assert.equal(feedback.state,'default');
});
test('failure allows retry; late results cannot override a new request', () => {
  const feedback=createActionFeedback(), old=feedback.begin();
  feedback.fail(old);
  assert.equal(feedback.state,'error');
  const retry=feedback.begin();
  assert.equal(feedback.complete(old),false);
  assert.equal(feedback.state,'pending');
  feedback.complete(retry);
  assert.equal(feedback.state,'success');
  feedback.eligible();
  assert.equal(feedback.state,'default');
});
test('actions with their own visible outcome need no success latch', () => {
  const feedback=createActionFeedback({showSuccess:false});
  feedback.complete(feedback.begin());
  assert.equal(feedback.state,'default');
});
