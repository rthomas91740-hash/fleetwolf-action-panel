const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

const settings = core.mergeSettings();
const user = (id, clearance, scope = ['GroupCompanyId'], extra = {}) => ({ id, name: `${id}@example.com`, securityGroups: [{ id: clearance }], companyGroups: scope.map((g) => ({ id: g })), ...extra });
const admin = user('admin', 'GroupEverythingSecurityId');
const boss = user('boss', 'GroupSupervisorSecurityId');
const peer = user('peer', 'GroupSupervisorSecurityId');
const staff = user('staff', 'GroupUserSecurityId');
const viewer = user('viewer', 'GroupViewOnlySecurityId');
const driver = user('driver', 'GroupDriveUserSecurityId');
const everyone = [admin, boss, peer, staff, viewer, driver];
const ids = (list) => list.map((u) => u.id);

test('system clearances map to levels, and no clearance means no access', () => {
  assert.deepEqual(everyone.map((u) => core.userLevel(u, settings)), [4, 3, 3, 2, 1, 0]);
  assert.equal(core.userLevel({ securityGroups: [] }, settings), 0);
});

test('custom clearances default to Standard and can be raised in settings', () => {
  const custom = user('custom', 'bCustom');
  assert.equal(core.userLevel(custom, settings), 2);
  assert.equal(core.userLevel(custom, core.mergeSettings({ clearanceLevels: { bCustom: 3 } })), 3);
});

test('full list is for supervisors and above by default, and the bar can move', () => {
  assert.equal(core.seesFullList(boss, settings), true);
  assert.equal(core.seesFullList(staff, settings), false);
  assert.equal(core.seesFullList(staff, core.mergeSettings({ fullListMinLevel: 2 })), true);
});

test('delegation only goes to strictly lower levels, highest first', () => {
  assert.deepEqual(ids(core.delegates({ me: boss, users: everyone, settings })), ['staff']);
  assert.deepEqual(ids(core.delegates({ me: admin, users: everyone, settings })), ['boss', 'peer', 'staff']);
  assert.deepEqual(ids(core.delegates({ me: staff, users: everyone, settings })), []);
});

test('View Only users are not offered because they could never mark a task done', () => {
  assert.ok(!ids(core.delegates({ me: admin, users: everyone, settings })).includes('viewer'));
});

test('people who cannot see the vehicle are not offered as delegates', () => {
  const groupMap = new Map([['bNorth', { id: 'bNorth', children: [{ id: 'bCrew' }] }], ['bCrew', { id: 'bCrew', children: [] }], ['bSouth', { id: 'bSouth', children: [] }]]);
  const north = user('north', 'GroupUserSecurityId', ['bNorth']);
  const south = user('south', 'GroupUserSecurityId', ['bSouth']);
  const devices = [{ id: 'd1', groups: [{ id: 'bCrew' }] }];
  assert.deepEqual(ids(core.delegates({ me: admin, users: [north, south], settings, devices, groupMap })), ['north']);
});

test('expired users are not offered as delegates', () => {
  const gone = user('gone', 'GroupUserSecurityId', ['GroupCompanyId'], { activeTo: '2020-01-01T00:00:00Z' });
  assert.deepEqual(ids(core.delegates({ me: admin, users: [gone], settings })), []);
});

test('finished tasks snooze the matching to-do for seven days, open tasks do not', () => {
  const merged = core.handledFromTasks([
    { actionKey: 'a', status: 'done', completedAt: '2026-10-20T00:00:00Z' },
    { actionKey: 'b', status: 'open' },
  ]);
  assert.equal(merged.a, Date.parse('2026-10-27T00:00:00Z'));
  assert.equal(merged.b, undefined);
});
