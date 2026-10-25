const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUpsertMemberParams } = require('../lib/laposta-client');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const rateLimit = require('../lib/laposta-rate-limit');

test('Laposta upserts preserve an existing unsubscribe', () => {
  const params = buildUpsertMemberParams('list-id', {
    email: 'sponsor@example.com',
    custom_fields: { businessclub: 'Ja' }
  });

  assert.equal(params.get('options[upsert]'), 'true');
  assert.equal(params.get('options[suppress_reactivation]'), 'true');
  assert.equal(params.get('options[suppress_email_notification]'), 'true');
  assert.equal(params.get('custom_fields[businessclub]'), 'Ja');
});

function mockClient(t, responses) {
  const oldKey = process.env.LAPOSTA_API_KEY;
  process.env.LAPOSTA_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (oldKey === undefined) delete process.env.LAPOSTA_API_KEY;
    else process.env.LAPOSTA_API_KEY = oldKey;
    delete require.cache[require.resolve('../lib/laposta-client')];
  });
  let clock = 0;
  const calls = [];
  const create = rateLimit.createRateLimitedRequest;
  t.mock.method(rateLimit, 'createRateLimitedRequest', request => create(request, {
    now: () => clock, sleep: async ms => { clock += ms; }
  }));
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter();
    const call = { options, body: '', time: clock };
    calls.push(call);
    req.write = chunk => { call.body += chunk; };
    req.end = () => process.nextTick(() => {
      const response = responses.shift();
      assert.ok(response, 'unexpected replay');
      if (response.error) { req.emit('error', response.error); return; }
      const res = new EventEmitter();
      res.statusCode = response.status;
      res.headers = response.headers || {};
      callback(res);
      if (response.streamError) { res.emit('error', response.streamError); return; }
      res.emit('data', JSON.stringify(response.body || {}));
      res.emit('end');
    });
    return req;
  });
  delete require.cache[require.resolve('../lib/laposta-client')];
  return { api: require('../lib/laposta-client'), calls };
}

test('real client reads Retry-After and preserves POST payload and opt-out protections on retry', async t => {
  const { api, calls } = mockClient(t, [
    { status: 429, headers: { 'retry-after': '7' } },
    { status: 201, body: { member: { member_id: 'synthetic' } } }
  ]);
  const result = await api.upsertMember('test-list', { email: 'test@example.test', custom_fields: { name: 'Test' } });
  assert.equal(result.status, 201);
  assert.deepEqual(calls.map(c => c.time), [0, 7000]);
  assert.equal(calls[0].body, calls[1].body);
  const params = new URLSearchParams(calls[1].body);
  for (const key of ['upsert', 'suppress_reactivation', 'suppress_email_notification']) {
    assert.equal(params.get(`options[${key}]`), 'true');
  }
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.path, '/v2/member');
  assert.ok(calls[1].options.signal instanceof AbortSignal);
});

test('real client retains HTTP error details without retrying non-429 failures', async t => {
  const details = { error: { code: 203, message: 'Unknown test field' } };
  const { api, calls } = mockClient(t, [{ status: 400, body: details }]);
  await assert.rejects(api.fetchFields('test-list'), e => e.status === 400 && e.details.error.code === 203);
  assert.equal(calls.length, 1);
});

test('aborted responses reject the client call and release the queue without replay', async t => {
  const error = Object.assign(new Error('response aborted'), { code: 'ECONNRESET' });
  const { api, calls } = mockClient(t, [{ status: 200, streamError: error }, { status: 200, body: { data: [] } }]);
  await assert.rejects(api.fetchMembers('test-list'), e => e === error);
  assert.deepEqual(await api.fetchMembers('another-list'), []);
  assert.equal(calls.length, 2);
});
