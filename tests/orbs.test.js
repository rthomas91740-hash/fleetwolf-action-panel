const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

const action = (category, severity, type = category) => ({ category, severity, type });
const result = {
  fleet: { current: { idleCost: 142.4 } },
  actions: [action('safety', 'high'), action('cost', 'medium'), action('health', 'medium', 'offline'), action('health', 'high', 'camera'), action('health', 'low', 'camera'), action('faults', 'low')],
};
const ring = (orbs, key) => orbs.ring.find((o) => o.key === key);

test('orb tone follows the worst to-do it holds', () => {
  assert.equal(core.orbTone([]), 'clear');
  assert.equal(core.orbTone([action('a', 'low')]), 'low');
  assert.equal(core.orbTone([action('a', 'low'), action('a', 'medium')]), 'medium');
  assert.equal(core.orbTone([action('a', 'medium'), action('a', 'high')]), 'high');
});

test('orbs show real counts and each to-do lands in one category orb', () => {
  const orbs = core.buildOrbs({ result, myOpen: 2, teamOpen: 3 });
  assert.equal(orbs.center.value, 6);
  assert.equal(ring(orbs, 'safety').value, 1);
  assert.equal(ring(orbs, 'health').value, 1);
  assert.equal(ring(orbs, 'cameras').value, 2);
  assert.equal(ring(orbs, 'cameras').tone, 'high');
  assert.equal(ring(orbs, 'mine').value, 2);
  assert.equal(ring(orbs, 'team').value, 3);
  const categoryOrbs = ['safety', 'cost', 'usage', 'faults', 'health', 'cameras'];
  assert.equal(categoryOrbs.reduce((sum, key) => sum + ring(orbs, key).count, 0), result.actions.length);
});

test('the idle fuel orb shows dollars, but its moons count to-dos', () => {
  const cost = ring(core.buildOrbs({ result }), 'cost');
  assert.equal(cost.value, '$142');
  assert.equal(cost.count, 1);
});

test('before data loads the orbs show a dash, not a false zero', () => {
  const orbs = core.buildOrbs({ result: null });
  assert.equal(orbs.center.value, '–');
  assert.equal(ring(orbs, 'safety').value, '–');
  assert.equal(ring(orbs, 'cost').value, '–');
});

test('someone below the full-list level gets only their own tasks, with no fleet orbs', () => {
  const orbs = core.buildOrbs({ result: null, myOpen: 4, full: false });
  assert.equal(orbs.center.value, 4);
  assert.equal(orbs.center.view.tab, 'mine');
  assert.equal(orbs.ring.length, 0);
});
