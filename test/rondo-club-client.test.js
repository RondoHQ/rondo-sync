'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isRetryableRondoClubError,
  retryTransientRondoClubRequest
} = require('../lib/rondo-club-client');

test('Rondo Club retry classification includes transient API failures only', () => {
  assert.equal(isRetryableRondoClubError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isRetryableRondoClubError(Object.assign(new Error('deadline'), { code: 'ERR_REQUEST_DEADLINE' })), true);
  assert.equal(isRetryableRondoClubError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryableRondoClubError(Object.assign(new Error('server'), { status: 503 })), true);
  assert.equal(isRetryableRondoClubError(Object.assign(new Error('bad request'), { status: 400 })), false);
});

test('Rondo Club requests recover after bounded exponential retries', async () => {
  let attempts = 0;
  const delays = [];
  const messages = [];
  const result = await retryTransientRondoClubRequest(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error('temporary timeout'), { code: 'ETIMEDOUT' });
      }
      return { status: 200 };
    },
    {
      logger: {
        log: message => messages.push(message),
        verbose() {},
        error() {}
      },
      retryBaseDelayMs: 10,
      sleep: (resolve, delay) => {
        delays.push(delay);
        resolve();
      }
    },
    3
  );

  assert.deepEqual(result, { status: 200 });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(messages.length, 2);
});

test('Rondo Club requests do not retry permanent client errors', async () => {
  let attempts = 0;
  await assert.rejects(
    retryTransientRondoClubRequest(async () => {
      attempts++;
      throw Object.assign(new Error('forbidden'), { status: 403 });
    }),
    /forbidden/
  );
  assert.equal(attempts, 1);
});
