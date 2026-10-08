'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rondo-pipeline-web-'));
process.chdir(tmp);
process.env.SESSION_SECRET = 'synthetic-test-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';
process.on('exit', () => { process.chdir(cwd); fs.rmSync(tmp, { recursive: true, force: true }); });

test('dashboard pipelines have authenticated history and Twelve can be started manually', async t => {
  const launches = [];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    launches.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 12345;
    child.unref = () => {};
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  });
  const { buildServer } = require('../lib/web-server');
  const { PIPELINE_CONFIG } = require('../lib/dashboard-queries');
  const { openDb } = require('../lib/dashboard-db');
  const app = await buildServer();
  const db = openDb();
  t.after(async () => { await app.close(); db.close(); });
  app.get('/test-session', async request => {
    request.session.user = { username: 'synthetic', displayName: 'Synthetic user' };
    return { ok: true };
  });

  for (const request of [
    { url: '/pipeline/twelve' },
    { method: 'POST', url: '/api/pipeline/twelve/start' }
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/login');
  }
  assert.equal(launches.length, 0);

  const login = await app.inject('/test-session');
  const cookie = login.headers['set-cookie'].split(';')[0];
  for (const [name, config] of Object.entries(PIPELINE_CONFIG)) {
    const history = await app.inject({ url: `/pipeline/${name}`, headers: { cookie } });
    assert.equal(history.statusCode, 200, `${name} history must be available`);
    assert.ok(history.body.includes(`${config.displayName} - Run History`));
  }
  assert.equal((await app.inject({ url: '/pipeline/unknown', headers: { cookie } })).statusCode, 404);
  const unknown = await app.inject({ method: 'POST', url: '/api/pipeline/unknown/start', headers: { cookie } });
  assert.equal(unknown.statusCode, 404);
  assert.equal(launches.length, 0);

  // Retain only this test's launch-log paths for cleanup; never run a real sync locally.
  const openSync = fs.openSync;
  const launchLogs = [];
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).includes('dashboard-launch')) launchLogs.push(file);
    return openSync(file, ...args);
  });
  t.after(() => launchLogs.forEach(file => fs.rmSync(file, { force: true })));
  const start = await app.inject({ method: 'POST', url: '/api/pipeline/twelve/start', headers: { cookie } });
  assert.equal(start.statusCode, 200);
  assert.deepEqual(start.json(), { ok: true, pipeline: 'twelve' });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, 'scripts/sync.sh');
  assert.deepEqual(launches[0].args, ['twelve']);
  assert.equal(launches[0].options.detached, true);

  db.prepare("INSERT INTO runs (pipeline, started_at, outcome) VALUES ('twelve', ?, 'running')").run(new Date().toISOString());
  const running = await app.inject({ method: 'POST', url: '/api/pipeline/twelve/start', headers: { cookie } });
  assert.equal(running.statusCode, 409);
  assert.equal(running.json().error, 'Pipeline is already running');
  assert.equal(launches.length, 1);
});
