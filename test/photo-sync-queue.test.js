const test = require('node:test');
const assert = require('node:assert/strict');
const { runPhotoQueue } = require('../lib/photo-sync-queue');
const { sha256 } = require('../lib/photo-reverse-sync');

function fixture(count = 3) {
  const jobs = Array.from({ length: count }, (_, n) => ({ person_id: n + 1, knvb_id: `TEST00${n}`, revision: `revision-${n}`, state: 'pending', window: { open: true } }));
  const images = new Map(jobs.map(job => [job.knvb_id, 'old']));
  const events = [];
  const bytes = Buffer.from('jpeg fixture');
  const api = async (url, method, data) => {
    if (url.includes('photo-sync-jobs?')) {
      events.push('list');
      const page = Number(new URLSearchParams(url.split('?')[1]).get('page'));
      const pending = jobs.filter(job => job.state === 'pending');
      return { jobs: pending.slice(page - 1, page).map(job => ({ ...job })), next_page: page < pending.length ? page + 1 : null, window: { open: true } };
    }
    const job = jobs.find(job => job.person_id === Number(url.match(/people\/(\d+)/)[1]));
    if (method === 'GET') return { ...job, file: { mime_type: 'image/jpeg', base64: bytes.toString('base64'), sha256: sha256(bytes) } };
    if (data.action === 'claim') {
      assert.equal(job.state, 'pending'); job.state = 'sending'; events.push('claim');
      return { claim_token: 'token' };
    }
    job.state = data.action === 'complete' ? 'synced' : 'review';
    return {};
  };
  const sportlink = {
    read: async id => ({ sha256: images.get(id), photoDate: '2026-09-12' }),
    upload: async (id, _bytes, _hash, guard) => { guard(); events.push(`upload:${id}`); images.set(id, 'a'.repeat(64)); }
  };
  return { jobs, events, options: { api, sportlink, clock: () => new Date('2026-09-12T12:00:00Z') } };
}

test('collects all pages before sending so shrinking queues cannot skip people', async () => {
  const { jobs, events, options } = fixture();
  const result = await runPhotoQueue(options);
  assert.equal(result.synced, 3);
  assert.deepEqual(events.slice(0, 3), ['list', 'list', 'list']);
  assert.ok(jobs.every(job => job.state === 'synced'));
  assert.equal((await runPhotoQueue(options)).synced, 0);
});

test('explicit member filter and per-run limit do not send other people', async () => {
  const { jobs, options } = fixture();
  assert.equal((await runPhotoQueue({ ...options, knvbId: 'TEST001' })).synced, 1);
  assert.deepEqual(jobs.map(job => job.state), ['pending', 'synced', 'pending']);
  assert.equal((await runPhotoQueue({ ...options, limit: 1 })).synced, 1);
  assert.equal(jobs[2].state, 'pending');
});

test('uncertain upload remains parked and does not block the next person or retry', async () => {
  const { jobs, events, options } = fixture(2);
  const upload = options.sportlink.upload;
  options.sportlink.upload = async (...args) => {
    if (args[0] === 'TEST000') { events.push('failed-upload'); throw new Error('Uncertain save'); }
    return upload(...args);
  };
  const result = await runPhotoQueue(options);
  assert.equal(result.failed, 1);
  assert.equal(result.synced, 1);
  assert.equal(jobs[0].state, 'review');
  await runPhotoQueue(options);
  assert.equal(events.filter(event => event === 'failed-upload').length, 1);
});

test('outside the Dutch window no API or Sportlink calls run', async () => {
  const { options, events } = fixture();
  assert.equal((await runPhotoQueue({ ...options, clock: () => new Date('2026-11-01') })).synced, 0);
  assert.deepEqual(events, []);
});
