const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCustomer,
  buildCleanupPreview,
  fetchAllCustomers
} = require('../tools/preview-freescout-customer-cleanup');

test('classifies non-minimal customer profile data without exposing values', () => {
  assert.deepEqual(
    classifyCustomer({
      id: 10,
      firstName: 'Maaike',
      lastName: 'Netten',
      emails: [{ value: 'member@example.test' }],
      _embedded: {
        phones: [{ value: '+31612345678' }],
        address: { city: 'Wijchen' },
        websites: [{ value: 'https://example.test' }]
      },
      customerFields: [{ id: 4, value: 'KNVB123' }],
      notes: ''
    }),
    ['phone', 'address', 'websites', 'customFields']
  );
});

test('ignores empty customer field definitions', () => {
  assert.deepEqual(
    classifyCustomer({
      customerFields: [
        { id: 4, name: 'KNVB ID', value: '', text: '' },
        { id: 7, name: 'Balance', value: null, text: '' }
      ]
    }),
    []
  );
});

test('summarizes only tracked customers and returns aggregate counts', () => {
  const preview = buildCleanupPreview(
    [
      {
        id: 10,
        _embedded: {
          phones: [{ value: '+31612345678' }],
          address: { city: 'Wijchen' }
        },
        customerFields: [{ id: 4, value: 'KNVB123' }]
      },
      { id: 11, photoUrl: 'https://example.test/photo.jpg' },
      { id: 99, notes: 'Untracked customer' }
    ],
    new Set([10, 11, 12])
  );

  assert.equal(preview.trackedCustomers, 3);
  assert.equal(preview.matchedTrackedCustomers, 2);
  assert.equal(preview.missingTrackedCustomers, 1);
  assert.equal(preview.customersWithExtraProfileData, 2);
  assert.equal(preview.categoryCounts.phone, 1);
  assert.equal(preview.categoryCounts.address, 1);
  assert.equal(preview.categoryCounts.photo, 1);
  assert.equal(preview.categoryCounts.customFields, 1);
  assert.equal(preview.categoryCounts.notes, 0);
  assert.equal(JSON.stringify(preview).includes('Wijchen'), false);
  assert.equal(JSON.stringify(preview).includes('+31612345678'), false);
});

test('loads every FreeScout customer page', async () => {
  const requested = [];
  const request = async endpoint => {
    requested.push(endpoint);
    const page = Number(new URL(`https://example.test${endpoint}`).searchParams.get('page'));
    return {
      body: {
        _embedded: { customers: [{ id: page }] },
        page: { totalPages: 2 }
      }
    };
  };

  assert.deepEqual(await fetchAllCustomers(request), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(requested, [
    '/api/customers?page=1&pageSize=100',
    '/api/customers?page=2&pageSize=100'
  ]);
});
