const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUpsertMemberParams } = require('../lib/laposta-client');

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
