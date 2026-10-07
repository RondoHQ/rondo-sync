'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rondo-schedule-web-'));
process.chdir(tmp);
process.env.SESSION_SECRET = 'synthetic-test-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';
const { buildServer } = require('../lib/web-server');
const { loadConfig, PIPELINES } = require('../lib/schedule-config');
const configFile = path.join(tmp, 'schedules.json');
process.on('exit', () => { process.chdir(cwd); fs.rmSync(tmp, { recursive: true, force: true }); });

test('schedule HTTP workflow requires auth and CSRF, persists valid edits and rejects invalid/stale saves', async t => {
  const app = await buildServer({ scheduleConfigFile: configFile });
  t.after(() => app.close());
  app.get('/test-session', async request => {
    request.session.user = { username: 'synthetic', displayName: 'Synthetic user' };
    return { ok: true };
  });
  const anonymous = await app.inject('/beheer/schedules');
  assert.equal(anonymous.statusCode, 302);
  assert.equal(anonymous.headers.location, '/login');
  const anonymousSave = await app.inject({ method: 'POST', url: '/beheer/schedules', payload: {} });
  assert.equal(anonymousSave.statusCode, 302);
  const login = await app.inject('/test-session');
  const cookie = login.headers['set-cookie'].split(';')[0];
  const page = await app.inject({ url: '/beheer/schedules', headers: { cookie } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /name="people_times" value="08:00, 11:00, 14:00, 17:00"/);
  assert.doesNotMatch(page.body, /http-equiv="refresh"/);
  const csrf = page.body.match(/name="csrf_token" value="([^"]+)"/)[1];
  const revision = page.body.match(/name="revision" value="([^"]+)"/)[1];
  assert.equal((await app.inject({ method: 'POST', url: '/beheer/schedules', headers: { cookie }, payload: {} })).statusCode, 403);
  const payload = { csrf_token: csrf, revision };
  for (const [id, s] of Object.entries(loadConfig(configFile).schedules)) {
    payload[`${id}_enabled`] = 'on'; payload[`${id}_cadence`] = s.cadence;
    payload[`${id}_times`] = s.times?.join(', ') || '';
    payload[`${id}_weekday`] = String(s.dayOfWeek);
    payload[`${id}_monthday`] = String(s.dayOfMonth);
    payload[`${id}_interval`] = String(s.intervalMinutes);
  }
  const invalid = await app.inject({ method: 'POST', url: '/beheer/schedules', headers: { cookie }, payload: { ...payload, people_times: '27:00' } });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body, /27:00/);
  assert.match(invalid.body, /People: enter/);
  assert.equal(fs.existsSync(configFile), false);
  const valid = await app.inject({ method: 'POST', url: '/beheer/schedules', headers: { cookie }, payload: { ...payload, people_times: '09:15, 21:00' } });
  assert.equal(valid.statusCode, 302);
  assert.equal(valid.headers.location, '/beheer/schedules?saved=1');
  assert.deepEqual(loadConfig(configFile).schedules.people.times, ['09:15', '21:00']);
  assert.equal((await app.inject({ method: 'POST', url: '/beheer/schedules', headers: { cookie }, payload })).statusCode, 409);
  const readback = await app.inject({ url: valid.headers.location, headers: { cookie } });
  assert.equal(readback.statusCode, 200);
  assert.match(readback.body, /Schedules saved/);
  assert.match(readback.body, /09:15, 21:00/);
  for (const id of Object.keys(PIPELINES)) assert.ok(readback.body.includes(`name="${id}_cadence"`));
});
