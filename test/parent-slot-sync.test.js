const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  ensureParentSyncSchema,
  buildDesiredParent,
  upsertParentJob,
  cancelMissingParentJobs,
  extractParentSlots,
  selectParentSlot,
  parentValuesMatch,
  getReadyParentJobs,
  markParentJobFailed
} = require('../lib/parent-slot-sync');

test('buildDesiredParent uses canonical name and contact fields', () => {
  const desired = buildDesiredParent(
    {
      id: 88,
      fields: {
        first_name: '  Noor ',
        infix: 'van',
        last_name: ' Dijk ',
        email_1: 'NOOR@example.org ',
        mobile_1: '+31 6 12345678'
      }
    },
    { id: 42, fields: { knvb_id: ' BBCC12D ' } }
  );

  assert.deepEqual(desired, {
    childKnvbId: 'BBCC12D',
    childRondoId: 42,
    parentRondoId: 88,
    name: 'Noor van Dijk',
    email: 'noor@example.org',
    phone: '+31 6 12345678'
  });
});

test('slot selection matches email before choosing a fully empty slot', () => {
  const slots = extractParentSlots({
    NameParent1: 'Bestaande ouder',
    EmailAddressParent1: 'ouder@example.org',
    TelephoneParent1: '0612345678',
    NameParent2: '',
    EmailAddressParent2: '',
    TelephoneParent2: ''
  });

  assert.deepEqual(selectParentSlot(slots, { email: 'OUDER@example.org' }), { slot: 1, existing: true });
  assert.deepEqual(selectParentSlot(slots, { email: 'nieuw@example.org' }), { slot: 2, existing: false });
  assert.equal(parentValuesMatch(slots[0], {
    name: 'Bestaande ouder',
    email: 'ouder@example.org',
    phone: '0612345678'
  }), true);
});

test('slot selection never overwrites a partially occupied slot', () => {
  const slots = extractParentSlots({
    NameParent1: 'Ouder een',
    EmailAddressParent1: 'een@example.org',
    TelephoneParent1: '',
    NameParent2: 'Handmatig ingevuld',
    EmailAddressParent2: '',
    TelephoneParent2: ''
  });
  assert.equal(selectParentSlot(slots, { email: 'nieuw@example.org' }), null);
});

test('queue upsert is idempotent and reopens a changed desired state', () => {
  const db = new Database(':memory:');
  ensureParentSyncSchema(db);
  const desired = {
    childKnvbId: 'TEST01',
    childRondoId: 10,
    parentRondoId: 20,
    name: 'Test Ouder',
    email: 'ouder@example.org',
    phone: ''
  };

  const first = upsertParentJob(db, desired);
  const second = upsertParentJob(db, desired);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(getReadyParentJobs(db).length, 1);

  db.prepare("UPDATE parent_slot_sync_jobs SET state = 'synced'").run();
  const changed = upsertParentJob(db, { ...desired, phone: '0612345678' });
  assert.equal(changed.changed, true);
  assert.equal(getReadyParentJobs(db)[0].state, 'pending');
  db.close();
});

test('removed relationship cancels pending work but does not clear a synced slot', () => {
  const db = new Database(':memory:');
  ensureParentSyncSchema(db);
  const base = {
    childKnvbId: 'TEST02',
    childRondoId: 11,
    name: 'Test Ouder',
    email: 'ouder@example.org',
    phone: ''
  };
  upsertParentJob(db, { ...base, parentRondoId: 21 });
  upsertParentJob(db, { ...base, parentRondoId: 22, email: 'twee@example.org' });
  db.prepare("UPDATE parent_slot_sync_jobs SET state = 'synced' WHERE parent_rondo_id = 22").run();

  assert.equal(cancelMissingParentJobs(db, 11, new Set()), 1);
  const rows = db.prepare('SELECT parent_rondo_id, state FROM parent_slot_sync_jobs ORDER BY parent_rondo_id').all();
  assert.deepEqual(rows, [
    { parent_rondo_id: 21, state: 'cancelled' },
    { parent_rondo_id: 22, state: 'synced' }
  ]);
  db.close();
});

test('no-free-slot errors block immediately', () => {
  const db = new Database(':memory:');
  ensureParentSyncSchema(db);
  upsertParentJob(db, {
    childKnvbId: 'TEST03', childRondoId: 12, parentRondoId: 23,
    name: 'Test Ouder', email: 'ouder@example.org', phone: ''
  });
  const job = getReadyParentJobs(db)[0];
  const error = new Error('Geen plek');
  error.code = 'no_free_parent_slot';
  assert.equal(markParentJobFailed(db, job, error), true);
  assert.equal(db.prepare('SELECT state FROM parent_slot_sync_jobs WHERE id = ?').get(job.id).state, 'blocked');
  db.close();
});
