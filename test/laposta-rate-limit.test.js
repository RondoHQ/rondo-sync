const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimitedRequest } = require('../lib/laposta-rate-limit');

function limited(respond, start = 0) {
  let clock = start;
  const calls = [];
  const waits = [];
  const request = createRateLimitedRequest(async config => {
    calls.push({ config, time: clock });
    return respond(config, calls.length);
  }, { now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; } });
  return { request, calls, waits, advance: ms => { clock += ms; } };
}

const rateError = retryAfter => Object.assign(new Error('Laposta API error (429)'), {
  status: 429, retryAfter, details: { error: { message: 'Rate limit exceeded' } }
});

test('all lists and request types share spacing, including concurrent calls', async () => {
  const x = limited(async config => config);
  const configs = [{ method: 'GET', list: 1 }, { method: 'POST', list: 1 }, { method: 'GET', list: 2 }];
  assert.deepEqual(await Promise.all(configs.map(x.request)), configs);
  assert.deepEqual(x.calls.map(c => c.time), [0, 2500, 5000]);
  // Existing caller delays do not add a second full client delay.
  x.advance(2500);
  await x.request({ method: 'GET', list: 3 });
  assert.deepEqual(x.waits, [2500, 2500]);
});

test('429 respects Retry-After and retries the same operation before queued work', async () => {
  const x = limited(async (config, attempt) => {
    if (attempt === 1) throw rateError('8');
    return config;
  });
  const write = { method: 'POST', body: 'email=test&options[upsert]=true' };
  await Promise.all([x.request(write), x.request({ method: 'GET' })]);
  assert.deepEqual(x.calls.map(c => c.time), [0, 8000, 10500]);
  assert.equal(x.calls[0].config, x.calls[1].config);
});

test('HTTP-date Retry-After is respected', async () => {
  const start = Date.parse('2026-10-25T08:00:00Z');
  const x = limited(async (_, attempt) => {
    if (attempt === 1) throw rateError('Sun, 25 Oct 2026 08:00:09 GMT');
  }, start);
  await x.request({});
  assert.deepEqual(x.waits, [9000]);
});

test('missing or invalid Retry-After uses bounded exponential backoff and preserves the error', async () => {
  for (const header of [undefined, '', 'nonsense', '-1', 'Infinity']) {
    const error = rateError(header);
    const x = limited(async () => { throw error; });
    await assert.rejects(x.request({}), e => e === error);
    assert.equal(x.calls.length, 4);
    assert.deepEqual(x.waits, [2500, 5000, 10000]);
  }
});

test('zero and short Retry-After do not bypass minimum spacing', async () => {
  for (const header of ['0', '0.5', 'Sun, 25 Oct 2020 08:00:00 GMT']) {
    const x = limited(async (_, attempt) => { if (attempt === 1) throw rateError(header); }, Date.parse('2026-10-25T08:00:00Z'));
    await x.request({});
    assert.deepEqual(x.waits, [2500]);
  }
});

test('long cooldown fails promptly without retrying early, and the queue later recovers', async () => {
  const error = rateError('120');
  const x = limited(async (_, attempt) => { if (attempt === 1) throw error; return 'ok'; });
  await assert.rejects(x.request({}), e => e === error);
  await assert.rejects(x.request({}), e => e === error);
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.waits, []);
  x.advance(120000);
  assert.equal(await x.request({}), 'ok');
});

test('exhaustion keeps the provider cooldown for the next request', async () => {
  const x = limited(async (_, attempt) => { if (attempt <= 4) throw rateError('9'); });
  await assert.rejects(x.request({}), { status: 429 });
  await x.request({});
  assert.deepEqual(x.calls.map(c => c.time), [0, 9000, 18000, 27000, 36000]);
});

test('validation, server, and ambiguous network failures are never replayed or allowed to poison the queue', async () => {
  for (const error of [Object.assign(new Error('bad input'), { status: 400 }),
    Object.assign(new Error('unauthorized'), { status: 401 }),
    Object.assign(new Error('server error'), { status: 500 }),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('deadline'), { name: 'AbortError' })]) {
    const x = limited(async (_, attempt) => { if (attempt === 1) throw error; return 'ok'; });
    await assert.rejects(x.request({ method: 'POST' }), e => e === error);
    assert.equal(x.calls.length, 1);
    assert.equal(await x.request({ method: 'GET' }), 'ok');
  }
});
