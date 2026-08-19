'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { deleteOrphanParents } = require('../steps/submit-rondo-club-sync');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rondo_club_members (
      knvb_id TEXT NOT NULL UNIQUE,
      rondo_club_id INTEGER,
      data_json TEXT NOT NULL
    );
    CREATE TABLE rondo_club_parents (
      email TEXT NOT NULL UNIQUE,
      rondo_club_id INTEGER
    );
  `);
  return db;
}

function addParent(db, email, rondoClubId) {
  db.prepare('INSERT INTO rondo_club_parents (email, rondo_club_id) VALUES (?, ?)')
    .run(email, rondoClubId);
}

test('orphan parent tracking never deletes a current member profile', async () => {
  const db = makeDb();
  addParent(db, 'old-parent@example.test', 6973);
  db.prepare('INSERT INTO rondo_club_members (knvb_id, rondo_club_id, data_json) VALUES (?, ?, ?)')
    .run('MNQT832', 6973, JSON.stringify({ fields: { email_1: 'member@example.test' } }));

  let requestCount = 0;
  const result = await deleteOrphanParents(db, [], {
    rondoClubRequest: async () => { requestCount++; }
  });

  assert.equal(requestCount, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.detached, [{
    email: 'old-parent@example.test',
    rondo_club_id: 6973,
    reason: 'member_profile'
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rondo_club_parents').get().count, 0);
});

test('orphan parent tracking also preserves a former member profile', async () => {
  const db = makeDb();
  addParent(db, 'former-parent@example.test', 3742);
  db.prepare('INSERT INTO rondo_club_members (knvb_id, rondo_club_id, data_json) VALUES (?, ?, ?)')
    .run('BMZK39R', 3742, '{}');

  let requestCount = 0;
  const result = await deleteOrphanParents(db, [], {
    rondoClubRequest: async () => { requestCount++; }
  });

  assert.equal(requestCount, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.detached[0].reason, 'member_profile');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rondo_club_parents').get().count, 0);
});

test('linked orphan profile is retained while obsolete tracking is detached', async () => {
  const db = makeDb();
  addParent(db, 'linked-parent@example.test', 1341);

  const result = await deleteOrphanParents(db, [], {
    rondoClubRequest: async () => {
      const error = new Error('Rondo Club API error (409)');
      error.details = {
        code: 'rondo_person_has_relationships',
        data: { status: 409 }
      };
      throw error;
    }
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.detached, [{
    email: 'linked-parent@example.test',
    rondo_club_id: 1341,
    reason: 'linked_person'
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rondo_club_parents').get().count, 0);
});

test('unexpected orphan deletion failures remain retryable errors', async () => {
  const db = makeDb();
  addParent(db, 'retry@example.test', 2000);

  const result = await deleteOrphanParents(db, [], {
    rondoClubRequest: async () => {
      throw new Error('Network unavailable');
    }
  });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].email, 'retry@example.test');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rondo_club_parents').get().count, 1);
});
