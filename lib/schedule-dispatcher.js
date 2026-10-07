'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { PIPELINES, loadConfig, atomicWrite } = require('./schedule-config');
const { isDue } = require('./schedule');
const PROJECT = path.join(__dirname, '..');
const STATE_FILE = path.join(PROJECT, 'data', 'schedule-dispatch-state.json');

async function launchPipeline(id) {
  const child = spawn(path.join(PROJECT, 'scripts', 'sync.sh'), PIPELINES[id].args, {
    cwd: PROJECT, detached: true, stdio: 'ignore'
  });
  await once(child, 'spawn');
  child.unref();
}

/** Invoked under scheduler-tick.sh's flock; injectable launcher never syncs in tests. */
async function dispatch({ now = new Date(), schedules = loadConfig().schedules, stateFile = STATE_FILE, launch = launchPipeline } = {}) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid scheduler state.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const minute = Math.floor(now.getTime() / 60000);
  const launched = [];
  for (const [id, schedule] of Object.entries(schedules)) {
    if (!Object.hasOwn(PIPELINES, id)) throw new Error('Unknown pipeline.');
    if (!isDue(schedule, now) || (state[id] !== undefined && state[id] >= minute)) continue;
    // Persist BEFORE launch: a crash must not launch the same slot twice.
    const previous = state[id];
    state[id] = minute;
    atomicWrite(stateFile, state);
    try {
      await launch(id);
    } catch (error) {
      if (previous === undefined) delete state[id];
      else state[id] = previous;
      atomicWrite(stateFile, state);
      throw error;
    }
    launched.push(id);
  }
  return launched;
}

module.exports = { dispatch };
if (require.main === module) {
  require('./server-check').requireProductionServer({ scriptName: 'Scheduled sync dispatcher' });
  dispatch().then(ids => {
    if (ids.length) console.log(`${new Date().toISOString()} Scheduled: ${ids.join(', ')}`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
