(function () {
  'use strict';

  const C = window.FleetWolfActionCore;
  const ADD_IN_ID = 'aFw0lfAcT1oNpAnEl7mK3xQ';
  const TRIP_FIELDS = ['id', 'start', 'stop', 'device', 'driver', 'distance', 'idlingDuration'];
  const STORAGE_GROUPS = [{ id: 'GroupCompanyId' }];
  const MAX_DOC_CHARS = 10000;
  const HANDLED_DAYS = 7;
  const DONE_VISIBLE_DAYS = 30;
  const DAY = 86400000;
  const LIST_PAGE = 8;
  const CATEGORIES = { all: 'All', safety: 'Safety', cost: 'Cost', usage: 'Vehicle use', health: 'Health', faults: 'Vehicle faults' };
  const ORB_POSITIONS = [['50%', '13%', '0s'], ['76%', '22%', '.5s'], ['90%', '50%', '1s'], ['76%', '78%', '1.5s'], ['50%', '87%', '2s'], ['24%', '78%', '2.5s'], ['10%', '50%', '3s'], ['24%', '22%', '3.5s']];
  const TONE_WORDS = { high: ', includes high severity', medium: ', includes medium severity', low: ', low severity only', clear: '' };
  const MAX_MOONS = 6;
  const MOTION_KEY = 'fleetWolfActionPanelMotion';
  const CAMERA_LOOKBACK_DAYS = 30;
  const MAX_DIAGNOSTIC_LOOKUPS = 300;
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  window.geotab = window.geotab || {};
  window.geotab.addin = window.geotab.addin || {};

  window.geotab.addin.fleetWolfActionPanel = function () {
    let api, pageState, root, timer;
    let active = false, generation = 0, busy = false;
    let days = 7, tab = 'todo', category = 'all', groupFilter = null, personFilter = null, showAll = false;
    let settings = C.mergeSettings(), settingsRowId = null, handled = {}, tasks = [];
    let me = null, users = [], clearanceNames = new Map(), tz = 'UTC';
    let inventory = null, result = null, range = null, updated = null, safetyAvailable = true, statusAvailable = true, faultsAvailable = true, camerasAvailable = true;
    const diagnosticCache = new Map();
    let healthOnly = null, motionOff = false, stageSignature = null;
    const stageNodes = new Map();
    let settingsOpen = false, dataInfoOpen = false, compose = null;
    const expanded = new Set();
    const dayCache = new Map();

    const $ = (selector) => root.querySelector(selector);
    function el(tag, className, text, attrs) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      for (const [key, value] of Object.entries(attrs || {})) {
        if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
      }
      return node;
    }
    function button(text, onClick, className, attrs) {
      const node = el('button', className, text, { type: 'button', ...attrs });
      node.onclick = onClick;
      return node;
    }
    function status(text, isError = false) {
      const node = $('#fw-status');
      node.textContent = text;
      node.classList.toggle('fw-error', isError);
      node.setAttribute('role', isError ? 'alert' : 'status');
    }

    function call(method, params) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${method} ${params.typeName} timed out.`)), 60000);
        api.call(method, params, (value) => { clearTimeout(timeout); resolve(value); }, (error) => { clearTimeout(timeout); reject(new Error(error?.message || String(error))); });
      });
    }
    function get(typeName, search, fields, limit = 5000) {
      return call('Get', { typeName, search, resultsLimit: limit, ...(fields ? { propertySelector: { fields } } : {}) });
    }
    function sessionUserName() {
      return new Promise((resolve) => {
        if (typeof api.getSession !== 'function') { resolve(null); return; }
        api.getSession((session) => resolve(session?.userName || null));
      });
    }

    // Each record keeps its JSON in one string because AddInData Set merges objects and cannot delete keys.
    function readDetails(row) {
      let details = row.details;
      if (details == null && typeof row.data === 'string') {
        try { details = JSON.parse(row.data); } catch { details = null; }
      }
      if (!details || typeof details.doc !== 'string') return null;
      try { return { id: row.id, kind: details.kind, doc: JSON.parse(details.doc) }; } catch { return null; }
    }
    function entity(kind, doc, id) {
      const text = JSON.stringify(doc);
      if (text.length > MAX_DOC_CHARS - 100) throw new Error('This record is too large to save. Clear some handled items and try again.');
      return { ...(id ? { id } : {}), addInId: ADD_IN_ID, groups: STORAGE_GROUPS, details: { kind, doc: text } };
    }
    async function loadStorage() {
      const rows = (await get('AddInData', { addInId: ADD_IN_ID })).map(readDetails).filter(Boolean);
      const stored = rows.find((row) => row.kind === 'settings');
      settingsRowId = stored?.id || null;
      const { handled: storedHandled, ...storedSettings } = stored?.doc || {};
      settings = C.mergeSettings(storedSettings);
      handled = storedHandled || {};
      tasks = rows.filter((row) => row.kind === 'task').map((row) => ({ ...row.doc, id: row.id }));
    }
    async function saveSettingsDoc() {
      const live = Date.now();
      const keptHandled = Object.fromEntries(Object.entries(handled).filter(([, until]) => until > live));
      const payload = entity('settings', { ...settings, handled: keptHandled }, settingsRowId);
      if (settingsRowId) await call('Set', { typeName: 'AddInData', entity: payload });
      else settingsRowId = await call('Add', { typeName: 'AddInData', entity: payload });
      handled = keptHandled;
    }

    async function loadIdentity() {
      const name = await sessionUserName();
      try {
        users = await get('User', {}, ['id', 'name', 'firstName', 'lastName', 'securityGroups', 'companyGroups', 'activeTo', 'timeZoneId']);
      } catch {
        users = [];
      }
      me = users.find((user) => user.name === name) || null;
      if (!me && name) {
        const own = await get('User', { name }, ['id', 'name', 'firstName', 'lastName', 'securityGroups', 'companyGroups', 'timeZoneId'], 1).catch(() => []);
        me = own[0] || null;
      }
      try {
        const [securityRoot] = await get('Group', { id: 'GroupSecurityId' }, null, 1);
        const names = new Map();
        const walk = (node) => { if (node?.name) names.set(node.id, node.name); (node?.children || []).forEach(walk); };
        walk(securityRoot);
        clearanceNames = names;
      } catch {
        clearanceNames = new Map();
      }
    }
    function resolveTimeZone() {
      const candidates = [settings.timeZone, me?.timeZoneId, Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC'];
      for (const candidate of candidates) {
        if (!candidate) continue;
        try { new Intl.DateTimeFormat('en-CA', { timeZone: candidate }); return candidate; } catch { /* try the next one */ }
      }
      return 'UTC';
    }
    function fullList() {
      return Boolean(me) && C.seesFullList(me, settings);
    }

    async function loadDay(type, window_, fields, today, run) {
      const key = `${type}|${tz}|${window_.date}`;
      const cached = dayCache.get(key);
      // Recent days can still be uploading, so only days older than two days are treated as final.
      if (cached && window_.date < C.shiftDate(today, -2)) return cached;
      if (run !== generation || !active) throw new Error('Page selection changed.');
      const rows = await C.completeWindow((t, search, f, limit) => get(t, search, f, limit), type, window_.from, window_.to, fields);
      let slim = rows;
      if (type === 'ExceptionEvent') slim = rows.map(({ id, device, driver, rule, activeFrom, state }) => ({ id, device, driver, rule, activeFrom, state }));
      if (type === 'FaultData') slim = rows.map(({ id, device, diagnostic, failureMode, faultState, dateTime, dismissDateTime, redStopLamp, amberWarningLamp, malfunctionLamp, protectWarningLamp, severity, riskOfBreakdown, count, faultDescription, recommendation }) => ({ id, device, diagnostic, failureMode, faultState, dateTime, dismissDateTime, redStopLamp, amberWarningLamp, malfunctionLamp, protectWarningLamp, severity, riskOfBreakdown, count, faultDescription, recommendation }));
      dayCache.set(key, slim);
      return slim;
    }
    async function loadAnalysis(run) {
      range = C.period(days, tz);
      const [groups, devices, rules] = await Promise.all([get('Group', {}, ['id', 'name', 'children']), get('Device', {}, ['id', 'name', 'groups', 'activeFrom', 'activeTo']), get('Rule', {}, ['id', 'name'])]);
      for (const [name, rows] of [['Group', groups], ['Device', devices], ['Rule', rules]]) {
        if (!Array.isArray(rows) || rows.length >= 5000) throw new Error(`${name} list exceeded the safe limit.`);
      }
      const windows = [...range.prior.windows, ...range.current.windows];
      let done = 0;
      const trips = await C.mapBounded(windows, async (w) => {
        const rows = await loadDay('Trip', w, TRIP_FIELDS, range.today, run);
        done++;
        if (run === generation) status(`Loading trips: ${done} of ${windows.length} days`);
        return rows;
      });
      let events = [];
      safetyAvailable = true;
      try {
        done = 0;
        events = (await C.mapBounded(windows, async (w) => {
          const rows = await loadDay('ExceptionEvent', w, null, range.today, run);
          done++;
          if (run === generation) status(`Loading safety events: ${done} of ${windows.length} days`);
          return rows;
        })).flat();
      } catch (error) {
        if (run !== generation) throw error;
        safetyAvailable = false;
      }
      let statuses = [];
      statusAvailable = true;
      try { statuses = await get('DeviceStatusInfo', {}, ['device', 'dateTime', 'latitude', 'longitude']); } catch { statusAvailable = false; }
      const { faults, diagnostics } = await loadFaults(run);
      const cameraReadings = await loadCameraReadings();
      inventory = { groups, devices, rules, trips: trips.flat(), events, statuses, faults, diagnostics };
      inventory.cameraReadings = cameraReadings;
    }
    // Faults run through today, because a new engine fault should not wait for the day to finish.
    async function loadFaults(run) {
      faultsAvailable = true;
      try {
        const todayWindow = { date: range.today, from: C.midnight(range.today, tz), to: Date.now() };
        const windows = [...range.current.windows, todayWindow];
        const faults = (await C.mapBounded(windows, (w) => loadDay('FaultData', w, null, range.today, run))).flat();
        const unknown = [...new Set(faults.map((f) => (typeof f.diagnostic === 'string' ? f.diagnostic : f.diagnostic?.id)).filter(Boolean))].filter((id) => !diagnosticCache.has(id)).slice(0, MAX_DIAGNOSTIC_LOOKUPS);
        await C.mapBounded(unknown, async (id) => {
          try {
            const [diagnostic] = await get('Diagnostic', { id }, null, 1);
            if (diagnostic) diagnosticCache.set(id, diagnostic);
          } catch { /* the fault still shows, under its code */ }
        });
        return { faults, diagnostics: diagnosticCache };
      } catch (error) {
        if (run !== generation) throw error;
        faultsAvailable = false;
        return { faults: [], diagnostics: diagnosticCache };
      }
    }
    // Readings can be sent only when health changes, so look well back for each camera's latest one.
    async function loadCameraReadings() {
      camerasAvailable = true;
      try {
        const to = Date.now();
        const withDiagnostic = (type, search, fields, limit) => get(type, { ...search, diagnosticSearch: { id: C.CAMERA_HEALTH_DIAGNOSTIC } }, fields, limit);
        return await C.completeWindow(withDiagnostic, 'StatusData', to - CAMERA_LOOKBACK_DAYS * DAY, to, ['id', 'device', 'dateTime', 'data']);
      } catch {
        camerasAvailable = false;
        return [];
      }
    }

    function filterIds() {
      return (pageState?.getGroupFilter?.() || []).map((x) => (typeof x === 'string' ? x : x.id)).filter(Boolean);
    }
    function recompute() {
      if (!inventory) { result = null; return; }
      result = C.analyze({ ...inventory, drivers: users, range, settings, tz, filter: filterIds(), handled: C.handledFromTasks(tasks, handled, HANDLED_DAYS), safetyAvailable, statusAvailable, faultsAvailable, camerasAvailable });
    }

    async function refresh() {
      if (!active || busy) return;
      const run = ++generation;
      busy = true;
      $('#fw-refresh').disabled = true;
      status('Refreshing…');
      try {
        await loadIdentity();
        let storageNote = '';
        try { await loadStorage(); } catch (error) { storageNote = ` Shared tasks and settings could not load: ${error.message}`; }
        tz = resolveTimeZone();
        if (run !== generation || !active) return;
        if (fullList()) {
          await loadAnalysis(run);
          if (run !== generation || !active) return;
          recompute();
        } else {
          inventory = null;
          result = null;
          tab = 'mine';
        }
        updated = new Date();
        const time = updated.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        const lag = fullList() && !safetyAvailable ? ' Safety data could not load, so no safety to-dos are shown.' : '';
        status(`Updated ${time}.${lag}${storageNote}`, Boolean(lag || storageNote));
        render();
      } catch (error) {
        if (run === generation && active) status(`Refresh failed. ${updated ? 'Showing the last good data. ' : ''}${error.message}`, true);
      } finally {
        if (run === generation) {
          busy = false;
          $('#fw-refresh').disabled = false;
        }
      }
    }
    function restart() {
      clearInterval(timer);
      generation++;
      busy = false;
      refresh();
      timer = setInterval(() => { if (!document.hidden) refresh(); }, 300000);
    }

    function changeText(change, lowerIsBetter, label) {
      if (change == null || !Number.isFinite(change)) return { text: 'No earlier data to compare', tone: '' };
      const rounded = Math.round(Math.abs(change));
      if (rounded === 0) return { text: `No change ${label}`, tone: '' };
      const up = change > 0;
      return { text: `${up ? 'Up' : 'Down'} ${rounded}${lowerIsBetter === null ? '' : '%'} ${label}`, tone: up === lowerIsBetter ? 'fw-worse' : 'fw-better' };
    }
    function renderKpis() {
      const target = $('#fw-kpis');
      target.replaceChildren();
      target.hidden = !result;
      if (!result) return;
      const { current, prior } = result.fleet;
      const label = `vs prior ${days} days`;
      const pointChange = current.utilization != null && prior.utilization != null ? current.utilization - prior.utilization : null;
      const pointText = pointChange == null ? { text: 'No earlier data to compare', tone: '' } : Math.round(Math.abs(pointChange)) === 0 ? { text: `No change ${label}`, tone: '' } : { text: `${pointChange > 0 ? 'Up' : 'Down'} ${C.plural(Math.round(Math.abs(pointChange)), 'point')} ${label}`, tone: pointChange > 0 ? 'fw-better' : 'fw-worse' };
      const cards = [
        ['Open to-dos', String(result.actions.length), { text: result.handledCount ? `${result.handledCount} handled or finished recently` : `${C.plural(current.vehicles, 'vehicle')} checked`, tone: '' }],
        ['Estimated idle fuel', C.money(current.idleCost), changeText(C.pctChange(current.idleCost, prior.idleCost), true, label)],
        ['Work-day utilization', current.utilization == null ? 'n/a' : `${Math.round(current.utilization)}%`, pointText],
        ['Safety events per 1,000 mi', !safetyAvailable || current.safetyRate == null ? 'n/a' : current.safetyRate.toFixed(1), safetyAvailable ? changeText(C.pctChange(current.safetyRate, prior.safetyRate), true, label) : { text: 'Safety data unavailable', tone: '' }],
      ];
      for (const [name, value, delta] of cards) {
        const card = el('div', 'fw-kpi');
        card.append(el('div', 'fw-kpi-label', name), el('div', 'fw-kpi-value', value), el('div', `fw-kpi-delta ${delta.tone}`, delta.text));
        target.append(card);
      }
    }

    function myTasks() {
      const cutoff = Date.now() - DONE_VISIBLE_DAYS * DAY;
      return tasks.filter((t) => t.assigneeId === me?.id && (t.status === 'open' || Date.parse(t.completedAt) > cutoff));
    }
    function teamTasks() {
      const cutoff = Date.now() - DONE_VISIBLE_DAYS * DAY;
      const all = C.userLevel(me, settings) >= 4;
      return tasks.filter((t) => (all || t.assignedById === me?.id) && (t.status === 'open' || Date.parse(t.completedAt) > cutoff));
    }
    function activeOrbKey() {
      if (tab === 'todo') return category === 'all' ? 'all' : category;
      if (tab === 'health') return healthOnly === 'cameras' ? 'cameras' : 'health';
      return tab;
    }
    function selectOrb(view) {
      tab = view.tab;
      if (view.category) category = view.category;
      healthOnly = view.only || null;
      groupFilter = null;
      showAll = false;
      compose = null;
      render();
      const target = $('#fw-view');
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches || motionOff ? 'auto' : 'smooth', block: 'start' });
    }
    function buildOrbNode(orb, position) {
      const node = el('button', position ? 'fw-orb' : 'fw-orb fw-orb-center', null, { type: 'button' });
      if (position) {
        node.style.setProperty('--x', position[0]);
        node.style.setProperty('--y', position[1]);
        node.style.setProperty('--delay', position[2]);
      }
      const pulse = el('span', 'fw-orb-pulse', null, { 'aria-hidden': 'true' });
      const moons = el('span', 'fw-moons', null, { 'aria-hidden': 'true' });
      moons.style.animationDelay = position ? position[2] : '0s';
      const text = el('span', 'fw-orb-text');
      const value = el('span', 'fw-orb-value');
      const label = el('span', 'fw-orb-label', orb.label);
      if (!position) text.append(el('span', 'fw-orb-brand', 'FLEET WOLF'));
      text.append(value, label);
      node.append(pulse, moons, text);
      return { node, value, moons, moonCount: -1 };
    }
    // Orbs update in place, because rebuilding them would restart their motion on every click.
    function renderStage() {
      const full = me ? fullList() : true;
      if (result === null && me && !full && tab !== 'mine') tab = 'mine';
      const orbs = C.buildOrbs({
        result,
        full,
        myOpen: myTasks().filter((t) => t.status === 'open').length,
        teamOpen: me ? teamTasks().filter((t) => t.status === 'open').length : 0,
      });
      const signature = [orbs.center.key, ...orbs.ring.map((o) => o.key)].join();
      if (signature !== stageSignature) {
        stageSignature = signature;
        for (const { node } of stageNodes.values()) node.remove();
        stageNodes.clear();
        [orbs.center, ...orbs.ring].forEach((orb, index) => {
          const parts = buildOrbNode(orb, index ? ORB_POSITIONS[index - 1] : null);
          stageNodes.set(orb.key, parts);
          $('#fw-orbit').append(parts.node);
        });
        $('#fw-orbit').style.height = orbs.ring.length ? '' : '260px';
      }
      const activeKey = activeOrbKey();
      for (const orb of [orbs.center, ...orbs.ring]) {
        const parts = stageNodes.get(orb.key);
        parts.value.textContent = String(orb.value);
        parts.node.className = `fw-orb${orb === orbs.center ? ' fw-orb-center' : ''} fw-tone-${orb.tone}`;
        parts.node.setAttribute('aria-pressed', String(orb.key === activeKey));
        parts.node.setAttribute('aria-label', `${orb.label}: ${orb.value}${TONE_WORDS[orb.tone]}`);
        parts.node.onclick = () => selectOrb(orb.view);
        const moonCount = Math.min(orb.count, MAX_MOONS);
        if (moonCount !== parts.moonCount) {
          parts.moonCount = moonCount;
          parts.moons.replaceChildren(...Array.from({ length: moonCount }, (_, i) => {
            const moon = el('span', 'fw-moon');
            moon.style.setProperty('--angle', `${(360 / moonCount) * i}deg`);
            return moon;
          }));
        }
      }
    }
    function syncMotion() {
      root.classList.toggle('fw-still', motionOff || !active);
      const toggle = $('#fw-motion');
      toggle.textContent = motionOff ? 'Play motion' : 'Pause motion';
      toggle.setAttribute('aria-pressed', String(motionOff));
    }
    function viewTitle() {
      if (tab === 'todo') return category === 'all' ? 'All to-dos' : `${CATEGORIES[category]} to-dos`;
      if (tab === 'health') return healthOnly === 'cameras' ? 'Cameras' : healthOnly === 'devices' ? 'Device Health' : 'Health';
      return { faults: 'Vehicle Faults', mine: 'My Tasks', team: 'Delegated' }[tab] || '';
    }
    function viewHead() {
      const head = el('div', 'fw-view-head');
      head.append(el('h2', null, viewTitle()), button('↑ Back to orbs', () => {
        $('#fw-stage').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches || motionOff ? 'auto' : 'smooth', block: 'start' });
      }, 'fw-link'));
      return head;
    }

    function openPage(page, args) {
      try { pageState.gotoPage(page, args); } catch (error) { status(`Could not open that page. ${error.message}`, true); }
    }
    function openTrips(vehicleId) {
      const span = range ? { startDate: new Date(range.current.from).toISOString(), endDate: new Date(range.current.to).toISOString() } : null;
      openPage('tripsHistory', { devices: [vehicleId], ...(span ? { dateRange: span } : {}) });
    }
    function canOpenTrips() {
      return typeof pageState?.gotoPage === 'function' && (pageState.hasAccessToPage ? pageState.hasAccessToPage('tripsHistory') : true);
    }

    function evidenceTable(vehicles) {
      const wrap = el('div', 'fw-table');
      const table = el('table');
      const head = el('tr');
      [['Vehicle'], ['Miles', 1], ['Work days used', 1], ['Idle hours', 1], ['Est. idle fuel', 1], ['Safety events', 1], ['']].forEach(([t, num]) => head.append(el('th', num ? 'fw-num' : null, t, { scope: 'col' })));
      const thead = el('thead');
      thead.append(head);
      const body = el('tbody');
      for (const v of vehicles) {
        const row = el('tr');
        row.append(el('td', null, v.name), el('td', 'fw-num', Math.round(v.miles).toLocaleString('en-US')), el('td', 'fw-num', `${v.workDaysUsed} of ${v.scheduledDays}`), el('td', 'fw-num', v.idleHours.toFixed(1)), el('td', 'fw-num', C.money(v.idleCost)), el('td', 'fw-num', String(v.events)));
        const cell = el('td');
        if (canOpenTrips()) cell.append(button('View trips', () => openTrips(v.id), 'fw-link', { 'aria-label': `View trips for ${v.name}` }));
        row.append(cell);
        body.append(row);
      }
      table.append(thead, body);
      wrap.append(table);
      return wrap;
    }

    function openTaskFor(key) {
      return tasks.find((t) => t.actionKey === key && t.status === 'open');
    }
    function delegateForm(action) {
      const devices = inventory.devices.filter((d) => action.vehicles.some((v) => v.id === d.id));
      const groupMap = new Map(inventory.groups.map((g) => [g.id, g]));
      const people = C.delegates({ me, users, settings, devices, groupMap });
      const form = el('form', 'fw-form');
      if (!people.length) {
        form.append(el('p', 'fw-muted', 'Nobody at a lower access level can see these vehicles. Change their data access in MyGeotab, or handle this one yourself.'));
        form.append(button('Close', () => { compose = null; render(); }));
        return form;
      }
      const select = el('select', null, null, { required: true });
      for (const level of [3, 2]) {
        const atLevel = people.filter((p) => C.userLevel(p, settings) === level);
        if (!atLevel.length) continue;
        const optgroup = el('optgroup', null, null, { label: C.LEVEL_NAMES[level] });
        for (const person of atLevel) {
          const open = tasks.filter((t) => t.assigneeId === person.id && t.status === 'open').length;
          optgroup.append(el('option', null, `${C.userName(person)} (${C.plural(open, 'open task')})`, { value: person.id }));
        }
        select.append(optgroup);
      }
      const note = el('textarea', null, null, { maxlength: 500, placeholder: 'What should they do or tell you?' });
      const personLabel = el('label', null, 'Delegate to');
      personLabel.append(select);
      const noteLabel = el('label', null, 'Note (optional)');
      noteLabel.append(note);
      const row = el('div', 'fw-row');
      row.append(el('button', 'fw-primary', 'Delegate', { type: 'submit' }), button('Cancel', () => { compose = null; render(); }));
      form.append(personLabel, noteLabel, row);
      form.onsubmit = async (event) => {
        event.preventDefault();
        const person = people.find((p) => p.id === select.value);
        await delegate(action, person, note.value.trim());
      };
      return form;
    }
    async function delegate(action, person, note) {
      const doc = {
        actionKey: action.key, title: action.title, why: action.why, next: action.next, severity: action.severity, category: action.category,
        amount: action.amount, estimated: Boolean(action.estimated), vehicles: action.vehicles.map(({ id, name }) => ({ id, name })),
        assigneeId: person.id, assigneeName: C.userName(person), assignedById: me.id, assignedByName: C.userName(me),
        assignedAt: new Date().toISOString(), note, status: 'open',
      };
      try {
        const id = await call('Add', { typeName: 'AddInData', entity: entity('task', doc) });
        tasks.push({ ...doc, id });
        compose = null;
        recompute();
        status(`Delegated to ${doc.assigneeName}. They will see it under My tasks next time they open this panel.`);
        render();
      } catch (error) {
        status(`Could not delegate. ${error.message}`, true);
      }
    }
    async function takeBack(task) {
      try {
        await call('Remove', { typeName: 'AddInData', entity: { id: task.id } });
        tasks = tasks.filter((t) => t.id !== task.id);
        recompute();
        status(`Took back the task from ${task.assigneeName}.`);
        render();
      } catch (error) {
        status(`Could not take it back. ${error.message}`, true);
      }
    }
    async function completeTask(task) {
      const { id, ...doc } = task;
      const next = { ...doc, status: 'done', completedAt: new Date().toISOString() };
      try {
        await call('Set', { typeName: 'AddInData', entity: entity('task', next, id) });
        Object.assign(task, next);
        recompute();
        status('Marked done.');
        render();
      } catch (error) {
        status(`Could not mark it done. ${error.message}`, true);
      }
    }
    async function markHandled(action) {
      const before = handled[action.key];
      handled[action.key] = Date.now() + HANDLED_DAYS * DAY;
      try {
        await saveSettingsDoc();
        recompute();
        status(`Marked handled. It comes back in ${HANDLED_DAYS} days if the problem is still there.`);
        render();
      } catch (error) {
        if (before == null) delete handled[action.key]; else handled[action.key] = before;
        status(`Could not save. ${error.message}`, true);
      }
    }
    function messageForm(action) {
      const vehicle = action.vehicles[0];
      const form = el('form', 'fw-form');
      const text = el('textarea', null, null, { required: true, maxlength: 255 });
      const label = el('label', null, `Message to ${vehicle.name}`);
      label.append(text);
      const row = el('div', 'fw-row');
      row.append(el('button', 'fw-primary', 'Send message', { type: 'submit' }), button('Cancel', () => { compose = null; render(); }));
      form.append(label, row);
      form.onsubmit = async (event) => {
        event.preventDefault();
        try {
          await call('Add', { typeName: 'TextMessage', entity: { device: { id: vehicle.id }, activeFrom: new Date().toISOString(), isDirectionToVehicle: true, messageContent: { contentType: 'Normal', message: text.value.trim() } } });
          compose = null;
          status(`Message sent to ${vehicle.name}.`);
          render();
        } catch (error) {
          status(`Message was not sent. ${error.message}`, true);
        }
      };
      return form;
    }

    function cardHead(item, isOpen, toggle, assignedText) {
      const head = button(null, toggle, 'fw-card-head', { 'aria-expanded': String(isOpen) });
      head.append(el('span', `fw-sev fw-sev-${item.severity}`, item.severity === 'high' ? 'High' : item.severity === 'medium' ? 'Medium' : 'Low'));
      const main = el('span');
      main.append(el('span', 'fw-title', item.title), el('span', 'fw-why', item.why));
      if (assignedText) main.append(el('span', 'fw-assigned', assignedText));
      head.append(main);
      const amount = el('span', 'fw-amount');
      if (item.amount != null) {
        amount.textContent = C.money(item.amount);
        amount.append(el('small', null, item.estimated ? 'estimate' : ''));
      }
      head.append(amount);
      return head;
    }
    function actionCard(action) {
      const card = el('article', 'fw-card');
      const isOpen = expanded.has(action.key);
      const task = openTaskFor(action.key);
      card.append(cardHead(action, isOpen, () => { if (isOpen) expanded.delete(action.key); else expanded.add(action.key); render(); }, task ? `Delegated to ${task.assigneeName} by ${task.assignedByName}` : null));
      if (!isOpen) return card;
      const body = el('div', 'fw-body');
      body.append(el('p', 'fw-next', action.next));
      if (action.faults) body.append(faultTable(action.faults, false));
      body.append(evidenceTable(action.vehicles));
      if (action.partial) body.append(el('p', 'fw-muted', 'Some trips had no idle data and are left out, so the real figure may be higher.'));
      const row = el('div', 'fw-row');
      if (task) row.append(button('Take back', () => takeBack(task)));
      else row.append(button('Delegate', () => { compose = { key: action.key, mode: 'delegate' }; render(); }, 'fw-primary'));
      row.append(button(`Mark handled for ${HANDLED_DAYS} days`, () => markHandled(action)));
      if (settings.messaging && action.vehicles.length === 1) row.append(button('Message vehicle', () => { compose = { key: action.key, mode: 'message' }; render(); }));
      body.append(row);
      if (compose?.key === action.key) body.append(compose.mode === 'delegate' ? delegateForm(action) : messageForm(action));
      card.append(body);
      return card;
    }
    function taskCard(task, mode) {
      const card = el('article', 'fw-card');
      const key = `task:${task.id}`;
      const isOpen = expanded.has(key);
      const when = new Date(task.assignedAt).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
      const who = mode === 'mine' ? `From ${task.assignedByName}, ${when}` : `Assigned to ${task.assigneeName} by ${task.assignedByName}, ${when}`;
      const state = task.status === 'done' ? ` · Done ${new Date(task.completedAt).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' })}` : ' · Open';
      card.append(cardHead(task, isOpen, () => { if (isOpen) expanded.delete(key); else expanded.add(key); render(); }, who + state));
      if (!isOpen) return card;
      const body = el('div', 'fw-body');
      if (task.note) body.append(el('p', 'fw-next', `Note: ${task.note}`));
      body.append(el('p', null, task.next));
      const vehicles = el('div', 'fw-row');
      for (const vehicle of task.vehicles || []) {
        vehicles.append(canOpenTrips() ? button(`Trips: ${vehicle.name}`, () => openTrips(vehicle.id), 'fw-link') : el('span', null, vehicle.name));
      }
      body.append(vehicles);
      const row = el('div', 'fw-row');
      if (task.status === 'open' && task.assigneeId === me?.id) row.append(button('Mark done', () => completeTask(task), 'fw-primary'));
      if (task.status === 'open' && mode === 'team') row.append(button('Take back', () => takeBack(task)));
      if (row.children.length) body.append(row);
      card.append(body);
      return card;
    }
    function emptyState(text) {
      return el('p', 'fw-empty', text);
    }
    function severityLabel(level) {
      return level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low';
    }
    function faultTable(rows, withVehicle) {
      const wrap = el('div', 'fw-table');
      const table = el('table');
      const thead = el('thead');
      const head = el('tr');
      [...(withVehicle ? [['Vehicle']] : []), ['Fault'], ['Severity'], ['Times seen', 1], ['Last seen', 1]].forEach(([t, num]) => head.append(el('th', num ? 'fw-num' : null, t, { scope: 'col' })));
      thead.append(head);
      const body = el('tbody');
      for (const fault of rows) {
        const row = el('tr');
        if (withVehicle) row.append(el('td', null, fault.vehicle));
        const name = el('td', 'fw-wrap', fault.code != null ? `${fault.name} (code ${fault.code})` : fault.name);
        const level = el('td');
        level.append(el('span', `fw-sev fw-sev-${fault.level}`, severityLabel(fault.level)));
        row.append(name, level, el('td', 'fw-num', fault.occurrences.toLocaleString('en-US')), el('td', 'fw-num', new Date(fault.at).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' })));
        body.append(row);
      }
      table.append(thead, body);
      wrap.append(table);
      return wrap;
    }
    function statGroup(title, stats) {
      const section = el('div', 'fw-stat-group');
      section.append(el('h3', null, title));
      const grid = el('div', 'fw-stats');
      for (const [label, value, tone] of stats) {
        const stat = el('div', `fw-stat ${tone || ''}`);
        stat.append(el('div', 'fw-stat-value', String(value)), el('div', 'fw-stat-label', label));
        grid.append(stat);
      }
      section.append(grid);
      return section;
    }
    function actionList(target, matches, emptyText) {
      const items = result.actions.filter(matches);
      const heading = el('h2', null, 'To-dos');
      heading.style.marginTop = '20px';
      target.append(heading);
      const list = el('div', 'fw-list');
      if (!items.length) list.append(emptyState(emptyText));
      items.forEach((action) => list.append(actionCard(action)));
      target.append(list);
    }
    function renderHealth(target) {
      const { devices, cameras, statusAvailable: statusOk, camerasAvailable: camerasOk } = result.health;
      const summary = el('div', 'fw-stat-row');
      const flagged = (count) => (count ? 'fw-stat-flag' : '');
      if (healthOnly !== 'cameras') summary.append(statGroup('GO devices', statusOk
        ? [['Vehicles checked', devices.total], ['Not reporting', devices.offline, flagged(devices.offline)], ['Not locating', devices.notLocating, flagged(devices.notLocating)], ['With device faults', devices.deviceFaults, flagged(devices.deviceFaults)]]
        : [['Device status unavailable', 'n/a']]));
      if (healthOnly !== 'devices') summary.append(statGroup('Cameras', camerasOk
        ? [['Healthy', cameras.levels[0]], ['Unstable', cameras.levels[1], flagged(cameras.levels[1])], ['Unhealthy', cameras.levels[2], flagged(cameras.levels[2])], ['Not working', cameras.levels[3], flagged(cameras.levels[3])]]
        : [['Camera health unavailable', 'n/a']]));
      target.append(summary);
      const matches = (a) => a.category === 'health' && (healthOnly === 'cameras' ? a.type === 'camera' : healthOnly === 'devices' ? a.type !== 'camera' : true);
      actionList(target, matches, healthOnly === 'cameras' ? 'Every camera with a reading looks fine.' : 'All devices with a reading look fine.');
    }
    function renderFaults(target) {
      if (!result.faults.available) {
        target.append(emptyState('Fault codes could not load. Try Refresh.'));
        return;
      }
      const { rows, vehicles, high, medium, low } = result.faults;
      const summary = el('div', 'fw-stat-row');
      summary.append(statGroup(`Active fault codes, last ${days} days and today`, [['Vehicles affected', vehicles], ['High', high, high ? 'fw-stat-flag' : ''], ['Medium', medium], ['Low', low]]));
      target.append(summary);
      actionList(target, (a) => a.category === 'faults', low ?'Only low severity codes are active, so nothing needs action yet.' : 'No active fault codes that need action.');
      if (rows.length) {
        const section = el('section', 'fw-section', null, { 'aria-label': 'All active fault codes' });
        section.append(el('h2', null, 'All active fault codes'), faultTable(rows, true));
        target.append(section);
      }
    }

    function deltaCell(change, lowerIsBetter, suffix = '%') {
      if (change == null || !Number.isFinite(change) || Math.round(Math.abs(change)) === 0) return el('td', 'fw-num', '–');
      const up = change > 0;
      return el('td', `fw-num ${up === lowerIsBetter ? 'fw-delta-worse' : 'fw-delta-better'}`, `${up ? '+' : '−'}${Math.round(Math.abs(change))}${suffix}`);
    }
    function groupTable() {
      const section = el('section', 'fw-section', null, { 'aria-label': 'Group comparison' });
      section.append(el('h2', null, 'By group'));
      const wrap = el('div', 'fw-table');
      const table = el('table');
      const thead = el('thead');
      const head = el('tr');
      [['Group'], ['Vehicles', 1], ['To-dos', 1], ['Utilization', 1], ['Change', 1], ['Idle hours', 1], ['Change', 1], ['Est. idle fuel', 1], ['Safety per 1,000 mi', 1], ['Change', 1]].forEach(([t, num]) => head.append(el('th', num ? 'fw-num' : null, t, { scope: 'col' })));
      thead.append(head);
      const body = el('tbody');
      for (const row of result.rows) {
        const { current, prior } = row;
        const tr = el('tr', groupFilter === row.id ? 'fw-selected' : null);
        const first = el('td');
        first.append(button(row.name, () => { groupFilter = groupFilter === row.id ? null : row.id; showAll = false; render(); }, 'fw-link', { 'aria-pressed': String(groupFilter === row.id), title: 'Show this group’s to-dos' }));
        const count = result.actions.filter((a) => a.groupIds.includes(row.id)).length;
        const points = current.utilization != null && prior.utilization != null ? current.utilization - prior.utilization : null;
        tr.append(first, el('td', 'fw-num', String(current.vehicles)), el('td', 'fw-num', String(count)), el('td', 'fw-num', current.utilization == null ? 'n/a' : `${Math.round(current.utilization)}%`), deltaCell(points, false, ' pts'), el('td', 'fw-num', current.idleHours.toFixed(1)), deltaCell(C.pctChange(current.idleHours, prior.idleHours), true), el('td', 'fw-num', C.money(current.idleCost)), el('td', 'fw-num', !safetyAvailable || current.safetyRate == null ? 'n/a' : current.safetyRate.toFixed(1)), deltaCell(C.pctChange(current.safetyRate, prior.safetyRate), true));
        body.append(tr);
      }
      table.append(thead, body);
      wrap.append(table);
      section.append(wrap);
      return section;
    }
    function renderTodo(target) {
      const chips = el('div', 'fw-chips', null, { role: 'group', 'aria-label': 'Filter to-dos' });
      for (const [id, label] of Object.entries(CATEGORIES)) {
        const count = id === 'all' ? result.actions.length : result.actions.filter((a) => a.category === id).length;
        if (id !== 'all' && !count) continue;
        chips.append(button(`${label} (${count})`, () => { category = id; showAll = false; render(); }, null, { 'aria-pressed': String(category === id) }));
      }
      if (groupFilter) {
        const name = result.rows.find((r) => r.id === groupFilter)?.name;
        if (name) chips.append(button(`Group: ${name} ✕`, () => { groupFilter = null; render(); }, null, { 'aria-pressed': 'true' }));
        else groupFilter = null;
      }
      target.append(chips);
      const matching = result.actions.filter((a) => (category === 'all' || a.category === category) && (!groupFilter || a.groupIds.includes(groupFilter)));
      const list = el('div', 'fw-list');
      if (!matching.length) list.append(emptyState(result.actions.length ? 'Nothing here for this filter.' : 'Nothing needs attention for this period. Thresholds can be changed in Settings.'));
      (showAll ? matching : matching.slice(0, LIST_PAGE)).forEach((action) => list.append(actionCard(action)));
      target.append(list);
      if (!showAll && matching.length > LIST_PAGE) {
        const row = el('div', 'fw-chips');
        row.append(button(`Show all ${matching.length}`, () => { showAll = true; render(); }));
        target.append(row);
      }
      if (result.rows.length) target.append(groupTable());
    }
    function renderMine(target) {
      const mine = myTasks().sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(b.assignedAt).localeCompare(String(a.assignedAt)));
      const list = el('div', 'fw-list');
      list.style.marginTop = '14px';
      if (!mine.length) list.append(emptyState(me ? 'Nothing has been delegated to you.' : 'Your MyGeotab user could not be identified, so tasks cannot be shown.'));
      mine.forEach((task) => list.append(taskCard(task, 'mine')));
      target.append(list);
    }
    function renderTeam(target) {
      const below = C.delegates({ me, users, settings });
      const section = el('section', 'fw-section', null, { 'aria-label': 'Team by access level' });
      section.style.marginTop = '14px';
      section.append(el('h2', null, 'Your team by access level'));
      for (const level of [3, 2]) {
        const atLevel = below.filter((u) => C.userLevel(u, settings) === level).sort((a, b) => C.userName(a).localeCompare(C.userName(b)));
        if (!atLevel.length) continue;
        const block = el('div', 'fw-level');
        block.append(el('h3', null, C.LEVEL_NAMES[level]));
        const people = el('div', 'fw-people');
        for (const person of atLevel) {
          const open = teamTasks().filter((t) => t.assigneeId === person.id && t.status === 'open').length;
          people.append(button(`${C.userName(person)} (${open})`, () => { personFilter = personFilter === person.id ? null : person.id; render(); }, 'fw-person', { 'aria-pressed': String(personFilter === person.id) }));
        }
        block.append(people);
        section.append(block);
      }
      if (!below.length) section.append(el('p', 'fw-muted', 'Nobody in this database sits below your access level.'));
      target.append(section);
      const shown = teamTasks().filter((t) => !personFilter || t.assigneeId === personFilter).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(b.assignedAt).localeCompare(String(a.assignedAt)));
      const list = el('div', 'fw-list');
      if (!shown.length) list.append(emptyState(personFilter ? 'No tasks for this person.' : 'Nothing delegated yet. Open a to-do and choose Delegate.'));
      shown.forEach((task) => list.append(taskCard(task, 'team')));
      target.append(list);
    }

    function numberField(key, label, help, step = '1') {
      const wrap = el('label', null, label);
      wrap.append(el('input', null, null, { type: 'number', min: '0', step, value: String(settings[key]), 'data-setting': key }));
      if (help) wrap.append(el('small', null, help));
      return wrap;
    }
    function renderSettings() {
      const target = $('#fw-settings');
      const isAdmin = Boolean(me) && C.userLevel(me, settings) >= 4;
      $('#fw-settings-toggle').hidden = !isAdmin;
      target.hidden = !(settingsOpen && isAdmin);
      target.replaceChildren();
      if (target.hidden) return;
      const form = el('form');
      form.append(el('h2', null, 'Settings for this database'), el('h3', null, 'Costs'));
      const costs = el('div', 'fw-settings-grid');
      costs.append(numberField('fuelPrice', 'Fuel price ($/gal)', null, '0.01'), numberField('idleGallonsPerHour', 'Fuel burned idling (gal/hr)', 'About 0.8 for light duty; higher for heavy trucks.', '0.1'), numberField('vehicleMonthlyCost', 'Monthly cost per vehicle ($)', 'Used to price unused trucks. 0 leaves them unpriced.'));
      const tzLabel = el('label', null, 'Time zone');
      tzLabel.append(el('input', null, null, { type: 'text', value: settings.timeZone, placeholder: 'America/Chicago', 'data-setting-text': 'timeZone' }), el('small', null, `Blank uses each person’s MyGeotab profile. Now using ${tz}.`));
      costs.append(tzLabel);
      form.append(costs, el('h3', null, 'Default work days'));
      const dayRow = el('div', 'fw-days');
      DAY_LABELS.forEach((name, index) => {
        const label = el('label');
        label.append(el('input', null, null, { type: 'checkbox', 'data-workday': String(index), checked: settings.workDays.includes(index) }), document.createTextNode(name));
        dayRow.append(label);
      });
      form.append(dayRow, el('h3', null, 'What raises a to-do'));
      const thresholds = el('div', 'fw-settings-grid');
      thresholds.append(numberField('idleMinDollarsPerWeek', 'Idle cost floor ($/week)', 'Smaller amounts are ignored.'), numberField('idleRisePct', 'Idle rise (%)'), numberField('idleHoursPerDay', 'Idle hours per vehicle work day', 'Flags steady high idling even without a rise.', '0.1'), numberField('safetyMinEvents', 'Minimum safety events'), numberField('safetyRatePer1000', 'Safety events per 1,000 mi'), numberField('safetyRisePct', 'Safety rise (%)'), numberField('unusedMinWorkdays', 'Unused after (work days)'), numberField('offlineDays', 'Device silent after (days)'), numberField('offScheduleMinMiles', 'Off-schedule minimum (miles)'), numberField('cameraMinLevel', 'Camera level to flag', '1 Unstable, 2 Unhealthy, 3 Not working.'));
      const lowFaults = el('label', 'fw-row');
      lowFaults.append(el('input', null, null, { type: 'checkbox', 'data-low-faults': '', checked: settings.faultIncludeLow }), document.createTextNode('Raise to-dos for low severity fault codes'));
      thresholds.append(lowFaults);
      form.append(thresholds);

      form.append(el('h3', null, 'Access levels'));
      form.append(el('p', 'fw-muted', 'Set from each person’s MyGeotab security clearance. People can only delegate to a lower level. Hiding the list is a convenience: MyGeotab’s own data access still decides what anyone can read.'));
      const fullWrap = el('label', null, 'Who sees the full to-do list');
      const fullSelect = el('select', null, null, { 'data-full-level': '' });
      for (const level of [4, 3, 2, 1]) fullSelect.append(el('option', null, `${C.LEVEL_NAMES[level]}${level > 1 && level < 4 ? ' and above' : level === 1 ? ' and above (everyone)' : ' only'}`, { value: String(level), selected: settings.fullListMinLevel === level }));
      fullWrap.append(fullSelect);
      const levelGrid = el('div', 'fw-settings-grid');
      levelGrid.append(fullWrap);
      form.append(levelGrid);
      const clearanceIds = [...new Set(users.flatMap((u) => (u.securityGroups || []).map((g) => (typeof g === 'string' ? g : g.id))))].sort();
      const clearanceTable = el('table');
      const headRow = el('tr');
      ['Security clearance', 'People', 'Level'].forEach((t) => headRow.append(el('th', null, t, { scope: 'col' })));
      const clearanceHead = el('thead');
      clearanceHead.append(headRow);
      const clearanceBody = el('tbody');
      for (const id of clearanceIds) {
        const tr = el('tr');
        const name = C.SYSTEM_CLEARANCES[id]?.name || clearanceNames.get(id) || `Custom clearance (${id})`;
        const select = el('select', null, null, { 'data-clearance': id, 'aria-label': `Level for ${name}` });
        for (const level of [4, 3, 2, 1, 0]) select.append(el('option', null, C.LEVEL_NAMES[level], { value: String(level), selected: C.clearanceLevel(id, settings) === level }));
        const cell = el('td');
        cell.append(select);
        tr.append(el('td', null, name), el('td', null, String(users.filter((u) => (u.securityGroups || []).some((g) => (typeof g === 'string' ? g : g.id) === id)).length)), cell);
        clearanceBody.append(tr);
      }
      clearanceTable.append(clearanceHead, clearanceBody);
      form.append(clearanceTable);

      if (inventory && result) {
        form.append(el('h3', null, 'Groups to report on'));
        form.append(el('p', 'fw-muted', 'None ticked means every lowest-level group that has vehicles. A work schedule set here replaces the default for that group.'));
        const scheduleTable = el('table');
        const groupHead = el('thead');
        const groupHeadRow = el('tr');
        ['Group', 'Report', ...DAY_LABELS].forEach((t) => groupHeadRow.append(el('th', null, t, { scope: 'col' })));
        groupHead.append(groupHeadRow);
        const groupBody = el('tbody');
        for (const group of result.candidates) {
          const tr = el('tr');
          tr.append(el('td', null, group.name));
          const reportCell = el('td');
          reportCell.append(el('input', null, null, { type: 'checkbox', 'data-report': group.id, checked: settings.reportGroupIds.includes(group.id), 'aria-label': `Report on ${group.name}` }));
          tr.append(reportCell);
          const schedule = settings.groupSchedules[group.id] || settings.workDays;
          DAY_LABELS.forEach((name, index) => {
            const cell = el('td');
            cell.append(el('input', null, null, { type: 'checkbox', 'data-schedule': group.id, 'data-day': String(index), checked: schedule.includes(index), 'aria-label': `${group.name} works ${name}` }));
            tr.append(cell);
          });
          groupBody.append(tr);
        }
        scheduleTable.append(groupHead, groupBody);
        const scheduleWrap = el('div', 'fw-table');
        scheduleWrap.append(scheduleTable);
        form.append(scheduleWrap);

        form.append(el('h3', null, 'Safety rules to count'));
        form.append(el('p', 'fw-muted', 'None ticked uses every rule about speeding, harsh driving or seat belts.'));
        const checks = el('div', 'fw-checks');
        for (const rule of [...inventory.rules].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
          const label = el('label');
          label.append(el('input', null, null, { type: 'checkbox', 'data-rule': rule.id, checked: settings.safetyRuleIds.includes(rule.id) }), document.createTextNode(rule.name));
          checks.append(label);
        }
        form.append(checks);
      }
      const messagingLabel = el('label', 'fw-row');
      messagingLabel.append(el('input', null, null, { type: 'checkbox', 'data-messaging': '', checked: settings.messaging }), document.createTextNode('Show Message vehicle button (needs a device that can receive text messages)'));
      form.append(messagingLabel);
      const row = el('div', 'fw-row');
      row.style.marginTop = '14px';
      row.append(el('button', 'fw-primary', 'Save settings', { type: 'submit' }), button('Cancel', () => { settingsOpen = false; render(); }));
      form.append(row);
      form.onsubmit = async (event) => { event.preventDefault(); await saveSettings(form); };
      target.append(form);
    }
    async function saveSettings(form) {
      const previous = settings;
      const next = { ...settings };
      form.querySelectorAll('[data-setting]').forEach((input) => { next[input.dataset.setting] = Number(input.value); });
      const zone = form.querySelector('[data-setting-text]').value.trim();
      if (zone) {
        try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); } catch { status(`"${zone}" is not a recognized time zone, for example America/Chicago.`, true); return; }
      }
      next.timeZone = zone;
      next.workDays = [...form.querySelectorAll('[data-workday]:checked')].map((x) => Number(x.dataset.workday));
      next.messaging = form.querySelector('[data-messaging]').checked;
      next.faultIncludeLow = form.querySelector('[data-low-faults]').checked;
      next.fullListMinLevel = Number(form.querySelector('[data-full-level]').value);
      next.clearanceLevels = {};
      form.querySelectorAll('[data-clearance]').forEach((select) => {
        const level = Number(select.value);
        const id = select.dataset.clearance;
        if (level !== (C.SYSTEM_CLEARANCES[id]?.level ?? 2)) next.clearanceLevels[id] = level;
      });
      if (form.querySelector('[data-report]')) {
        next.reportGroupIds = [...form.querySelectorAll('[data-report]:checked')].map((x) => x.dataset.report);
        next.safetyRuleIds = [...form.querySelectorAll('[data-rule]:checked')].map((x) => x.dataset.rule);
        const schedules = {};
        for (const group of result.candidates) {
          const chosen = [...form.querySelectorAll(`[data-schedule="${group.id}"]:checked`)].map((x) => Number(x.dataset.day));
          const same = chosen.length === next.workDays.length && chosen.every((d) => next.workDays.includes(d));
          if (!same) schedules[group.id] = chosen;
        }
        next.groupSchedules = schedules;
      }
      if (C.userLevel(me, C.mergeSettings(next)) < 4) { status('That change would remove your own administrator level, so it was not saved.', true); return; }
      settings = C.mergeSettings(next);
      try {
        await saveSettingsDoc();
        settingsOpen = false;
        const zoneChanged = resolveTimeZone() !== tz;
        status('Settings saved.');
        if (zoneChanged) { await refresh(); return; }
        recompute();
        render();
      } catch (error) {
        settings = previous;
        status(`Settings were not saved. ${error.message}`, true);
      }
    }

    function renderNotes() {
      const target = $('#fw-notes');
      target.replaceChildren();
      const info = [];
      if (!result) {
        info.push('You see tasks delegated to you. MyGeotab’s own data access still applies to every vehicle.');
      } else {
        // A failed load stays outside the box, so missing to-dos never look like a clean fleet.
        if (!statusAvailable) target.append(el('p', 'fw-note-alert', 'Device status could not load, so silent-device to-dos are not shown.'));
        if (!faultsAvailable) target.append(el('p', 'fw-note-alert', 'Fault codes could not load, so fault to-dos are not shown.'));
        if (!camerasAvailable) target.append(el('p', 'fw-note-alert', 'Camera health could not load, so camera to-dos are not shown.'));
        info.push(`Comparing ${range.current.first} to ${range.current.last} with ${range.prior.first} to ${range.prior.last}, in ${tz}. Complete days only; today is left out until it finishes.`);
        info.push(`Dollar figures are estimates: idle hours × ${settings.idleGallonsPerHour} gal/hr × $${settings.fuelPrice.toFixed(2)}/gal. Utilization counts work days with driving out of scheduled work days. Current group membership is used for all dates.`);
        const missing = result.fleet.current.idleMissing;
        if (missing) info.push(`Trips with no idle data, left out of idle totals: ${missing.toLocaleString('en-US')}.`);
        if (result.overlapping) info.push('Some vehicles belong to more than one group, so group rows can add up to more than the fleet total. The figures at the top count each vehicle once.');
        if (safetyAvailable) info.push(result.safetyRules.length ? `Safety counts: ${result.safetyRules.map((r) => r.name).join(', ')}.` : 'No safety rules were found to count.');
        if (camerasAvailable) info.push(`Camera checks use Geotab’s camera health reading from the last ${CAMERA_LOOKBACK_DAYS} days, available for GO Focus, GO Focus Plus, Lytx Surfsight and Xirgo. Other cameras, and vehicles with no reading, are not counted.`);
      }
      const box = el('details', 'fw-data-info', null, { open: dataInfoOpen });
      box.ontoggle = () => { dataInfoOpen = box.open; };
      box.append(el('summary', null, 'For data set info, click here'), ...info.map((text) => el('p', null, text)));
      target.append(box);
    }

    function render() {
      if (!root) return;
      const level = me ? C.userLevel(me, settings) : null;
      $('#fw-whoami').textContent = me ? `Signed in as ${C.userName(me)} · ${C.LEVEL_NAMES[level]} access` : '';
      const showData = fullList();
      $('#fw-period-wrap').hidden = !showData;
      $('#fw-export').hidden = !showData;
      $('#fw-settings-toggle').setAttribute('aria-expanded', String(settingsOpen));
      renderSettings();
      renderStage();
      syncMotion();
      renderKpis();
      const view = $('#fw-view');
      view.replaceChildren(viewHead());
      if (tab === 'todo' && result) renderTodo(view);
      else if (tab === 'health' && result) renderHealth(view);
      else if (tab === 'faults' && result) renderFaults(view);
      else if (tab === 'team' && me) renderTeam(view);
      else renderMine(view);
      renderNotes();
    }

    function exportCsv() {
      if (!result) return;
      const header = ['Severity', 'Category', 'To-do', 'Why', 'Next step', 'Estimated cost', 'Vehicles', 'Delegated to', 'Period start', 'Period end'];
      const rows = result.actions.map((a) => [a.severity, CATEGORIES[a.category], a.title, a.why, a.next, a.amount == null ? '' : Math.round(a.amount), a.vehicles.map((v) => v.name).join('; '), openTaskFor(a.key)?.assigneeName || '', range.current.first, range.current.last]);
      const blob = new Blob(['﻿', C.toCsv([header, ...rows])], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = el('a', null, null, { href: url, download: `fleet-wolf-action-panel-${range.current.last}.csv` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status(`Exported ${C.plural(rows.length, 'to-do')}.`);
    }

    function mount() {
      root = document.getElementById('fwActionPanel');
      if (!root) throw new Error('Fleet Wolf Action Panel page was not loaded.');
      $('#fw-days').onchange = (event) => { days = Number(event.target.value); showAll = false; generation++; busy = false; refresh(); };
      $('#fw-refresh').onclick = refresh;
      $('#fw-export').onclick = exportCsv;
      $('#fw-settings-toggle').onclick = () => { settingsOpen = !settingsOpen; render(); };
      try { motionOff = window.localStorage.getItem(MOTION_KEY) === 'off'; } catch { motionOff = false; }
      $('#fw-motion').onclick = () => {
        motionOff = !motionOff;
        try { window.localStorage.setItem(MOTION_KEY, motionOff ? 'off' : 'on'); } catch { /* only lasts this visit */ }
        syncMotion();
      };
      renderStage();
      syncMotion();
    }

    return {
      initialize(apiObject, stateObject, callback) {
        api = apiObject;
        pageState = stateObject;
        mount();
        callback();
      },
      focus(apiObject, stateObject) {
        api = apiObject;
        pageState = stateObject;
        active = true;
        syncMotion();
        restart();
      },
      blur() {
        active = false;
        generation++;
        busy = false;
        clearInterval(timer);
        syncMotion();
      },
    };
  };
})();
