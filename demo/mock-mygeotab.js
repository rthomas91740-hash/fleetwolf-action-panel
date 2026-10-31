(function () {
  'use strict';
  const DAY = 86400000;
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const OPEN = { activeFrom: '2020-01-01T00:00:00Z', activeTo: '2050-01-01T00:00:00Z' };

  const groups = [
    { id: 'GroupCompanyId', name: 'Company', children: [{ id: 'bNorth' }, { id: 'bSouth' }, { id: 'bService' }] },
    { id: 'bNorth', name: 'North Crew', children: [] },
    { id: 'bSouth', name: 'South Crew', children: [] },
    { id: 'bService', name: 'Service Vans', children: [] },
  ];
  const fleet = { bNorth: 8, bSouth: 8, bService: 6 };
  const devices = [];
  Object.entries(fleet).forEach(([group, count]) => {
    const prefix = group === 'bNorth' ? 'North' : group === 'bSouth' ? 'South' : 'Van';
    for (let i = 1; i <= count; i++) devices.push({ id: `${group}-${i}`, name: `${prefix} ${String(i).padStart(2, '0')}`, groups: [{ id: group }], ...OPEN });
  });
  const clearance = (id) => [{ id }];
  const person = (id, firstName, lastName, level, scope = ['GroupCompanyId']) => ({ id, name: `${id}@demo.invalid`, firstName, lastName, securityGroups: clearance(level), companyGroups: scope.map((g) => ({ id: g })), timeZoneId: 'America/Los_Angeles', ...OPEN });
  const users = [
    person('u-admin', 'Avery', 'Owner', 'GroupEverythingSecurityId'),
    person('u-sup', 'Morgan', 'Ops', 'GroupSupervisorSecurityId'),
    person('u-north', 'Casey', 'North', 'GroupUserSecurityId', ['bNorth']),
    person('u-south', 'Jordan', 'South', 'GroupUserSecurityId', ['bSouth']),
    person('u-view', 'Riley', 'Viewer', 'GroupViewOnlySecurityId'),
    person('u-drive', 'Sam', 'Driver', 'GroupDriveUserSecurityId', ['bSouth']),
  ];
  const rules = [
    { id: 'r-speed', name: 'Posted Speeding' }, { id: 'r-brake', name: 'Harsh Braking' }, { id: 'r-corner', name: 'Harsh Cornering' },
    { id: 'r-belt', name: 'Seat Belt' }, { id: 'r-zone', name: 'Zone Stops' },
  ];

  // Seeded so the demo fleet looks the same on every reload.
  let seed = 42;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const duration = (hours) => {
    const total = Math.round(hours * 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  };
  const trips = [], events = [];
  let nextId = 0;
  const noon = (back) => { const d = new Date(now - back * DAY); d.setHours(10, 0, 0, 0); return d.getTime(); };
  for (let back = 1; back <= 60; back++) {
    const at = noon(back);
    const weekday = new Date(at).getDay();
    const isWork = weekday >= 1 && weekday <= 5;
    for (const device of devices) {
      const group = device.groups[0].id;
      const recent = back <= 7;
      const parked = device.id === 'bService-4' && back <= 30;
      const silent = device.id === 'bNorth-3' && back <= 5;
      const weekendRunner = device.id === 'bSouth-6' && recent && !isWork;
      if (parked || silent || (!isWork && !weekendRunner) || (isWork && rand() < 0.08)) continue;
      let idle = 0.15 + rand() * 0.25;
      if (group === 'bSouth' && recent) idle *= 2.6;
      if (device.id === 'bSouth-2' && recent) idle *= 2.2;
      const km = 45 + rand() * 90;
      trips.push({ id: `t${++nextId}`, device: { id: device.id }, driver: { id: 'u-drive' }, start: iso(at), stop: iso(at + 2 * 3600000), distance: km, idlingDuration: nextId % 97 === 0 ? null : duration(idle) });
      const riskBoost = device.id === 'bNorth-5' && recent ? 0.9 : 0.03;
      if (rand() < riskBoost) {
        const rule = rand() < 0.65 ? 'r-speed' : 'r-brake';
        events.push({ id: `e${++nextId}`, device: { id: device.id }, driver: device.id === 'bNorth-5' ? { id: 'u-drive' } : 'UnknownDriverId', rule: { id: rule }, activeFrom: iso(at + 3600000), state: 'ExceptionEventStateValidId' });
        if (device.id === 'bNorth-5') events.push({ id: `e${++nextId}`, device: { id: device.id }, driver: { id: 'u-drive' }, rule: { id: 'r-speed' }, activeFrom: iso(at + 5400000), state: 'ExceptionEventStateValidId' });
      }
    }
  }
  const statuses = devices.map((d) => ({
    device: { id: d.id },
    dateTime: iso(d.id === 'bNorth-3' ? now - 5 * DAY : now - 600000),
    isDeviceCommunicating: d.id !== 'bNorth-3',
    latitude: d.id === 'bNorth-8' ? 0 : 34.05,
    longitude: d.id === 'bNorth-8' ? 0 : -118.25,
  }));
  const diagnostics = [
    { id: 'dMisfire', name: 'Engine misfire detected', code: 300, source: { id: 'SourceObdId', name: 'OBD' } },
    { id: 'dCoolant', name: 'Coolant temperature high', code: 217, source: { id: 'SourceObdId', name: 'OBD' } },
    { id: 'dO2', name: 'Oxygen sensor circuit slow', code: 133, source: { id: 'SourceObdId', name: 'OBD' } },
    { id: 'dDef', name: 'DEF level low', code: 203, source: { id: 'SourceJ1939Id', name: 'J1939' } },
    { id: 'dUnplug', name: 'Device has been unplugged', source: { id: 'SourceGeotabGoId', name: 'Geotab GO' } },
  ];
  const faultRecord = (device, diagnostic, back, extra = {}) => ({ id: `f${++nextId}`, device: { id: device }, diagnostic: { id: diagnostic }, dateTime: iso(noon(back)), faultState: 'Active', count: 1, ...extra });
  const faults = [
    faultRecord('bSouth-3', 'dCoolant', 1, { redStopLamp: true, severity: 'Critical' }),
    faultRecord('bSouth-3', 'dMisfire', 2, { malfunctionLamp: true }),
    faultRecord('bService-2', 'dDef', 3, { amberWarningLamp: true }),
    faultRecord('bService-2', 'dDef', 2, { amberWarningLamp: true }),
    faultRecord('bNorth-2', 'dO2', 4),
    faultRecord('bNorth-7', 'dMisfire', 5, { malfunctionLamp: true }),
    faultRecord('bNorth-7', 'dMisfire', 1, { faultState: 'Inactive' }),
    faultRecord('bSouth-7', 'dUnplug', 2),
  ];
  const cameraLevels = { 'bNorth-6': 3, 'bService-1': 1, 'bSouth-5': 2 };
  const cameraReadings = devices.map((d) => ({ id: `c-${d.id}`, device: { id: d.id }, dateTime: iso(noon(6)), data: cameraLevels[d.id] || 0 }));

  const storage = [];
  let currentUser = users[0];
  const inRange = (value, search) => {
    if (!search.fromDate) return true;
    const t = Date.parse(value);
    return t >= Date.parse(search.fromDate) && t < Date.parse(search.toDate);
  };
  const handlers = {
    Get({ typeName, search = {}, resultsLimit }) {
      if (typeName === 'Group' && search.id === 'GroupSecurityId') return [{ id: 'GroupSecurityId', name: 'Security', children: [] }];
      if (typeName === 'Diagnostic') return diagnostics.filter((d) => d.id === search.id);
      const table = {
        Group: groups, Device: devices, Rule: rules, DeviceStatusInfo: statuses, AddInData: storage,
        User: search.name ? users.filter((u) => u.name === search.name) : (currentUser.securityGroups[0].id === 'GroupViewOnlySecurityId' ? [currentUser] : users),
        Trip: trips.filter((t) => inRange(t.start, search)),
        ExceptionEvent: events.filter((e) => inRange(e.activeFrom, search)),
        FaultData: faults.filter((f) => inRange(f.dateTime, search)),
        StatusData: search.diagnosticSearch?.id === 'aOzdYMcJkw06ft9g4uXvpIA' ? cameraReadings.filter((r) => inRange(r.dateTime, search)) : [],
      }[typeName];
      if (!table) throw new Error(`Demo API does not serve ${typeName}`);
      return JSON.parse(JSON.stringify(table.slice(0, resultsLimit)));
    },
    Add({ typeName, entity }) {
      if (typeName === 'TextMessage') return `m${++nextId}`;
      if (currentUser.securityGroups[0].id === 'GroupViewOnlySecurityId') throw new Error('Incorrect login clearance');
      const id = `store-${++nextId}`;
      storage.push({ ...entity, id });
      return id;
    },
    Set({ entity }) {
      if (currentUser.securityGroups[0].id === 'GroupViewOnlySecurityId') throw new Error('Incorrect login clearance');
      Object.assign(storage.find((row) => row.id === entity.id), entity);
      return null;
    },
    Remove({ entity }) {
      storage.splice(storage.findIndex((row) => row.id === entity.id), 1);
      return null;
    },
  };
  const api = {
    getSession(callback) { callback({ userName: currentUser.name, database: 'demo' }); },
    call(method, params, success, failure) {
      setTimeout(() => {
        try { success(handlers[method](params)); } catch (error) { failure({ message: error.message }); }
      }, 5);
    },
  };
  const pages = [];
  const state = {
    getGroupFilter: () => [],
    hasAccessToPage: () => true,
    gotoPage: (page, args) => { pages.push({ page, args }); window.__fwLastPage = pages[pages.length - 1]; },
  };

  const banner = document.createElement('div');
  banner.id = 'fw-demo-banner';
  banner.style.cssText = 'font:13px system-ui,sans-serif;background:#16242f;color:#fff;padding:8px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center';
  banner.append('DEMO DATA, made-up fleet, not a live connection. View as:');
  const select = document.createElement('select');
  select.id = 'fw-demo-user';
  select.setAttribute('aria-label', 'Demo user');
  for (const user of users.filter((u) => u.id !== 'u-drive')) {
    const option = document.createElement('option');
    option.value = user.id;
    option.textContent = `${user.firstName} ${user.lastName}`;
    select.append(option);
  }
  banner.append(select);
  document.body.prepend(banner);

  const app = window.geotab.addin.fleetWolfActionPanel();
  app.initialize(api, state, () => {});
  app.focus(api, state);
  select.onchange = () => {
    currentUser = users.find((u) => u.id === select.value);
    app.blur();
    app.focus(api, state);
  };
})();
