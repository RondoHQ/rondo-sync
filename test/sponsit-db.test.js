'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  initDb,
  replaceSnapshot,
  getSponsitStats,
  getContactRecords
} = require('../lib/sponsit-db');

function makeDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

function record(id, options = {}) {
  const status = options.status || { id: 1, code: 'sponsor', name: 'Sponsor' };
  return {
    contact: {
      id,
      type: 'company',
      name: options.name || `Company ${id}`,
      email1: `company${id}@example.test`,
      status,
      tags: []
    },
    people: options.people || [],
    addresses: [],
    billingAddress: null,
    dossier: null,
    customfieldDefinitions: []
  };
}

test('replaceSnapshot creates, updates, leaves unchanged, and prunes atomically', () => {
  const db = makeDb();

  const first = replaceSnapshot(db, [
    record(1, { people: [{ id: 101, name: 'A', email1: 'a@example.test' }] }),
    record(2, { status: { id: 2, code: 'old', name: 'Oud Sponsor' } })
  ], { now: '2026-07-13T10:00:00.000Z', runId: 'run-1' });

  assert.deepEqual(first.contacts, { created: 2, updated: 0, unchanged: 0, deleted: 0 });
  assert.deepEqual(first.people, { created: 1, updated: 0, unchanged: 0, deleted: 0 });
  assert.deepEqual(getSponsitStats(db), {
    contacts: 2,
    activeSponsors: 1,
    people: 1,
    rondoCandidates: 1,
    statuses: [
      { status_code: 'old', status_name: 'Oud Sponsor', count: 1 },
      { status_code: 'sponsor', status_name: 'Sponsor', count: 1 }
    ]
  });

  const second = replaceSnapshot(db, [
    record(1, {
      name: 'Company 1 changed',
      people: [
        { id: 101, name: 'A', email1: 'a@example.test' },
        { id: 102, name: 'B', email1: 'b@example.test' }
      ]
    })
  ], { now: '2026-07-13T11:00:00.000Z', runId: 'run-2' });

  assert.deepEqual(second.contacts, { created: 0, updated: 1, unchanged: 0, deleted: 1 });
  assert.deepEqual(second.people, { created: 1, updated: 0, unchanged: 1, deleted: 0 });
  assert.equal(getSponsitStats(db).rondoCandidates, 2);
  assert.equal(getContactRecords(db).length, 1);
  assert.equal(getContactRecords(db)[0].people.length, 2);

  const third = replaceSnapshot(db, [record(1)], {
    now: '2026-07-13T12:00:00.000Z',
    runId: 'run-3'
  });
  assert.equal(third.people.deleted, 2);
  assert.equal(getSponsitStats(db).rondoCandidates, 1);

  db.close();
});

test('replaceSnapshot rejects duplicate stable IDs before touching the database', () => {
  const db = makeDb();
  assert.throws(() => replaceSnapshot(db, [record(1), record(1)]), /duplicate contact ID/);
  assert.equal(getSponsitStats(db).contacts, 0);
  db.close();
});

