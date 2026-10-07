'use strict';

const { loadConfig, defaultSchedules } = require('./schedule-config');
const TIMEZONE = 'Europe/Amsterdam';
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function components(date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    dayOfWeek: new Date(`${dateKey}T12:00:00Z`).getUTCDay(), hour: Number(parts.hour), minute: Number(parts.minute),
    dateKey, timeKey: `${parts.hour}:${parts.minute}` };
}

function label(schedule) {
  if (!schedule.enabled) return 'Disabled';
  if (schedule.cadence === 'interval') return `Every ${schedule.intervalMinutes} minute${schedule.intervalMinutes === 1 ? '' : 's'}`;
  if (schedule.cadence === 'weekly') return `Weekly (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][schedule.dayOfWeek]})`;
  if (schedule.cadence === 'monthly') return `Monthly (day ${schedule.dayOfMonth})`;
  return schedule.times.length === 1 ? 'Daily' : `${schedule.times.length}x daily`;
}

// Fixed schedules run once at the first occurrence of an autumn wall time;
// nonexistent spring times are skipped. Interval schedules use elapsed minutes.
function wallDate(dateKey, timeKey) {
  for (const offset of ['+02:00', '+01:00']) {
    const date = new Date(`${dateKey}T${timeKey}:00${offset}`);
    const actual = components(date);
    if (actual.dateKey === dateKey && actual.timeKey === timeKey) return date;
  }
  return null;
}

function matchesDay(schedule, local) {
  return schedule.cadence === 'daily' ||
    (schedule.cadence === 'weekly' && local.dayOfWeek === schedule.dayOfWeek) ||
    (schedule.cadence === 'monthly' && local.day === schedule.dayOfMonth);
}

function scheduledRun(schedule, now, direction) {
  if (!schedule?.enabled) return null;
  if (schedule.cadence === 'interval') {
    const interval = schedule.intervalMinutes * 60000;
    const time = direction > 0 ? Math.floor(now.getTime() / interval) * interval + interval : Math.floor(now.getTime() / interval) * interval;
    return { time: new Date(time), label: label(schedule) };
  }
  const local = components(now);
  const calendar = new Date(`${local.dateKey}T12:00:00Z`);
  // Day 31 may be absent in a month. 63 days covers the next valid month.
  for (let days = 0; days <= 63; days++, calendar.setUTCDate(calendar.getUTCDate() + direction)) {
    const day = components(calendar);
    if (!matchesDay(schedule, day)) continue;
    const times = direction > 0 ? schedule.times : [...schedule.times].reverse();
    for (const timeKey of times) {
      const time = wallDate(day.dateKey, timeKey);
      if (time && (direction > 0 ? time > now : time <= now)) return { time, label: label(schedule) };
    }
  }
  throw new Error('No scheduled run found.');
}

function getRun(id, now, direction, schedules) {
  if (id === 'twelve') {
    const twelve = require('./twelve-schedule');
    const time = (direction > 0 ? twelve.nextRun : twelve.previousRun)(twelve.cachedSchedule(), now);
    return time ? { time, label: 'Club opening hours' } : null;
  }
  const schedule = (schedules || loadConfig().schedules)[id];
  const run = scheduledRun(schedule, now, direction);
  return direction < 0 && run && schedule.changedAt && run.time < new Date(schedule.changedAt) ? null : run;
}

function getNextRun(id, now = new Date(), schedules) { return getRun(id, now, 1, schedules); }
function getPreviousScheduledRun(id, now = new Date(), schedules) { return getRun(id, now, -1, schedules); }

function isDue(schedule, now = new Date()) {
  if (!schedule?.enabled) return false;
  const minute = Math.floor(now.getTime() / 60000) * 60000;
  if (schedule.changedAt && new Date(schedule.changedAt).getTime() > minute) return false;
  if (schedule.cadence === 'interval') return minute / 60000 % schedule.intervalMinutes === 0;
  const local = components(now);
  if (!matchesDay(schedule, local) || !schedule.times.includes(local.timeKey)) return false;
  return wallDate(local.dateKey, local.timeKey).getTime() === minute;
}

function staleAfterHours(id, now = new Date(), schedules) {
  if (id === 'twelve') {
    const twelve = require('./twelve-schedule');
    return twelve.staleAfterHours(twelve.cachedSchedule(), now);
  }
  const schedule = (schedules || loadConfig().schedules)[id];
  if (!schedule?.enabled) return 0;
  if (schedule.cadence === 'interval') return Math.max(1, schedule.intervalMinutes / 30);
  if (schedule.cadence === 'weekly') return 180;
  if (schedule.cadence === 'monthly') return (schedule.dayOfMonth > 28 ? 63 * 24 : 33 * 24) + 8;
  const minutes = schedule.times.map(time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3)));
  const gaps = minutes.map((minute, index) => (minutes[(index + 1) % minutes.length] + (index === minutes.length - 1 ? 1440 : 0) - minute) / 60);
  return Math.max(30, Math.ceil(Math.max(...gaps) + 6));
}

// Compatibility export of defaults; execution and predictions load persisted settings.
const PIPELINE_SCHEDULES = Object.fromEntries(Object.entries(defaultSchedules()).filter(([, schedule]) => schedule.cadence !== 'interval').map(([id, schedule]) => [id, {
  times: schedule.times.map(time => ({ hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)) })),
  ...(schedule.cadence === 'monthly' ? { dayOfMonth: schedule.dayOfMonth } : { dayOfWeek: schedule.cadence === 'weekly' ? schedule.dayOfWeek : null }),
  label: label(schedule)
}]));
PIPELINE_SCHEDULES['player-history'].label = 'Monthly (1st)';
PIPELINE_SCHEDULES.twelve = { times: [], dayOfWeek: null, label: 'Club opening hours' };

module.exports = { getNextRun, getPreviousScheduledRun, PIPELINE_SCHEDULES, components, label, isDue, scheduledRun, staleAfterHours };
if (require.main === module) {
  const [operation, id] = process.argv.slice(2);
  if (operation === 'stale') console.log(staleAfterHours(id));
  else if (operation === 'enabled') console.log(id === 'twelve' ? 'true' : String(loadConfig().schedules[id]?.enabled === true));
  else throw new Error('Usage: schedule.js stale|enabled <pipeline>');
}
