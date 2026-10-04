/** Club opening windows, in Dutch wall time. Midnight belongs to the previous day. */
const fs = require('node:fs');
const path = require('node:path');
const CACHE = path.join(__dirname, '..', 'data', 'twelve-schedule.json');
const defaults = { timezone: 'Europe/Amsterdam', interval_hours: 2, days: [0, 2, 3, 4, 5, 6].map(day => ({ day, start: [0, 6].includes(day) ? 10 : 20, end: 24 })) };
function validate(schedule) {
  if (schedule?.timezone !== 'Europe/Amsterdam' || schedule.interval_hours !== 2 || !Array.isArray(schedule.days) || schedule.days.length > 7) throw new Error('Invalid Twelve schedule');
  const seen = new Set();
  for (const window of schedule.days) {
    if (!window || ![window.day, window.start, window.end].every(Number.isInteger) || window.day < 0 || window.day > 6 || seen.has(window.day) || window.start < 0 || window.start > 23 || window.end <= window.start || window.end > 24) throw new Error('Invalid Twelve opening window');
    seen.add(window.day);
  }
  return schedule;
}
function components(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`).getUTCDay(), hour: Number(parts.hour) };
}
function isDue(schedule, now = new Date()) {
  validate(schedule);
  const { day, hour } = components(now);
  return schedule.days.some(w => (w.day === day && hour >= w.start && hour <= w.end && (hour === w.end || (hour - w.start) % 2 === 0)) || (hour === 0 && w.day === (day + 6) % 7 && w.end === 24));
}
function cachedSchedule() {
  return fs.existsSync(CACHE) ? validate(JSON.parse(fs.readFileSync(CACHE, 'utf8'))) : defaults;
}
async function refreshSchedule(request) {
  const schedule = validate((await request('rondo/v1/twelve/schedule', 'GET')).body);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${CACHE}.tmp`, JSON.stringify(schedule), { mode: 0o600 });
  fs.renameSync(`${CACHE}.tmp`, CACHE);
  return schedule;
}
function scheduledRun(schedule, now, direction) {
  validate(schedule);
  if (!schedule.days.length) return null;
  const time = new Date(Math.floor(now.getTime() / 3600000) * 3600000 + (direction > 0 ? 3600000 : 0));
  for (let i = 0; i < 8 * 24 + 2; i++, time.setTime(time.getTime() + direction * 3600000)) {
    if (isDue(schedule, time)) return new Date(time);
  }
  throw new Error('No Twelve time found');
}
const nextRun = (schedule, now = new Date()) => scheduledRun(schedule, now, 1);
const previousRun = (schedule, now = new Date()) => scheduledRun(schedule, now, -1);
function staleAfterHours(schedule, now = new Date()) {
  // Allow each scheduled run three hours to start before flagging it as missed.
  const time = previousRun(schedule, new Date(now.getTime() - 3 * 3600000));
  return time ? Math.ceil((now - time) / 3600000) + 1 : 0;
}
module.exports = { defaults, validate, isDue, cachedSchedule, refreshSchedule, nextRun, previousRun, staleAfterHours };
if (require.main === module) console.log(staleAfterHours(cachedSchedule()));
