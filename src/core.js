(function (scope) {
  'use strict';

  const DAY = 86400000;
  const KM_PER_MILE = 1.609344;
  const NO_DRIVER = new Set(['UnknownDriverId', 'NoDriverId']);
  const SAFETY_PATTERN = /speed|harsh|hard\s|brak|corner|accel|seat\s?belt|aggressive/i;
  const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
  const CAMERA_LEVELS = ['Healthy', 'Unstable', 'Unhealthy', 'Not working'];
  // Geotab's "Video device health" status diagnostic: 0 healthy, 1 unstable, 2 unhealthy, 3 not working.
  const CAMERA_HEALTH_DIAGNOSTIC = 'aOzdYMcJkw06ft9g4uXvpIA';

  const DEFAULTS = {
    timeZone: '',
    workDays: [1, 2, 3, 4, 5],
    groupSchedules: {},
    reportGroupIds: [],
    safetyRuleIds: [],
    fuelPrice: 3.75,
    idleGallonsPerHour: 0.8,
    vehicleMonthlyCost: 0,
    idleMinDollarsPerWeek: 25,
    idleRisePct: 20,
    idleHoursPerDay: 1,
    safetyMinEvents: 3,
    safetyRatePer1000: 15,
    safetyRisePct: 50,
    unusedMinWorkdays: 3,
    offlineDays: 3,
    offScheduleMinMiles: 5,
    cameraMinLevel: 1,
    faultIncludeLow: false,
    messaging: false,
    fullListMinLevel: 3,
    clearanceLevels: {},
  };

  const LEVEL_NAMES = { 4: 'Administrator', 3: 'Supervisor', 2: 'Standard', 1: 'View only', 0: 'No access' };
  const SYSTEM_CLEARANCES = {
    GroupEverythingSecurityId: { level: 4, name: 'Administrator' },
    GroupSupervisorSecurityId: { level: 3, name: 'Supervisor' },
    GroupUserSecurityId: { level: 2, name: 'Default User' },
    GroupViewOnlySecurityId: { level: 1, name: 'View Only' },
    GroupDriveUserSecurityId: { level: 0, name: 'Drive App User' },
    GroupNothingSecurityId: { level: 0, name: 'Nothing' },
  };
  const CUSTOM_CLEARANCE_LEVEL = 2;
  const MIN_DELEGATE_LEVEL = 2;

  function clearanceLevel(id, settings) {
    const override = settings.clearanceLevels?.[id];
    if (Number.isInteger(override)) return override;
    return SYSTEM_CLEARANCES[id]?.level ?? CUSTOM_CLEARANCE_LEVEL;
  }
  function userLevel(user, settings) {
    const ids = (user?.securityGroups || []).map((g) => (typeof g === 'string' ? g : g.id));
    return ids.length ? Math.max(...ids.map((id) => clearanceLevel(id, settings))) : 0;
  }
  function userName(user) {
    return [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.name || 'Unknown user';
  }
  function seesFullList(user, settings) {
    return userLevel(user, settings) >= settings.fullListMinLevel;
  }
  function userCoversDevices(user, devices, groupMap) {
    const scope = (user.companyGroups || []).map((g) => (typeof g === 'string' ? g : g.id));
    if (scope.includes('GroupCompanyId')) return true;
    const allowed = new Set();
    for (const id of scope) descendants(id, groupMap, allowed);
    return devices.every((device) => memberships(device).some((id) => allowed.has(id)));
  }
  // Delegation only goes downhill, and only to someone who can open the vehicles and save the finished task.
  function delegates({ me, users, settings, devices = [], groupMap = new Map(), now = Date.now() }) {
    const myLevel = userLevel(me, settings);
    return users
      .filter((user) => {
        const level = userLevel(user, settings);
        if (user.id === me.id || level < MIN_DELEGATE_LEVEL || level >= myLevel) return false;
        const end = Date.parse(user.activeTo);
        if (Number.isFinite(end) && end <= now) return false;
        return userCoversDevices(user, devices, groupMap);
      })
      .sort((a, b) => userLevel(b, settings) - userLevel(a, settings) || userName(a).localeCompare(userName(b)));
  }
  function handledFromTasks(tasks, handled = {}, snoozeDays = 7) {
    const merged = { ...handled };
    for (const task of tasks) {
      if (task.status !== 'done') continue;
      const until = Date.parse(task.completedAt) + snoozeDays * DAY;
      if (Number.isFinite(until)) merged[task.actionKey] = Math.max(merged[task.actionKey] || 0, until);
    }
    return merged;
  }

  function mergeSettings(stored) {
    const merged = { ...DEFAULTS, ...(stored || {}) };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[key] === 'number' && !(Number.isFinite(merged[key]) && merged[key] >= 0)) merged[key] = DEFAULTS[key];
    }
    return merged;
  }

  const formatters = new Map();
  function formatter(tz) {
    if (!formatters.has(tz)) {
      formatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
    }
    return formatters.get(tz);
  }
  function parts(time, tz) {
    return Object.fromEntries(formatter(tz).formatToParts(new Date(time)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  }
  function localDate(time, tz) {
    const p = parts(time, tz);
    return `${p.year}-${p.month}-${p.day}`;
  }
  function shiftDate(date, days) {
    return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
  }
  function dayOfWeek(date) {
    return new Date(`${date}T12:00:00Z`).getUTCDay();
  }
  function midnight(date, tz) {
    const desired = Date.parse(`${date}T00:00:00Z`);
    let guess = desired;
    for (let i = 0; i < 3; i++) {
      const p = parts(guess, tz);
      guess += desired - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    }
    return guess;
  }
  function block(first, last, tz) {
    const windows = [];
    for (let date = first; date <= last; date = shiftDate(date, 1)) {
      windows.push({ date, from: midnight(date, tz), to: midnight(shiftDate(date, 1), tz) });
    }
    return { first, last, windows, from: windows[0].from, to: windows[windows.length - 1].to };
  }
  // Periods are complete days only, so today's partial data never skews a comparison.
  function period(days, tz, now = Date.now()) {
    const today = localDate(now, tz);
    return {
      days,
      today,
      current: block(shiftDate(today, -days), shiftDate(today, -1), tz),
      prior: block(shiftDate(today, -2 * days), shiftDate(today, -days - 1), tz),
    };
  }

  function seconds(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    return m ? +(m[1] || 0) * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4] : null;
  }
  function memberships(device) {
    return (device.groups || []).map((g) => (typeof g === 'string' ? g : g.id));
  }
  function descendants(id, groupMap, seen = new Set()) {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const child of groupMap.get(id)?.children || []) descendants(child.id, groupMap, seen);
    return seen;
  }
  function refId(value) {
    return typeof value === 'string' ? value : value?.id;
  }
  function isCustomGroup(group) {
    return !group.id.startsWith('Group');
  }
  function activeDuring(device, from, to) {
    const start = Date.parse(device.activeFrom);
    const end = Date.parse(device.activeTo);
    return (Number.isNaN(start) || start < to) && (Number.isNaN(end) || end > from);
  }
  function uniqueById(rows) {
    return [...new Map(rows.map((row) => [row.id, row])).values()];
  }
  function pctChange(current, previous) {
    if (current == null || previous == null || previous <= 0) return null;
    return ((current - previous) / previous) * 100;
  }
  function money(amount) {
    return `$${Math.round(amount).toLocaleString('en-US')}`;
  }
  function plural(count, word) {
    return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
  }

  // A status with no position fields at all says nothing, so only an explicit empty or zero position counts.
  function lacksLocation(status) {
    if (status?.latitude === undefined && status?.longitude === undefined) return false;
    return !(Number.isFinite(status.latitude) && Number.isFinite(status.longitude)) || (status.latitude === 0 && status.longitude === 0);
  }
  function latestCameraReadings(readings) {
    const latest = new Map();
    for (const reading of readings || []) {
      const level = Number(reading.data);
      const at = Date.parse(reading.dateTime);
      const deviceId = refId(reading.device);
      if (!deviceId || !Number.isInteger(level) || level < 0 || level > 3 || !Number.isFinite(at)) continue;
      if (!latest.has(deviceId) || at > latest.get(deviceId).at) latest.set(deviceId, { level, at });
    }
    return latest;
  }
  function faultKind(diagnostic) {
    const source = `${refId(diagnostic?.source) || ''} ${diagnostic?.source?.name || ''}`;
    const name = diagnostic?.name || '';
    if (/camera|video/i.test(name)) return 'camera';
    return /geotab|\bgo\b|goDevice/i.test(source) ? 'device' : 'vehicle';
  }
  function faultLevel(fault) {
    const severity = String(fault.severity || '');
    if (fault.redStopLamp === true || /critical|high/i.test(severity) || /high/i.test(String(fault.riskOfBreakdown || ''))) return 'high';
    if (fault.amberWarningLamp === true || fault.malfunctionLamp === true || fault.protectWarningLamp === true || /medium|moderate|warning/i.test(severity)) return 'medium';
    return 'low';
  }
  // A code stays active until its newest record says otherwise, so only the latest record per code counts.
  function activeFaults(faults, diagnostics, deviceNames) {
    const diagnosticMap = diagnostics instanceof Map ? diagnostics : new Map((diagnostics || []).map((d) => [d.id, d]));
    const latest = new Map();
    for (const fault of uniqueById(faults || [])) {
      const deviceId = refId(fault.device);
      const diagnosticId = refId(fault.diagnostic);
      const at = Date.parse(fault.dateTime);
      if (!deviceNames.has(deviceId) || !diagnosticId || !Number.isFinite(at)) continue;
      const key = `${deviceId}|${diagnosticId}|${refId(fault.failureMode) || ''}`;
      const entry = latest.get(key) || { at: -Infinity, occurrences: 0 };
      entry.occurrences += Number.isFinite(fault.count) && fault.count > 0 ? fault.count : 1;
      if (at > entry.at) Object.assign(entry, { at, fault, deviceId, diagnosticId });
      latest.set(key, entry);
    }
    const rows = [];
    for (const { at, fault, deviceId, diagnosticId, occurrences } of latest.values()) {
      if (fault.dismissDateTime && Date.parse(fault.dismissDateTime) >= at && Date.parse(fault.dismissDateTime) > 0 && Date.parse(fault.dismissDateTime) < Date.parse('2050-01-01T00:00:00Z')) continue;
      if (/inactive|cleared/i.test(String(fault.faultState || ''))) continue;
      const diagnostic = diagnosticMap.get(diagnosticId);
      rows.push({
        deviceId,
        vehicle: deviceNames.get(deviceId),
        name: fault.faultDescription || diagnostic?.name || `Fault code ${diagnosticId}`,
        code: diagnostic?.code ?? null,
        kind: faultKind(diagnostic),
        level: faultLevel(fault),
        occurrences,
        at,
        recommendation: fault.recommendation || null,
      });
    }
    return rows.sort((a, b) => SEVERITY_ORDER[a.level] - SEVERITY_ORDER[b.level] || b.at - a.at);
  }

  function orbTone(actions) {
    if (actions.some((a) => a.severity === 'high')) return 'high';
    if (actions.some((a) => a.severity === 'medium')) return 'medium';
    return actions.length ? 'low' : 'clear';
  }
  // Every orb shows a real count from the to-do list; only the motion around it is decoration.
  function buildOrbs({ result, myOpen = 0, teamOpen = 0, full = true }) {
    const mine = { key: 'mine', label: 'My Tasks', value: myOpen, count: myOpen, tone: myOpen ? 'medium' : 'clear', view: { tab: 'mine' } };
    if (!full) return { center: { ...mine, label: 'My Tasks' }, ring: [] };
    const actions = result?.actions || [];
    const of = (test) => actions.filter(test);
    const orb = (key, label, list, view, value) => ({ key, label, value: result ? (value ?? list.length) : '–', count: list.length, tone: orbTone(list), view });
    const health = of((a) => a.category === 'health' && a.type !== 'camera');
    const cameras = of((a) => a.type === 'camera');
    return {
      center: orb('all', 'Open To-Dos', actions, { tab: 'todo', category: 'all' }),
      ring: [
        orb('safety', 'Safety', of((a) => a.category === 'safety'), { tab: 'todo', category: 'safety' }),
        orb('cost', 'Idle Fuel', of((a) => a.category === 'cost'), { tab: 'todo', category: 'cost' }, result ? money(result.fleet.current.idleCost) : undefined),
        orb('usage', 'Vehicle Use', of((a) => a.category === 'usage'), { tab: 'todo', category: 'usage' }),
        orb('faults', 'Vehicle Faults', of((a) => a.category === 'faults'), { tab: 'faults' }),
        orb('health', 'Device Health', health, { tab: 'health', only: 'devices' }),
        orb('cameras', 'Cameras', cameras, { tab: 'health', only: 'cameras' }),
        { ...mine, value: result ? myOpen : '–' },
        { key: 'team', label: 'Delegated', value: result ? teamOpen : '–', count: teamOpen, tone: 'clear', view: { tab: 'team' } },
      ],
    };
  }

  function defaultSafetyRules(rules) {
    return rules.filter((rule) => SAFETY_PATTERN.test(rule.name || ''));
  }

  function tally({ devices, trips, events, range, tz, schedules, ruleIds }) {
    const stats = new Map();
    for (const device of devices) {
      const schedule = schedules.get(device.id);
      const eligible = range.windows.filter((w) => activeDuring(device, w.from, w.to));
      stats.set(device.id, {
        id: device.id,
        name: device.name,
        scheduledDays: eligible.filter((w) => schedule.has(dayOfWeek(w.date))).length,
        workDaysUsed: new Set(),
        offDays: new Set(),
        offMiles: 0,
        miles: 0,
        trips: 0,
        idleHours: 0,
        idleMissing: 0,
        events: 0,
        byRule: new Map(),
        byDriver: new Map(),
      });
    }
    for (const trip of uniqueById(trips)) {
      const start = Date.parse(trip.start);
      const stat = stats.get(refId(trip.device));
      if (!stat || !(start >= range.from && start < range.to)) continue;
      stat.trips++;
      const idle = seconds(trip.idlingDuration);
      if (idle == null) stat.idleMissing++;
      else stat.idleHours += idle / 3600;
      if (!(Number.isFinite(trip.distance) && trip.distance > 0)) continue;
      const miles = trip.distance / KM_PER_MILE;
      const date = localDate(start, tz);
      stat.miles += miles;
      if (schedules.get(stat.id).has(dayOfWeek(date))) stat.workDaysUsed.add(date);
      else {
        stat.offDays.add(date);
        stat.offMiles += miles;
      }
    }
    for (const event of uniqueById(events)) {
      const at = Date.parse(event.activeFrom);
      const stat = stats.get(refId(event.device));
      const ruleId = refId(event.rule);
      if (!stat || !ruleIds.has(ruleId) || !(at >= range.from && at < range.to)) continue;
      if (event.state && event.state !== 'ExceptionEventStateValidId') continue;
      stat.events++;
      stat.byRule.set(ruleId, (stat.byRule.get(ruleId) || 0) + 1);
      const driverId = refId(event.driver);
      if (driverId && !NO_DRIVER.has(driverId)) stat.byDriver.set(driverId, (stat.byDriver.get(driverId) || 0) + 1);
    }
    return stats;
  }

  function rollup(stats, ids, settings) {
    const rows = ids.map((id) => stats.get(id)).filter(Boolean);
    const sum = (read) => rows.reduce((total, row) => total + read(row), 0);
    const scheduledDays = sum((r) => r.scheduledDays);
    const activeDays = sum((r) => r.workDaysUsed.size);
    const miles = sum((r) => r.miles);
    const idleHours = sum((r) => r.idleHours);
    const events = sum((r) => r.events);
    return {
      vehicles: rows.length,
      scheduledDays,
      activeDays,
      miles,
      idleHours,
      idleMissing: sum((r) => r.idleMissing),
      idleCost: idleHours * settings.idleGallonsPerHour * settings.fuelPrice,
      events,
      utilization: scheduledDays ? (activeDays / scheduledDays) * 100 : null,
      safetyRate: miles > 0 ? (events / miles) * 1000 : null,
    };
  }

  function topEntry(counts) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  }

  function vehicleEvidence(stat, settings) {
    return {
      id: stat.id,
      name: stat.name,
      miles: stat.miles,
      workDaysUsed: stat.workDaysUsed.size,
      scheduledDays: stat.scheduledDays,
      idleHours: stat.idleHours,
      idleCost: stat.idleHours * settings.idleGallonsPerHour * settings.fuelPrice,
      events: stat.events,
    };
  }

  function buildActions({ current, prior, rows, devices, statuses, ruleNames, driverNames, settings, range, now, safetyAvailable, statusAvailable, faultRows, cameras }) {
    const actions = [];
    const groupsFor = (deviceId) => rows.filter((row) => row.ids.includes(deviceId)).map((row) => row.id);
    const periodScale = range.days / 7;
    const statusByDevice = new Map((statuses || []).map((s) => [refId(s.device), s]));
    const offline = new Set();

    if (statusAvailable) {
      for (const device of devices) {
        const status = statusByDevice.get(device.id);
        const last = Date.parse(status?.dateTime);
        if (!Number.isFinite(last)) continue;
        const silentDays = Math.floor((now - last) / DAY);
        const hadRecentUse = current.get(device.id).trips + prior.get(device.id).trips > 0;
        if (silentDays < settings.offlineDays && lacksLocation(status)) {
          actions.push({
            key: `notlocating:${device.id}`,
            type: 'notlocating',
            category: 'health',
            severity: 'medium',
            title: `${device.name} is reporting but has no location`,
            why: 'The GO device is sending data without a usable GPS position, so the vehicle cannot be found on the map.',
            next: 'Check the GO device install and that nothing is blocking its view of the sky.',
            amount: null,
            groupIds: groupsFor(device.id),
            vehicles: [vehicleEvidence(current.get(device.id), settings)],
          });
        }
        if (silentDays < settings.offlineDays || !hadRecentUse) continue;
        offline.add(device.id);
        actions.push({
          key: `offline:${device.id}`,
          type: 'offline',
          category: 'health',
          severity: silentDays >= 7 ? 'high' : 'medium',
          title: `${device.name} has not reported in ${plural(silentDays, 'day')}`,
          why: 'It was on the road recently and has since gone quiet, so anything it does now is invisible to you.',
          next: 'Check whether the truck is in the shop, then whether the GO device is still plugged in.',
          amount: null,
          groupIds: groupsFor(device.id),
          vehicles: [vehicleEvidence(current.get(device.id), settings)],
        });
      }
    }

    for (const device of devices) {
      const reading = cameras.get(device.id);
      if (!reading || reading.level === 0 || reading.level < settings.cameraMinLevel) continue;
      actions.push({
        key: `camera:${device.id}`,
        type: 'camera',
        category: 'health',
        severity: reading.level === 3 ? 'high' : reading.level === 2 ? 'medium' : 'low',
        title: `${device.name}: camera ${CAMERA_LEVELS[reading.level].toLowerCase()}`,
        why: `Geotab's camera health reading since ${new Date(reading.at).toISOString().slice(0, 10)}. Video may be missing when you need it.`,
        next: 'Reset the camera and check the SD card and lens. Contact support if it stays this way.',
        amount: null,
        groupIds: groupsFor(device.id),
        vehicles: [vehicleEvidence(current.get(device.id), settings)],
      });
    }

    const byVehicle = new Map();
    for (const fault of faultRows) {
      const bucket = fault.kind === 'vehicle' ? 'vehicle' : 'device';
      const key = `${bucket}|${fault.deviceId}`;
      if (!byVehicle.has(key)) byVehicle.set(key, { bucket, deviceId: fault.deviceId, items: [] });
      byVehicle.get(key).items.push(fault);
    }
    for (const { bucket, deviceId, items } of byVehicle.values()) {
      const worst = items[0].level;
      if (bucket === 'vehicle' && worst === 'low' && !settings.faultIncludeLow) continue;
      const names = items.slice(0, 3).map((f) => f.name).join('; ');
      const more = items.length > 3 ? ` and ${items.length - 3} more` : '';
      const stat = current.get(deviceId);
      actions.push(bucket === 'vehicle' ? {
        key: `fault:${deviceId}`,
        type: 'fault',
        category: 'faults',
        severity: worst,
        title: `${stat.name}: ${plural(items.length, 'active fault code')}`,
        why: `${names}${more}.`,
        next: worst === 'high' ? 'Have it looked at before it goes back out.' : items[0].recommendation || 'Book it in and have a technician read the codes.',
        amount: null,
        faults: items,
        groupIds: groupsFor(deviceId),
        vehicles: [vehicleEvidence(stat, settings)],
      } : {
        key: `devicefault:${deviceId}`,
        type: 'devicefault',
        category: 'health',
        severity: items.some((f) => f.level === 'high') ? 'high' : 'medium',
        title: `${stat.name}: ${plural(items.length, 'device fault')}`,
        why: `${names}${more}.`,
        next: 'Check the GO device or camera connection and whether it has been unplugged.',
        amount: null,
        faults: items,
        groupIds: groupsFor(deviceId),
        vehicles: [vehicleEvidence(stat, settings)],
      });
    }

    if (safetyAvailable) {
      for (const stat of current.values()) {
        if (stat.events < settings.safetyMinEvents || stat.miles <= 0) continue;
        const rate = (stat.events / stat.miles) * 1000;
        const previous = prior.get(stat.id);
        const previousRate = previous.miles > 0 ? (previous.events / previous.miles) * 1000 : null;
        const rise = pctChange(rate, previousRate);
        const overRate = rate >= settings.safetyRatePer1000;
        const risingFast = rise != null && rise >= settings.safetyRisePct;
        if (!overRate && !risingFast) continue;
        const topRule = topEntry(stat.byRule);
        const topDriver = topEntry(stat.byDriver);
        const driverName = topDriver && driverNames.get(topDriver[0]);
        actions.push({
          key: `safety:${stat.id}`,
          type: 'safety',
          category: 'safety',
          severity: rate >= settings.safetyRatePer1000 * 2 ? 'high' : 'medium',
          title: `${stat.name}: ${plural(stat.events, 'safety event')}${rise != null && rise > 0 ? `, up ${Math.round(rise)}%` : ''}`,
          why: `${rate.toFixed(1)} events per 1,000 miles${topRule ? `. Most common: ${ruleNames.get(topRule[0]) || 'unnamed rule'} (${topRule[1]})` : ''}${driverName ? `. Mostly ${driverName} (${topDriver[1]})` : ''}.`,
          next: driverName ? `Review the events and coach ${driverName}.` : 'Review the events and find out who was driving. No driver is assigned to most of them.',
          amount: null,
          groupIds: groupsFor(stat.id),
          vehicles: [vehicleEvidence(stat, settings)],
        });
      }
    }

    for (const row of rows) {
      const minimum = settings.idleMinDollarsPerWeek * periodScale;
      const perDay = row.current.scheduledDays ? row.current.idleHours / row.current.scheduledDays : 0;
      const rise = pctChange(row.current.idleHours, row.prior.idleHours);
      const rising = rise != null && rise >= settings.idleRisePct;
      if (row.current.idleCost < minimum || (!rising && perDay < settings.idleHoursPerDay)) continue;
      const worst = row.ids.map((id) => current.get(id)).sort((a, b) => b.idleHours - a.idleHours).slice(0, 3);
      const worstShare = row.current.idleHours ? (worst.reduce((n, s) => n + s.idleHours, 0) / row.current.idleHours) * 100 : 0;
      const costLabel = money(row.current.idleCost);
      actions.push({
        key: `idle:${row.id}`,
        type: 'idle',
        category: 'cost',
        severity: rising && row.current.idleCost >= minimum * 4 ? 'high' : 'medium',
        title: rising ? `${row.name}: idle time up ${Math.round(rise)}%, about ${costLabel} in fuel` : `${row.name}: about ${costLabel} in idle fuel`,
        why: `${row.current.idleHours.toFixed(1)} idle hours over ${plural(range.days, 'day')}. ${plural(worst.length, 'truck')} make up ${Math.round(worstShare)}% of it.`,
        next: `Start with ${worst[0].name} and ask the crew lead what is keeping the engine running.`,
        amount: row.current.idleCost,
        estimated: true,
        partial: row.current.idleMissing > 0,
        groupIds: [row.id],
        vehicles: worst.map((s) => vehicleEvidence(s, settings)),
      });
    }

    for (const stat of current.values()) {
      if (offline.has(stat.id)) continue;
      if (stat.offDays.size && stat.offMiles >= settings.offScheduleMinMiles) {
        actions.push({
          key: `offschedule:${stat.id}`,
          type: 'offschedule',
          category: 'usage',
          severity: 'medium',
          title: `${stat.name} drove ${Math.round(stat.offMiles).toLocaleString('en-US')} miles on ${plural(stat.offDays.size, 'non-work day')}`,
          why: `Dates: ${[...stat.offDays].sort().join(', ')}. Your work schedule says this truck should be parked.`,
          next: 'Open the trips and confirm whether this was approved work or personal use.',
          amount: null,
          groupIds: groupsFor(stat.id),
          vehicles: [vehicleEvidence(stat, settings)],
        });
      }
      if (stat.scheduledDays >= settings.unusedMinWorkdays && stat.workDaysUsed.size === 0 && stat.offDays.size === 0) {
        const carrying = settings.vehicleMonthlyCost > 0 ? (settings.vehicleMonthlyCost * range.days) / 30 : null;
        actions.push({
          key: `unused:${stat.id}`,
          type: 'unused',
          category: 'usage',
          severity: 'low',
          title: `${stat.name} sat unused for all ${plural(stat.scheduledDays, 'work day')}`,
          why: 'It is reporting normally but recorded no driving. It may be spare, in the shop or no longer needed.',
          next: 'Confirm why it is parked, then reassign it or take it out of the fleet.',
          amount: carrying,
          estimated: carrying != null,
          groupIds: groupsFor(stat.id),
          vehicles: [vehicleEvidence(stat, settings)],
        });
      }
    }

    return actions.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.amount || 0) - (a.amount || 0) || a.title.localeCompare(b.title));
  }

  function analyze({ groups, devices, trips, events, statuses, rules, drivers, range, settings, filter = [], handled = {}, now = Date.now(), tz, safetyAvailable = true, statusAvailable = true, faults = [], diagnostics = [], cameraReadings = [], faultsAvailable = true, camerasAvailable = true }) {
    const groupMap = new Map(groups.map((g) => [g.id, g]));
    const allowed = new Set();
    for (const id of filter) descendants(id, groupMap, allowed);

    // Asset-type groups are not populated in every database, so only narrow to vehicles where they are.
    const usesVehicleGroup = devices.some((d) => memberships(d).includes('GroupVehicleId'));
    const inScope = devices.filter((d) => {
      const ids = memberships(d);
      if (usesVehicleGroup && !ids.includes('GroupVehicleId')) return false;
      if (!activeDuring(d, range.prior.from, range.current.to)) return false;
      return !allowed.size || ids.some((id) => allowed.has(id));
    });

    const overrides = Object.entries(settings.groupSchedules || {}).filter(([id, days]) => groupMap.has(id) && Array.isArray(days));
    const overrideSets = overrides.map(([id, days]) => ({ members: descendants(id, groupMap), days }));
    const schedules = new Map(inScope.map((device) => {
      const ids = memberships(device);
      const matches = overrideSets.filter((o) => ids.some((id) => o.members.has(id)));
      return [device.id, new Set(matches.length ? matches.flatMap((o) => o.days) : settings.workDays)];
    }));

    const safetyRules = settings.safetyRuleIds.length ? rules.filter((r) => settings.safetyRuleIds.includes(r.id)) : defaultSafetyRules(rules);
    const ruleIds = new Set(safetyRules.map((r) => r.id));
    const ruleNames = new Map(rules.map((r) => [r.id, r.name]));
    const driverNames = new Map((drivers || []).map((d) => [d.id, [d.firstName, d.lastName].filter(Boolean).join(' ') || d.name]));

    const base = { devices: inScope, trips, events: safetyAvailable ? events : [], tz, schedules, ruleIds };
    const current = tally({ ...base, range: range.current });
    const prior = tally({ ...base, range: range.prior });

    const membersOf = (groupId) => {
      const members = descendants(groupId, groupMap);
      return inScope.filter((d) => memberships(d).some((id) => members.has(id))).map((d) => d.id);
    };
    const candidates = groups.filter(isCustomGroup).map((g) => ({ group: g, ids: membersOf(g.id) })).filter((c) => c.ids.length);
    const chosen = settings.reportGroupIds.length
      ? candidates.filter((c) => settings.reportGroupIds.includes(c.group.id))
      : candidates.filter((c) => !(c.group.children || []).some((child) => membersOf(child.id).length));

    const makeRow = (id, name, ids) => ({ id, name, ids, current: rollup(current, ids, settings), prior: rollup(prior, ids, settings) });
    const rows = chosen.map((c) => makeRow(c.group.id, c.group.name, c.ids));
    const covered = new Set(rows.flatMap((row) => row.ids));
    const uncovered = inScope.map((d) => d.id).filter((id) => !covered.has(id));
    if (uncovered.length) rows.push(makeRow('__other', rows.length ? 'Other vehicles' : 'All vehicles', uncovered));
    rows.sort((a, b) => b.current.idleCost - a.current.idleCost || a.name.localeCompare(b.name));

    const deviceNames = new Map(inScope.map((d) => [d.id, d.name]));
    const faultRows = faultsAvailable ? activeFaults(faults, diagnostics, deviceNames) : [];
    const allCameras = camerasAvailable ? latestCameraReadings(cameraReadings) : new Map();
    const cameras = new Map([...allCameras].filter(([id]) => deviceNames.has(id)));

    const allActions = buildActions({ current, prior, rows, devices: inScope, statuses, ruleNames, driverNames, settings, range, now, safetyAvailable, statusAvailable, faultRows, cameras });
    const actions = allActions.filter((a) => !(handled[a.key] > now));

    const allIds = inScope.map((d) => d.id);
    const fleet = { current: rollup(current, allIds, settings), prior: rollup(prior, allIds, settings) };
    const countType = (type) => allActions.filter((a) => a.type === type).length;
    const cameraLevels = [0, 1, 2, 3].map((level) => [...cameras.values()].filter((c) => c.level === level).length);
    const vehicleFaults = faultRows.filter((f) => f.kind === 'vehicle');
    return {
      fleet,
      rows,
      actions,
      health: {
        statusAvailable,
        camerasAvailable,
        devices: { total: inScope.length, offline: countType('offline'), notLocating: countType('notlocating'), deviceFaults: countType('devicefault') },
        cameras: { total: cameras.size, levels: cameraLevels },
      },
      faults: {
        available: faultsAvailable,
        rows: vehicleFaults,
        vehicles: new Set(vehicleFaults.map((f) => f.deviceId)).size,
        high: vehicleFaults.filter((f) => f.level === 'high').length,
        medium: vehicleFaults.filter((f) => f.level === 'medium').length,
        low: vehicleFaults.filter((f) => f.level === 'low').length,
      },
      handledCount: allActions.length - actions.length,
      candidates: candidates.map((c) => ({ id: c.group.id, name: c.group.name })).sort((a, b) => a.name.localeCompare(b.name)),
      safetyRules,
      overlapping: rows.reduce((n, row) => n + row.ids.length, 0) > new Set(rows.flatMap((row) => row.ids)).size,
    };
  }

  async function completeWindow(get, typeName, from, to, fields, limit = 5000, depth = 0) {
    const rows = await get(typeName, { fromDate: new Date(from).toISOString(), toDate: new Date(to).toISOString() }, fields, limit);
    if (!Array.isArray(rows)) throw new Error(`${typeName} returned an unexpected response.`);
    if (rows.length < limit) return rows;
    if (depth >= 12 || to - from <= 60000) throw new Error(`${typeName} reached the data limit. Choose a shorter period.`);
    const middle = Math.floor((from + to) / 2);
    const left = await completeWindow(get, typeName, from, middle, fields, limit, depth + 1);
    const right = await completeWindow(get, typeName, middle, to, fields, limit, depth + 1);
    return uniqueById([...left, ...right]);
  }

  async function mapBounded(items, work, concurrency = 3) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index], index);
      }
    }));
    return out;
  }

  // Leading formula characters are neutralized so a vehicle name cannot run as a spreadsheet formula.
  function toCsv(rows) {
    return rows.map((row) => row.map((cell) => {
      let text = cell == null ? '' : String(cell);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(',')).join('\r\n');
  }

  const core = { orbTone, buildOrbs, CAMERA_HEALTH_DIAGNOSTIC, CAMERA_LEVELS, faultKind, faultLevel, activeFaults, latestCameraReadings, lacksLocation, LEVEL_NAMES, SYSTEM_CLEARANCES, clearanceLevel, userLevel, userName, seesFullList, userCoversDevices, delegates, handledFromTasks, DEFAULTS, mergeSettings, localDate, shiftDate, dayOfWeek, midnight, period, seconds, memberships, descendants, pctChange, money, plural, defaultSafetyRules, analyze, completeWindow, mapBounded, toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else scope.FleetWolfActionCore = core;
})(typeof window === 'undefined' ? globalThis : window);
