'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PIPELINES, CONFIG_FILE, defaultSchedules, validateSchedules, loadConfig, atomicWrite } = require('../lib/schedule-config');
const PROJECT = path.join(__dirname, '..');

function numbers(value, max) {
  const result = value.split(',').map(Number);
  if (!/^\d+(,\d+)*$/.test(value) || result.some(number => number < 0 || number > max)) throw new Error(`Cannot migrate cron field: ${value}`);
  return result;
}

function cronSchedule(fields) {
  const [minute, hour, day, month, weekday] = fields;
  if (month !== '*') throw new Error('Month-specific cron entries require a manual migration.');
  if (/^\*\/(\d+)$/.test(minute) && hour === '*' && day === '*' && weekday === '*') {
    return { enabled: true, cadence: 'interval', intervalMinutes: Number(minute.slice(2)) };
  }
  if (!/^\d+(,\d+)*$/.test(minute) || !/^\d+(,\d+)*$/.test(hour)) throw new Error('Unsupported time expression; existing crontab was not changed.');
  const times = numbers(hour, 23).flatMap(h => numbers(minute, 59).map(m => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`));
  if (day === '*' && weekday === '*') return { enabled: true, cadence: 'daily', times };
  if (day === '*' && /^[0-6]$/.test(weekday)) return { enabled: true, cadence: 'weekly', times, dayOfWeek: Number(weekday) };
  if (/^\d+$/.test(day) && weekday === '*') return { enabled: true, cadence: 'monthly', times, dayOfMonth: Number(day) };
  throw new Error('Unsupported cron calendar; existing crontab was not changed.');
}

/** Remove only this checkout's exact pipeline entries, retaining unrelated jobs. */
function migrateCrontab(text, project = PROJECT) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(project)) throw new Error('Project path must be an absolute path without shell metacharacters.');
  const schedules = defaultSchedules();
  const seen = new Set();
  let twelve = false;
  let existingDispatcher = false;
  const keep = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '# Rondo Sync editable schedules (Beheer -> Sync schedules)') continue;
    if (!trimmed || trimmed.startsWith('#')) { keep.push(line); continue; }
    const fields = trimmed.split(/\s+/);
    const command = fields[5];
    if (command === `${project}/scripts/scheduler-tick.sh`) { existingDispatcher = true; continue; }
    if (command !== `${project}/scripts/sync.sh`) { keep.push(line); continue; }
    const args = fields.slice(6);
    if (args.join(' ') === 'twelve --scheduled') {
      if (fields.slice(0, 5).join(' ') !== '0 * * * *') throw new Error('Unexpected Twelve check cadence; crontab was not changed.');
      if (twelve) throw new Error('Duplicate Twelve schedule; crontab was not changed.');
      twelve = true;
      continue;
    }
    const id = Object.keys(PIPELINES).find(key => PIPELINES[key].args.join(' ') === args.join(' '));
    if (!id) throw new Error(`Unrecognized sync command: ${args.join(' ')}. Crontab was not changed.`);
    if (seen.has(id)) throw new Error(`Duplicate ${id} schedule; crontab was not changed.`);
    seen.add(id);
    schedules[id] = cronSchedule(fields.slice(0, 5));
  }
  // Absence from an existing install means deliberately unscheduled.
  if (seen.size) for (const id of Object.keys(PIPELINES)) if (!seen.has(id)) schedules[id].enabled = false;
  const validated = validateSchedules(schedules);
  const entries = [
    '# Rondo Sync editable schedules (Beheer -> Sync schedules)',
    `* * * * * ${project}/scripts/scheduler-tick.sh >> ${project}/logs/cron/scheduler.log 2>&1`,
    ...(twelve || (!seen.size && !existingDispatcher) ? [`0 * * * * ${project}/scripts/sync.sh twelve --scheduled`] : [])
  ];
  return { schedules: validated, crontab: keep.join('\n').trimEnd() + '\n\n' + entries.join('\n') + '\n' };
}

function install() {
  require('../lib/server-check').requireProductionServer({ scriptName: 'Schedule cron installer' });
  if (process.getuid() === 0) throw new Error('Run this installer as rondo, never as root.');
  let previous = '';
  try { previous = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { if (!String(error.stderr).includes('no crontab')) throw error; }
  const migration = migrateCrontab(previous);
  if (fs.existsSync(CONFIG_FILE)) loadConfig(); // Validate without overwriting UI edits.
  else atomicWrite(CONFIG_FILE, { version: 1, schedules: migration.schedules });
  const backup = path.join(PROJECT, 'data', `crontab-before-schedules-${Date.now()}.txt`);
  fs.writeFileSync(backup, previous, { mode: 0o600, flag: 'wx' });
  fs.mkdirSync(path.join(PROJECT, 'logs', 'cron'), { recursive: true });
  execFileSync('crontab', ['-'], { input: migration.crontab });
  console.log(`Editable schedules installed. Previous crontab retained at ${backup}.`);
}

module.exports = { migrateCrontab };
if (require.main === module) install();
