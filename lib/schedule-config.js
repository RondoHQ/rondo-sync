'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PIPELINES = {
  people: { name: 'People', args: ['people'], cadence: 'daily', times: ['08:00', '11:00', '14:00', '17:00'] },
  functions: { name: 'Member roles + VOG', args: ['functions'], cadence: 'daily', times: ['07:30', '10:30', '13:30', '16:30'] },
  'functions-full': { name: 'Member roles (full)', args: ['functions', '--all', '--with-invoice'], cadence: 'weekly', times: ['01:00'], dayOfWeek: 0 },
  freescout: { name: 'FreeScout', args: ['freescout'], cadence: 'daily', times: ['08:00'] },
  'freescout-conversations': { name: 'FreeScout conversations', args: ['conversations'], cadence: 'daily', times: ['09:00'] },
  teams: { name: 'Teams', args: ['teams'], cadence: 'weekly', times: ['06:00'], dayOfWeek: 0 },
  sponsit: { name: 'Sponsit', args: ['sponsit'], cadence: 'weekly', times: ['10:00'], dayOfWeek: 0 },
  'player-history': { name: 'Player history', args: ['player-history'], cadence: 'monthly', times: ['03:00'], dayOfMonth: 1 },
  discipline: { name: 'Discipline', args: ['discipline'], cadence: 'weekly', times: ['23:30'], dayOfWeek: 1 },
  reverse: { name: 'Reverse sync', args: ['reverse'], cadence: 'interval', intervalMinutes: 5 }
};
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'sync-schedules.json');

function defaultSchedules() {
  return Object.fromEntries(Object.entries(PIPELINES).map(([id, { name, args, ...schedule }]) => [id, { enabled: true, ...structuredClone(schedule) }]));
}

function validateSchedules(schedules) {
  if (!schedules || typeof schedules !== 'object' || Array.isArray(schedules) ||
      Object.keys(schedules).length !== Object.keys(PIPELINES).length || Object.keys(schedules).some(id => !Object.hasOwn(PIPELINES, id))) {
    throw new Error('Provide a schedule for every known pipeline.');
  }
  const validated = {};
  for (const id of Object.keys(PIPELINES)) {
    const value = schedules[id];
    const fail = message => { throw new Error(`${PIPELINES[id].name}: ${message}`); };
    if (!value || typeof value.enabled !== 'boolean') fail('choose whether the schedule is enabled.');
    if (!['daily', 'weekly', 'monthly', 'interval'].includes(value.cadence)) fail('choose a valid frequency.');
    const allowed = ['enabled', 'cadence', 'changedAt', ...(value.cadence === 'interval' ? ['intervalMinutes'] : ['times']),
      ...(value.cadence === 'weekly' ? ['dayOfWeek'] : []), ...(value.cadence === 'monthly' ? ['dayOfMonth'] : [])];
    if (Object.keys(value).some(key => !allowed.includes(key))) fail('unexpected schedule setting.');
    const schedule = { enabled: value.enabled, cadence: value.cadence };
    if (value.changedAt !== undefined) {
      if (typeof value.changedAt !== 'string' || !Number.isFinite(Date.parse(value.changedAt))) fail('invalid change timestamp.');
      schedule.changedAt = value.changedAt;
    }
    if (value.cadence === 'interval') {
      // Whole-hour divisors keep intervals equally spaced across midnight.
      if (![1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60].includes(value.intervalMinutes)) fail('choose an interval between 1 and 60 minutes that divides an hour.');
      schedule.intervalMinutes = value.intervalMinutes;
    } else {
      if (!Array.isArray(value.times) || value.times.length < 1 || value.times.length > 24 ||
          value.times.some(time => typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) fail('enter 1 to 24 times in HH:mm format.');
      if (new Set(value.times).size !== value.times.length) fail('remove duplicate times.');
      schedule.times = [...value.times].sort();
      if (value.cadence === 'weekly') {
        if (!Number.isInteger(value.dayOfWeek) || value.dayOfWeek < 0 || value.dayOfWeek > 6) fail('choose a weekday.');
        schedule.dayOfWeek = value.dayOfWeek;
      }
      if (value.cadence === 'monthly') {
        if (!Number.isInteger(value.dayOfMonth) || value.dayOfMonth < 1 || value.dayOfMonth > 31) fail('choose a day between 1 and 31.');
        schedule.dayOfMonth = value.dayOfMonth;
      }
    }
    validated[id] = schedule;
  }
  return validated;
}

function revision(schedules) {
  return crypto.createHash('sha256').update(JSON.stringify(schedules)).digest('hex');
}

function loadConfig(file = CONFIG_FILE) {
  let schedules;
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (document.version !== 1) throw new Error('Unsupported schedule configuration version.');
    schedules = validateSchedules(document.schedules);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error; // Fail closed on corrupt config.
    schedules = defaultSchedules();
  }
  return { schedules, revision: revision(schedules) };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function saveConfig(schedules, expectedRevision, file = CONFIG_FILE, now = new Date()) {
  const validated = validateSchedules(schedules);
  const current = loadConfig(file);
  if (expectedRevision !== current.revision) {
    const error = new Error('Schedules changed in another session. Reload this page before saving.');
    error.statusCode = 409;
    throw error;
  }
  for (const [id, schedule] of Object.entries(validated)) {
    const { changedAt: previousChange, ...previous } = current.schedules[id];
    const { changedAt, ...updated } = schedule;
    if (JSON.stringify(previous) !== JSON.stringify(updated)) schedule.changedAt = now.toISOString();
    else if (previousChange) schedule.changedAt = previousChange;
    else delete schedule.changedAt;
  }
  // Synchronous I/O keeps the revision check and rename together in the web process.
  atomicWrite(file, { version: 1, schedules: validated });
  return loadConfig(file);
}

module.exports = { PIPELINES, CONFIG_FILE, defaultSchedules, validateSchedules, loadConfig, saveConfig, atomicWrite };
