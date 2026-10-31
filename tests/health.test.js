const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

const TZ = 'America/Los_Angeles';
const NOW = Date.parse('2026-10-29T18:00:00Z');
const range = core.period(7, TZ, NOW);
const OPEN = { activeFrom: '2020-01-01T00:00:00Z', activeTo: '2050-01-01T00:00:00Z' };
const groups = [{ id: 'GroupCompanyId', name: 'Company', children: [{ id: 'bA' }] }, { id: 'bA', name: 'Crew A', children: [] }];
const device = (id) => ({ id, name: `Truck ${id}`, groups: [{ id: 'bA' }], ...OPEN });
const fresh = (id, extra = {}) => ({ device: { id }, dateTime: new Date(NOW - 60000).toISOString(), latitude: 34, longitude: -118, ...extra });
const run = (input) => core.analyze({ groups, devices: [device('d1')], trips: [], events: [], statuses: [fresh('d1')], rules: [], drivers: [], range, tz: TZ, now: NOW, settings: core.mergeSettings(input.settingsPatch), ...input });
const diagnostics = [
  { id: 'dEngine', name: 'Engine misfire', code: 300, source: { id: 'SourceObdId' } },
  { id: 'dLow', name: 'Tire sensor', source: { id: 'SourceObdId' } },
  { id: 'dPlug', name: 'Device has been unplugged', source: { id: 'SourceGeotabGoId' } },
  { id: 'dCam', name: 'Camera SD card error', source: { id: 'SourceProprietaryId' } },
];
const fault = (id, diagnostic, extra = {}) => ({ id, device: { id: 'd1' }, diagnostic: { id: diagnostic }, dateTime: '2026-10-28T18:00:00Z', faultState: 'Active', ...extra });
const types = (result) => result.actions.map((a) => a.type);

test('a device reporting without a GPS position is flagged as not locating', () => {
  assert.deepEqual(types(run({ statuses: [fresh('d1', { latitude: 0, longitude: 0 })] })).filter((t) => t === 'notlocating'), ['notlocating']);
  assert.ok(!types(run({})).includes('notlocating'));
});

test('not locating and offline are in Health, and counted in the summary', () => {
  const result = run({ statuses: [fresh('d1', { latitude: null, longitude: null })] });
  const action = result.actions.find((a) => a.type === 'notlocating');
  assert.equal(action.category, 'health');
  assert.equal(result.health.devices.notLocating, 1);
});

test('the latest camera reading wins, and severity follows the Geotab level', () => {
  const readings = [
    { device: { id: 'd1' }, dateTime: '2026-10-20T00:00:00Z', data: 0 },
    { device: { id: 'd1' }, dateTime: '2026-10-25T00:00:00Z', data: 3 },
  ];
  const result = run({ cameraReadings: readings });
  const action = result.actions.find((a) => a.type === 'camera');
  assert.equal(action.severity, 'high');
  assert.match(action.title, /camera not working/);
  assert.deepEqual(result.health.cameras.levels, [0, 0, 0, 1]);
});

test('a camera that recovered raises nothing', () => {
  const readings = [
    { device: { id: 'd1' }, dateTime: '2026-10-20T00:00:00Z', data: 3 },
    { device: { id: 'd1' }, dateTime: '2026-10-25T00:00:00Z', data: 0 },
  ];
  assert.ok(!types(run({ cameraReadings: readings })).includes('camera'));
});

test('the camera level setting hides lesser problems, and bad readings are ignored', () => {
  const readings = [{ device: { id: 'd1' }, dateTime: '2026-10-25T00:00:00Z', data: 1 }];
  assert.ok(types(run({ cameraReadings: readings })).includes('camera'));
  assert.ok(!types(run({ cameraReadings: readings, settingsPatch: { cameraMinLevel: 2 } })).includes('camera'));
  assert.equal(run({ cameraReadings: [{ device: { id: 'd1' }, dateTime: '2026-10-25T00:00:00Z', data: 9 }] }).health.cameras.total, 0);
});

test('a vehicle with no camera reading is not reported as a camera problem', () => {
  const result = run({});
  assert.equal(result.health.cameras.total, 0);
  assert.ok(!types(result).includes('camera'));
});

test('faults split between Vehicle Faults and Health by where they come from', () => {
  const result = run({ diagnostics, faults: [fault('f1', 'dEngine', { redStopLamp: true }), fault('f2', 'dPlug'), fault('f3', 'dCam')] });
  const vehicle = result.actions.find((a) => a.type === 'fault');
  const hardware = result.actions.find((a) => a.type === 'devicefault');
  assert.equal(vehicle.category, 'faults');
  assert.equal(vehicle.severity, 'high');
  assert.match(vehicle.why, /Engine misfire/);
  assert.equal(hardware.category, 'health');
  assert.match(hardware.title, /2 device faults/);
  assert.equal(result.faults.rows.length, 1);
});

test('a code that later went inactive or was dismissed is not active', () => {
  const later = fault('f2', 'dEngine', { dateTime: '2026-10-28T20:00:00Z', faultState: 'Inactive' });
  assert.equal(run({ diagnostics, faults: [fault('f1', 'dEngine', { amberWarningLamp: true }), later] }).faults.rows.length, 0);
  const dismissed = fault('f3', 'dEngine', { amberWarningLamp: true, dismissDateTime: '2026-10-29T00:00:00Z' });
  assert.equal(run({ diagnostics, faults: [dismissed] }).faults.rows.length, 0);
});

test('repeated records of one code are one fault with a count', () => {
  const result = run({ diagnostics, faults: [fault('f1', 'dEngine', { amberWarningLamp: true }), fault('f2', 'dEngine', { amberWarningLamp: true, dateTime: '2026-10-28T19:00:00Z' })] });
  assert.equal(result.faults.rows.length, 1);
  assert.equal(result.faults.rows[0].occurrences, 2);
});

test('low severity codes stay on the faults list without raising a to-do unless asked', () => {
  const faults = [fault('f1', 'dLow')];
  const quiet = run({ diagnostics, faults });
  assert.equal(quiet.faults.low, 1);
  assert.ok(!types(quiet).includes('fault'));
  assert.ok(types(run({ diagnostics, faults, settingsPatch: { faultIncludeLow: true } })).includes('fault'));
});

test('failed fault or camera data raises nothing rather than a false all clear', () => {
  const result = run({ diagnostics, faults: [fault('f1', 'dEngine', { redStopLamp: true })], cameraReadings: [{ device: { id: 'd1' }, dateTime: '2026-10-25T00:00:00Z', data: 3 }], faultsAvailable: false, camerasAvailable: false });
  assert.equal(result.faults.available, false);
  assert.equal(result.health.camerasAvailable, false);
  assert.equal(result.actions.filter((a) => ['fault', 'camera'].includes(a.type)).length, 0);
});
