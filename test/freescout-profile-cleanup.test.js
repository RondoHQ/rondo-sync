const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIRMATION,
  buildStandardCleanupPayload,
  buildCustomerFieldsCleanupPayload,
  cleanupCustomers,
  parseLimit
} = require('../tools/cleanup-freescout-customer-profiles');

const customerWithExtraData = {
  id: 10,
  firstName: 'Maaike',
  lastName: 'Netten',
  photoUrl: 'https://example.test/photo.jpg',
  jobTitle: 'Secretary',
  customerFields: [
    { id: 4, name: 'KNVB ID', value: 'KNVB123', text: '' },
    { id: 7, name: 'Balance', value: '', text: '' }
  ],
  _embedded: {
    emails: [{ value: 'member@example.test' }],
    phones: [{ value: '+31612345678' }],
    address: { city: 'Wijchen', address: 'Example street' },
    social_profiles: [{ value: '@example' }],
    websites: [{ value: 'https://example.test' }]
  }
};

test('builds a standard cleanup payload without names or emails', () => {
  assert.deepEqual(buildStandardCleanupPayload(customerWithExtraData), {
    phone: '',
    phones: [],
    photoUrl: '',
    photoType: 'unknown',
    address: { city: '', state: '', zip: '', country: '', address: '' },
    jobTitle: '',
    socialProfiles: [],
    websites: []
  });
});

test('clears only customer fields that contain a value', () => {
  assert.deepEqual(buildCustomerFieldsCleanupPayload(customerWithExtraData), {
    customerFields: [{ id: 4, value: '' }]
  });
});

test('updates only tracked profiles and respects the canary limit', async () => {
  const requests = [];
  const request = async (endpoint, method, body) => {
    requests.push({ endpoint, method, body });
    return { status: 204, body: null };
  };
  const second = { ...customerWithExtraData, id: 11 };

  const result = await cleanupCustomers(
    [customerWithExtraData, second, { ...customerWithExtraData, id: 99 }],
    new Set([10, 11]),
    request,
    { limit: 1 }
  );

  assert.deepEqual(result, {
    candidates: 2,
    processed: 1,
    standardProfilesUpdated: 1,
    customFieldSetsCleared: 1
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].endpoint, '/api/customers/10');
  assert.equal(requests[1].endpoint, '/api/customers/10/customer_fields');
  assert.equal(JSON.stringify(requests).includes('member@example.test'), false);
  assert.equal(JSON.stringify(requests).includes('Maaike'), false);
});

test('requires a positive integer limit', () => {
  assert.equal(parseLimit([]), Number.POSITIVE_INFINITY);
  assert.equal(parseLimit(['--limit=1']), 1);
  assert.throws(() => parseLimit(['--limit=0']), /positive integer/);
  assert.equal(CONFIRMATION, 'remove-extra-profile-data');
});
