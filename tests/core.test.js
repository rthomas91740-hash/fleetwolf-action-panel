const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

const TZ = 'America/Los_Angeles';
const NOW = Date.parse('2026-10-29T18:00:00Z'); // Thursday morning, Pacific.
const OPEN = { activeFrom: '2020-01-01T00:00:00Z', activeTo: '2050-01-01T00:00:00Z' };
const range = core.period(7, TZ, NOW);

const groups = [
  { id: 'GroupCompanyId', name: 'Company', children: [{ id: 'bA' }, { id: 'bB' }] },
  { id: 'bA', name: 'Crew A', children: [] },
  { id: 'bB', name: 'Crew B', children: [] },
];
const device = (id, group = 'bA', extra = {}) => ({ id, name: `Truck ${id}`, groups: [{ id: group }], ...OPEN, ...extra });
let tripId = 0;
const trip = (deviceId, date, km = 16.09344, idle = '00:00:00', extra = {}) => ({ id: `t${++tripId}`, device: { id: deviceId }, start: `${date}T18:00:00Z`, distance: km, idlingDuration: idle, ...extra });
const run = (input) => core.analyze({ groups, devices: [], trips: [], events: [], statuses: [], rules: [], drivers: [], range, tz: TZ, now: NOW, settings: core.mergeSettings(input.settingsPatch), ...input });

// Oct 22-28 2026 runs Thursday to Wednesday, so it holds five weekdays and one weekend.
const WEEKDAYS = ['2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28'];

test('period is complete days only and the prior block sits directly before it', () => {
  assert.equal(range.current.first, '2026-10-22');
  assert.equal(range.current.last, '2026-10-28');
  assert.equal(range.prior.first, '2026-10-15');
  assert.equal(range.prior.last, '2026-10-21');
  assert.equal(range.current.to, range.current.windows[6].to);
  assert.equal(range.prior.to, range.current.from);
});

test('midnight stays correct across daylight saving change', () => {
  assert.equal(new Date(core.midnight('2026-11-02', TZ)).toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(new Date(core.midnight('2026-10-31', TZ)).toISOString(), '2026-10-31T07:00:00.000Z');
});

test('a Monday to Friday truck used every work day scores 100% utilization, not 71%', () => {
  const result = run({ devices: [device('d1')], trips: WEEKDAYS.map((d) => trip('d1', d)) });
  assert.equal(result.fleet.current.utilization, 100);
  assert.equal(result.fleet.current.scheduledDays, 5);
});

test('a group schedule override counts Saturday as a work day for that group only', () => {
  const devices = [device('d1', 'bA'), device('d2', 'bB')];
  const trips = [trip('d1', '2026-10-24'), trip('d2', '2026-10-24')];
  const result = run({ devices, trips, settingsPatch: { groupSchedules: { bA: [1, 2, 3, 4, 5, 6] } } });
  const keys = result.actions.map((a) => a.key);
  assert.ok(!keys.includes('offschedule:d1'));
  assert.ok(keys.includes('offschedule:d2'));
});

test('one trip without idle data does not blank the group and is counted as missing', () => {
  const trips = [trip('d1', WEEKDAYS[0], 16, '02:00:00'), trip('d1', WEEKDAYS[1], 16, null)];
  const result = run({ devices: [device('d1')], trips });
  const row = result.rows.find((r) => r.id === 'bA');
  assert.equal(row.current.idleHours, 2);
  assert.equal(row.current.idleMissing, 1);
});

test('idle cost uses the configured fuel price and burn rate', () => {
  const trips = [trip('d1', WEEKDAYS[0], 16, '10:00:00')];
  const result = run({ devices: [device('d1')], trips, settingsPatch: { fuelPrice: 5, idleGallonsPerHour: 1 } });
  assert.equal(result.fleet.current.idleCost, 50);
});

test('a group whose idle time jumps gets a costed action naming its worst truck', () => {
  const devices = [device('d1'), device('d2')];
  const trips = [trip('d1', '2026-10-15', 16, '05:00:00'), trip('d1', WEEKDAYS[0], 16, '10:00:00'), trip('d2', WEEKDAYS[0], 16, '02:00:00')];
  const action = run({ devices, trips }).actions.find((a) => a.key === 'idle:bA');
  assert.match(action.title, /up 140%/);
  assert.equal(action.vehicles[0].id, 'd1');
  assert.equal(action.estimated, true);
});

test('low idle cost below the minimum raises nothing', () => {
  const trips = [trip('d1', '2026-10-15', 16, '00:10:00'), trip('d1', WEEKDAYS[0], 16, '01:00:00')];
  assert.equal(run({ devices: [device('d1')], trips }).actions.filter((a) => a.type === 'idle').length, 0);
});

test('overlapping groups do not double count the fleet idle total', () => {
  const overlapping = { ...device('d1'), groups: [{ id: 'bA' }, { id: 'bB' }] };
  const result = run({ devices: [overlapping], trips: [trip('d1', WEEKDAYS[0], 16, '10:00:00')] });
  assert.equal(result.fleet.current.idleHours, 10);
  assert.equal(result.overlapping, true);
});

test('safety counts every selected rule, names the driver and ignores invalid events', () => {
  const rules = [{ id: 'r1', name: 'Harsh Braking' }, { id: 'r2', name: 'Posted Speeding' }, { id: 'r3', name: 'Engine Fault' }];
  const event = (id, rule, extra = {}) => ({ id, rule: { id: rule }, device: { id: 'd1' }, driver: { id: 'u1' }, activeFrom: `${WEEKDAYS[0]}T18:00:00Z`, ...extra });
  const events = [event('e1', 'r1'), event('e2', 'r2'), event('e3', 'r2'), event('e4', 'r3'), event('e5', 'r2', { state: 'ExceptionEventStateInvalidId' })];
  const result = run({ devices: [device('d1')], trips: [trip('d1', WEEKDAYS[0], 80)], events, rules, drivers: [{ id: 'u1', firstName: 'Sam', lastName: 'Lee' }] });
  const action = result.actions.find((a) => a.type === 'safety');
  assert.match(action.title, /3 safety events/);
  assert.match(action.why, /Posted Speeding \(2\)/);
  assert.match(action.next, /Sam Lee/);
});

test('unknown drivers are not named as the person to coach', () => {
  const rules = [{ id: 'r1', name: 'Harsh Braking' }];
  const events = ['e1', 'e2', 'e3'].map((id) => ({ id, rule: { id: 'r1' }, device: { id: 'd1' }, driver: 'UnknownDriverId', activeFrom: `${WEEKDAYS[0]}T18:00:00Z` }));
  const action = run({ devices: [device('d1')], trips: [trip('d1', WEEKDAYS[0], 80)], events, rules }).actions.find((a) => a.type === 'safety');
  assert.match(action.next, /find out who was driving/);
});

test('when safety data failed, no safety actions are raised', () => {
  const rules = [{ id: 'r1', name: 'Harsh Braking' }];
  const events = ['e1', 'e2', 'e3'].map((id) => ({ id, rule: { id: 'r1' }, device: { id: 'd1' }, activeFrom: `${WEEKDAYS[0]}T18:00:00Z` }));
  const result = run({ devices: [device('d1')], trips: [trip('d1', WEEKDAYS[0], 80)], events, rules, safetyAvailable: false });
  assert.equal(result.actions.filter((a) => a.type === 'safety').length, 0);
});

test('a silent device becomes an offline action and is not also called unused', () => {
  const statuses = [{ device: { id: 'd1' }, dateTime: new Date(NOW - 9 * 86400000).toISOString() }];
  const actions = run({ devices: [device('d1')], trips: [trip('d1', '2026-10-15')], statuses }).actions;
  assert.deepEqual(actions.map((a) => a.type), ['offline']);
  assert.equal(actions[0].severity, 'high');
});

test('a parked truck that is still reporting is unused, with cost only when configured', () => {
  const statuses = [{ device: { id: 'd1' }, dateTime: new Date(NOW).toISOString() }];
  const plain = run({ devices: [device('d1')], statuses }).actions[0];
  assert.equal(plain.type, 'unused');
  assert.equal(plain.amount, null);
  const costed = run({ devices: [device('d1')], statuses, settingsPatch: { vehicleMonthlyCost: 300 } }).actions[0];
  assert.equal(costed.amount, 70);
});

test('handled actions stay hidden until the snooze ends, then return', () => {
  const input = { devices: [device('d1')], handled: { 'unused:d1': NOW + 1000 } };
  const hidden = run(input);
  assert.equal(hidden.actions.length, 0);
  assert.equal(hidden.handledCount, 1);
  assert.equal(run({ ...input, handled: { 'unused:d1': NOW - 1000 } }).actions.length, 1);
});

test('actions sort by severity, then by dollars', () => {
  const devices = [device('d1'), device('d2', 'bB'), device('d3', 'bB')];
  const statuses = [{ device: { id: 'd1' }, dateTime: new Date(NOW - 9 * 86400000).toISOString() }];
  const trips = [trip('d1', '2026-10-15'), trip('d2', WEEKDAYS[0], 16, '12:00:00')];
  const order = run({ devices, trips, statuses }).actions.map((a) => a.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)));
  assert.equal(order[0], 'high');
});

test('the organization filter limits vehicles to the selected group', () => {
  const result = run({ devices: [device('d1', 'bA'), device('d2', 'bB')], filter: ['bB'] });
  assert.equal(result.fleet.current.vehicles, 1);
  assert.deepEqual(result.rows.map((r) => r.id), ['bB']);
});

test('non-vehicle assets drop out only where the database uses the vehicle group', () => {
  const vehicle = { ...device('d1'), groups: [{ id: 'bA' }, { id: 'GroupVehicleId' }] };
  assert.equal(run({ devices: [vehicle, device('d2')] }).fleet.current.vehicles, 1);
  assert.equal(run({ devices: [device('d1'), device('d2')] }).fleet.current.vehicles, 2);
});

test('vehicles outside every reporting group still appear under Other vehicles', () => {
  const result = run({ devices: [device('d1', 'bA'), device('d2', 'bB')], settingsPatch: { reportGroupIds: ['bA'] } });
  assert.deepEqual(result.rows.map((r) => r.name).sort(), ['Crew A', 'Other vehicles']);
});

test('completeWindow splits a full result rather than returning a truncated one', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, at: i }));
  const get = async (type, search) => {
    const from = Date.parse(search.fromDate);
    const to = Date.parse(search.toDate);
    return rows.filter((r) => r.at * 3600000 >= from && r.at * 3600000 < to).slice(0, 3);
  };
  const result = await core.completeWindow(get, 'Trip', 0, 6 * 3600000, null, 3);
  assert.equal(result.length, 6);
});

test('completeWindow fails loudly at the split limit', async () => {
  const get = async () => [{ id: 'a' }, { id: 'b' }];
  await assert.rejects(core.completeWindow(get, 'Trip', 0, 30000, null, 2), /data limit/);
});

test('CSV escapes quotes and neutralizes spreadsheet formulas', () => {
  assert.equal(core.toCsv([['=SUM(A1)', 'say "hi"', 'a,b', null, 5]]), `'=SUM(A1),"say ""hi""","a,b",,5`);
});

test('bad stored settings fall back to defaults', () => {
  const settings = core.mergeSettings({ fuelPrice: -2, idleRisePct: 'x', offlineDays: 5 });
  assert.equal(settings.fuelPrice, core.DEFAULTS.fuelPrice);
  assert.equal(settings.idleRisePct, core.DEFAULTS.idleRisePct);
  assert.equal(settings.offlineDays, 5);
});
