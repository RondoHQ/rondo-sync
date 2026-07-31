'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchSponsitContacts,
  normalizeContactDetail,
  isActiveSponsor
} = require('../lib/sponsit-client');

function detailPayload(id, people = []) {
  return {
    component: 'Contacts/Details/Index',
    props: {
      contact: {
        id,
        name: `Contact ${id}`,
        status: { id: 10, code: 'sponsor', name: 'Sponsor' },
        tags: []
      },
      people,
      addresses: [{ id: id * 10, address: 'Dorpsstraat 1', postcode: '1234AB', city: 'Wijchen' }],
      billingAddress: null,
      dossier: { is_sponsor: true },
      customfields: []
    }
  };
}

test('fetchSponsitContacts reads every index page and stable-ID detail record', async () => {
  const calls = [];
  const session = {
    async requestInertia(url) {
      calls.push(url);
      if (url === '/contacts?page=1') {
        return {
          props: {
            contacts: {
              data: [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }],
              last_page: 2
            }
          }
        };
      }
      if (url === '/contacts?page=2') {
        return {
          props: {
            contacts: { data: [{ id: 3, name: 'Three' }], last_page: 2 }
          }
        };
      }
      if (url === '/contacts/1') return detailPayload(1, [{ id: 101, name: 'Person 1' }]);
      if (url === '/contacts/2') return detailPayload(2);
      if (url === '/contacts/3') return detailPayload(3, [{ id: 301, name: 'Person 3' }]);
      throw new Error(`Unexpected URL ${url}`);
    }
  };

  const progress = [];
  const contacts = await fetchSponsitContacts({
    session,
    detailConcurrency: 2,
    onProgress: (current, total) => progress.push([current, total])
  });

  assert.deepEqual(contacts.map((record) => record.contact.id), [1, 2, 3]);
  assert.deepEqual(contacts.map((record) => record.people.length), [1, 0, 1]);
  assert.ok(calls.includes('/contacts?page=1'));
  assert.ok(calls.includes('/contacts?page=2'));
  assert.deepEqual(progress.at(-1), [3, 3]);
});

test('normalizeContactDetail rejects mismatched IDs', () => {
  assert.throws(
    () => normalizeContactDetail(detailPayload(2), { id: 1 }),
    /does not match index ID/
  );
});

test('isActiveSponsor accepts status code or name', () => {
  assert.equal(isActiveSponsor({ contact: { status: { code: 'sponsor' } } }), true);
  assert.equal(isActiveSponsor({ contact: { status: { name: 'Sponsor' } } }), true);
  assert.equal(isActiveSponsor({ contact: { status: { code: 'old' } } }), false);
});

