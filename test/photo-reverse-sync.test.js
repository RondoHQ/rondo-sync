const test = require('node:test');
const assert = require('node:assert/strict');
const { photoWindowOpen, runPhotoPilot, sha256 } = require('../lib/photo-reverse-sync');

function fixture(overrides = {}) {
  const bytes = Buffer.from('fixture jpeg bytes');
  const events = [];
  const job = { person_id: 123, knvb_id: 'TEST123', revision: 'revision-1', state: 'pending', window: { open: true, next_start: '2027-07-01' } };
  let reads = 0;
  const options = {
    personId: 123, knvbId: 'TEST123', revision: 'revision-1', expectedPhotoHash: 'before', apply: true,
    clock: () => new Date('2026-09-12T12:00:00Z'),
    api: async (endpoint, method, input) => {
      events.push(input?.action || 'get');
      if (method === 'GET') return { ...job, file: { mime_type: 'image/jpeg', base64: bytes.toString('base64'), sha256: sha256(bytes) } };
      if (input.action === 'claim') return { claim_token: 'claim-1' };
      return {};
    },
    sportlink: {
      read: async () => ({ sha256: ++reads > 1 ? 'a'.repeat(64) : 'before', photoDate: '2026-09-12' }),
      upload: async (_id, _bytes, _expected, guard) => { guard(); events.push('upload'); }
    },
    ...overrides,
  };
  return { options, events, job };
}

test('Dutch season includes both boundary days and handles UTC offsets', () => {
  for (const [time, expected] of [
    ['2026-06-30T21:59:59Z', false], ['2026-06-30T22:00:00Z', true],
    ['2026-10-31T22:59:59Z', true], ['2026-10-31T23:00:00Z', false],
    ['2027-01-01T00:00:00Z', false]
  ]) assert.equal(photoWindowOpen(new Date(time)), expected, time);
});

test('closed season does not open Sportlink, export image bytes or claim work', async () => {
  const { options, events } = fixture({ clock: () => new Date('2026-11-01T00:00:00Z') });
  options.sportlink.read = async () => assert.fail('Sportlink must not be opened');
  assert.equal((await runPhotoPilot(options)).state, 'waiting_window');
  assert.deepEqual(events, ['get']);
});

test('preview reads one profile and never writes or exports the Rondo photo', async () => {
  const { options, events } = fixture({ apply: false });
  assert.equal((await runPhotoPilot(options)).expectedPhotoHash, 'before');
  assert.deepEqual(events, ['get']);
});

test('only verified upload completes its claimed revision', async () => {
  const { options, events } = fixture();
  assert.equal((await runPhotoPilot(options)).state, 'synced');
  assert.deepEqual(events, ['get', 'get', 'claim', 'upload', 'complete']);
});

test('changed Sportlink or Rondo photos require a new preview before any write', async () => {
  for (const change of [{ revision: 'old' }, { expectedPhotoHash: 'old' }]) {
    const { options, events } = fixture(change);
    await assert.rejects(runPhotoPilot(options), /preview/i);
    assert.deepEqual(events, ['get']);
  }
});

test('wrong linked identity never opens Sportlink', async () => {
  const { options, events, job } = fixture();
  job.knvb_id = 'OTHER12';
  await assert.rejects(runPhotoPilot(options), /profiel wijkt af/);
  assert.deepEqual(events, ['get']);
});

test('pending work replaced during export cannot be claimed', async () => {
  const { options, events } = fixture();
  const api = options.api;
  options.api = async (...args) => {
    const result = await api(...args);
    if (args[0].includes('include_file')) result.revision = 'replacement';
    return result;
  };
  await assert.rejects(runPhotoPilot(options), /intussen gewijzigd/);
  assert.deepEqual(events, ['get', 'get']);
});

test('uncertain upload is parked for review without retry', async () => {
  const { options, events } = fixture();
  options.sportlink.upload = async () => { events.push('upload'); throw new Error('Timeout after saving'); };
  await assert.rejects(runPhotoPilot(options), /Timeout/);
  assert.deepEqual(events, ['get', 'get', 'claim', 'upload', 'review']);
});

test('lost completion callback never repeats a Sportlink upload', async () => {
  const { options, events } = fixture();
  const api = options.api;
  options.api = async (...args) => {
    const result = await api(...args);
    if (args[2]?.action === 'complete') throw new Error('Callback lost');
    return result;
  };
  await assert.rejects(runPhotoPilot(options), /Callback lost/);
  assert.equal(events.filter(event => event === 'upload').length, 1);
  assert.equal(events.at(-1), 'review');
});

test('unchanged or missing stored photo cannot be marked synced', async () => {
  const { options, events } = fixture();
  options.sportlink.read = async () => ({ sha256: 'before', photoDate: '2026-09-12' });
  await assert.rejects(runPhotoPilot(options), /niet worden bevestigd/);
  assert.equal(events.at(-1), 'review');
  assert.ok(!events.includes('complete'));
});

test('season closing while preparing prevents the Sportlink write', async () => {
  const { options, events } = fixture();
  let expired = false;
  options.clock = () => new Date(expired ? '2026-11-01T00:00:00Z' : '2026-10-31T20:00:00Z');
  const api = options.api;
  options.api = async (...args) => {
    const result = await api(...args);
    if (args[2]?.action === 'claim') expired = true;
    return result;
  };
  await assert.rejects(runPhotoPilot(options), /31 oktober/);
  assert.ok(!events.includes('upload'));
  assert.equal(events.at(-1), 'review');
});

test('completed or uncertain jobs are never attempted again', async () => {
  for (const state of ['synced', 'sending', 'review']) {
    const { options, events, job } = fixture();
    job.state = state;
    assert.equal((await runPhotoPilot(options)).state, state);
    assert.deepEqual(events, ['get']);
  }
});
