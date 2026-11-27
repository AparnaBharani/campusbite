import test from 'node:test';
import assert from 'node:assert/strict';
import { predictDemand } from './recommendations.js';

test('recommendations favor demand at the matching Amrita weekday and hour', () => {
  const target = new Date('2026-01-19T13:30:00.000Z'); // Monday, 7:00 PM in India.
  const history = [
    { menu_item_id: 1, occurred_at: '2026-01-12T13:30:00.000Z', quantity: 5 },
    { menu_item_id: 1, occurred_at: '2026-01-05T13:30:00.000Z', quantity: 5 },
    { menu_item_id: 2, occurred_at: '2026-01-12T08:30:00.000Z', quantity: 8 },
    { menu_item_id: 2, occurred_at: '2026-01-05T08:30:00.000Z', quantity: 8 },
  ];
  const predictions = predictDemand(history, target);
  assert.equal(predictions[0].menu_item_id, 1);
  assert.equal(predictions[0].confidence, 'early');
  assert.ok(predictions[0].predicted_demand > predictions[1].predicted_demand);
});

test('recommendation forecast ignores future and stale observations', () => {
  const target = new Date('2026-01-19T13:30:00.000Z');
  assert.deepEqual(predictDemand([
    { menu_item_id: 1, occurred_at: '2026-01-20T13:30:00.000Z', quantity: 100 },
    { menu_item_id: 2, occurred_at: '2025-12-01T13:30:00.000Z', quantity: 100 },
  ], target), []);
});
