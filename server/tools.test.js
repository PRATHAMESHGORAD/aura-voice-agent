import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrderDetails, checkReturnEligibility, cancelOrder, normalizeId } from './tools.js';

test('normalizes spoken/typed ids', () => {
  assert.equal(normalizeId('ord 101'), 'ORD-101');
  assert.equal(normalizeId('101'), 'ORD-101');
  assert.equal(normalizeId('hello'), null);
});
test('unknown and missing ids', () => {
  assert.equal(getOrderDetails({ order_id: 'ORD-999' }, 's').found, false);
  assert.equal(getOrderDetails({}, 's').found, false);
});
test('ORD-102 delivered 14 days ago is outside return window', () => {
  const r = checkReturnEligibility({ order_id: 'ORD-102', opened: false }, 's');
  assert.equal(r.eligible, false);
});
test('damaged item after 48h is not eligible', () => {
  assert.equal(checkReturnEligibility({ order_id: 'ORD-102', reason: 'damaged_or_defective' }, 's').eligible, false);
});
test('only Processing orders can be cancelled, per session', () => {
  assert.equal(cancelOrder({ order_id: 'ORD-101' }, 's').success, false);
  assert.equal(cancelOrder({ order_id: 'ORD-103' }, 'a').success, true);
  assert.equal(getOrderDetails({ order_id: 'ORD-103' }, 'a').status, 'Cancelled');
  assert.equal(getOrderDetails({ order_id: 'ORD-103' }, 'b').status, 'Processing');
});
