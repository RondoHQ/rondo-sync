const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareCustomer } = require('../steps/prepare-freescout-customers');
const { buildCreatePayload, buildUpdatePayload } = require('../steps/submit-freescout-sync');

const emptyDb = {
  prepare() {
    return { get: () => null };
  }
};

test('prepares only the customer name and email for FreeScout', async () => {
  const customer = await prepareCustomer(
    {
      knvb_id: 'KNVB123',
      data: {
        fields: {
          first_name: 'Maaike',
          last_name: 'Netten',
          email_1: 'MAAIKE@example.test',
          mobile_1: '+31612345678',
          addresses: [{ address_label: 'Home', city: 'Wijchen' }],
          knvb_id: 'KNVB123',
          type_lid: 'Bondslid'
        }
      }
    },
    emptyDb,
    emptyDb
  );

  assert.deepEqual(customer, {
    knvb_id: 'KNVB123',
    email: 'maaike@example.test',
    freescout_id: null,
    data: {
      firstName: 'Maaike',
      lastName: 'Netten'
    }
  });
});

test('creates customers with only name and email', () => {
  const payload = buildCreatePayload({
    email: 'member@example.test',
    data: {
      firstName: 'Jan',
      lastName: 'Test',
      phones: [{ value: '+31612345678' }],
      photoUrl: 'https://example.test/photo.jpg',
      websites: [{ value: 'https://example.test/profile' }]
    }
  });

  assert.deepEqual(payload, {
    firstName: 'Jan',
    lastName: 'Test',
    emails: [{ value: 'member@example.test', type: 'home' }]
  });
});

test('updates only customer names and adds the current email', () => {
  const payload = buildUpdatePayload({
    email: 'member@example.test',
    data: {
      firstName: 'Jan',
      lastName: 'Test',
      phones: [{ value: '+31612345678' }],
      customFields: { public_person_id: 'KNVB123' }
    }
  });

  assert.deepEqual(payload, {
    firstName: 'Jan',
    lastName: 'Test',
    emails_add: ['member@example.test']
  });
});
