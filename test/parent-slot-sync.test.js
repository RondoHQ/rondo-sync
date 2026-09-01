const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  ensureParentSyncSchema,
  buildDesiredParent,
  findTrackedParentSource,
  extractEmailReplacementCandidates,
  resolveEmailReplacement,
  upsertParentJob,
  cancelMissingParentJobs,
  reconcileChild,
  reconcileParentEmailChanges,
  extractParentSlots,
  selectParentSlot,
  selectEmailReplacementSlot,
  parentValuesMatch,
  emailReplacementMatches,
  getReadyParentJobs,
  markParentJobSynced,
  hasUnresolvedParentJobs,
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

test('slot selection completes one compatible partially occupied slot', () => {
  const slots = extractParentSlots({
    NameParent1: 'Dennis Van Maasakker',
    EmailAddressParent1: 'deli@vmaasakker.nl',
    TelephoneParent1: '06-41683880',
    NameParent2: 'Lisan van Maasakker - Nas',
    EmailAddressParent2: '',
    TelephoneParent2: '06-43242490'
  });
  const desired = {
    name: 'Lisan van Maasakker- Nas',
    email: 'lisan@vmaasakker.nl',
    phone: '+31643242490'
  };

  assert.deepEqual(selectParentSlot(slots, desired), { slot: 2, existing: true });
  assert.equal(parentValuesMatch({ ...slots[1], email: desired.email }, desired), true);
});

test('email replacement selects only the exact old address and matching parent name', () => {
  const slots = extractParentSlots({
    NameParent1: 'Joep Jan Thijssen',
    EmailAddressParent1: 'old@example.org',
    TelephoneParent1: '0612345678',
    NameParent2: '',
    EmailAddressParent2: '',
    TelephoneParent2: ''
  });

  assert.deepEqual(selectEmailReplacementSlot(slots, {
    name: 'Joep Jan Thijssen',
    email: 'new@example.org',
    sourceEmail: 'old@example.org'
  }), { slot: 1, existing: true, alreadyTarget: false });
  assert.equal(emailReplacementMatches(
    { ...slots[0], email: 'new@example.org' },
    slots[0],
    { email: 'new@example.org' }
  ), true);
});

test('email replacement updates the old slot even when the target exists elsewhere', () => {
  const slots = extractParentSlots({
    NameParent1: 'Joep Jan Thijssen',
    EmailAddressParent1: 'old@example.org',
    TelephoneParent1: '0612345678',
    NameParent2: 'Joep Jan Thijssen',
    EmailAddressParent2: 'new@example.org',
    TelephoneParent2: ''
  });

  assert.deepEqual(selectEmailReplacementSlot(slots, {
    name: 'Joep Jan Thijssen',
    email: 'new@example.org',
    sourceEmail: 'old@example.org'
  }), { slot: 1, existing: true, alreadyTarget: false });
});

test('slot selection disambiguates a shared parent email with compatible identity fields', () => {
  const slots = extractParentSlots({
    NameParent1: 'Eerste ouder',
    EmailAddressParent1: 'gezin@example.org',
    TelephoneParent1: '0611111111',
    NameParent2: 'Tweede ouder',
    EmailAddressParent2: 'gezin@example.org',
    TelephoneParent2: '0622222222'
  });

  assert.deepEqual(selectParentSlot(slots, {
    name: 'Tweede ouder',
    email: 'gezin@example.org',
    phone: '+31622222222'
  }), { slot: 2, existing: true });
});

test('a tracked secondary email alone never queues a parent overwrite', async () => {
  const db = new Database(':memory:');
  ensureParentSyncSchema(db);
  db.exec(`
    CREATE TABLE rondo_club_parents (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      rondo_club_id INTEGER,
      data_json TEXT,
      last_seen_at TEXT
    )
  `);
  db.prepare(`
    INSERT INTO rondo_club_parents (email, rondo_club_id, data_json, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run('old@example.org', 88, JSON.stringify({ childKnvbIds: ['CHILD01'] }), '2026-09-01T07:00:00Z');

  assert.deepEqual(findTrackedParentSource(db, 88, 'CHILD01'), { email: 'old@example.org' });
  const reported = [];
  const result = await reconcileChild(db, {
    id: 42,
    fields: {
      knvb_id: 'CHILD01',
      former_member: false,
      relationships: [{ relationship_slug: 'parent', related_person_id: 88 }]
    },
    parent_sync_statuses: []
  }, {
    fetchPerson: async () => ({
      id: 88,
      fields: {
        first_name: 'Joep Jan',
        last_name: 'Thijssen',
        email_1: 'new@example.org',
        email_2: 'old@example.org',
        mobile_1: '0698765432'
      }
    }),
    reportParentStatus: async (job, state) => reported.push({ job, state })
  });

  assert.deepEqual(result, { queued: 0, blocked: 0 });
  assert.equal(getReadyParentJobs(db).length, 0);
  assert.deepEqual(reported, []);
  db.close();
});

test('a pending primary email audit queues one targeted replacement per linked child', async () => {
  const db = new Database(':memory:');
  ensureParentSyncSchema(db);
  const entry = {
    id: 501,
    created_at: '2026-09-01T08:00:00Z',
    type: 'email_promoted',
    sync_status: 'pending',
    changes: [
      {
        person_id: 88,
        field: 'email_1',
        old: 'old@example.org',
        new: 'new@example.org',
        sync: true
      },
      {
        person_id: 88,
        field: 'email_2',
        old: 'new@example.org',
        new: 'old@example.org',
        sync: true
      }
    ]
  };
  const parent = {
    id: 88,
    fields: {
      first_name: 'Joep Jan',
      last_name: 'Thijssen',
      email_1: 'new@example.org',
      email_2: 'old@example.org',
      relationships: [
        { relationship_slug: 'child', related_person_id: 42 },
        { relationship_slug: 'child', related_person_id: 43 }
      ]
    }
  };
  const child = {
    id: 42,
    fields: {
      knvb_id: 'CHILD01',
      former_member: false,
      relationships: [{ relationship_slug: 'parent', related_person_id: 88 }]
    }
  };
  const secondChild = {
    id: 43,
    fields: {
      knvb_id: 'CHILD02',
      former_member: false,
      relationships: [{ relationship_slug: 'parent', related_person_id: 88 }]
    }
  };

  const candidates = extractEmailReplacementCandidates([entry]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(resolveEmailReplacement(candidates[0], parent), {
    ...candidates[0],
    newEmail: 'new@example.org'
  });

  const reported = [];
  const result = await reconcileParentEmailChanges(
    db,
    [entry],
    new Map([[88, parent], [42, child], [43, secondChild]]),
    { reportParentStatus: async (job, state) => reported.push({ job, state }) }
  );

  assert.deepEqual(result, { queued: 2, blocked: 0 });
  const jobs = getReadyParentJobs(db);
  assert.equal(jobs.length, 2);
  const desired = JSON.parse(jobs[0].desired_json);
  assert.deepEqual(desired, {
    auditId: 501,
    childKnvbId: 'CHILD01',
    childRondoId: 42,
    email: 'new@example.org',
    mode: 'replace_email',
    name: 'Joep Jan Thijssen',
    parentRondoId: 88,
    sourceEmail: 'old@example.org'
  });
  assert.equal(reported[0].state, 'pending');
  assert.equal(reported[1].job.childKnvbId, 'CHILD02');
  db.close();
});

test('stale audit replacements are ignored when the new address is no longer current', () => {
  const candidate = {
    auditId: 502,
    personId: 88,
    oldEmail: 'old@example.org',
    newEmail: 'temporary@example.org'
  };
  assert.equal(resolveEmailReplacement(candidate, {
    fields: { email_1: 'final@example.org', email_2: '' }
  }), null);
});

test('removing a secondary email falls back to the current primary address', () => {
  const candidates = extractEmailReplacementCandidates([{
    id: 503,
    created_at: '2026-09-01T08:05:00Z',
    type: 'email_removed',
    sync_status: 'pending',
    changes: [{
      person_id: 88,
      field: 'email_2',
      old: 'removed@example.org',
      new: '',
      sync: true
    }]
  }]);

  assert.equal(resolveEmailReplacement(candidates[0], {
    fields: { email_1: 'primary@example.org', email_2: '' }
  }).newEmail, 'primary@example.org');
});

test('slot selection rejects a partially occupied slot with conflicting contact data', () => {
  const slots = extractParentSlots({
    NameParent1: 'Andere ouder',
    EmailAddressParent1: 'ander@example.org',
    TelephoneParent1: '0612345678',
    NameParent2: 'Lisan van Maasakker - Nas',
    EmailAddressParent2: '',
    TelephoneParent2: '0699999999'
  });

  assert.equal(selectParentSlot(slots, {
    name: 'Lisan van Maasakker- Nas',
    email: 'lisan@vmaasakker.nl',
    phone: '+31643242490'
  }), null);
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

test('parent audit stays open until every child job is resolved', () => {
  const db = new Database(':memory:');
  ensureParentSyncSchema(db);
  const parent = {
    parentRondoId: 24,
    name: 'Ouder met twee kinderen',
    email: 'ouder@example.org',
    phone: ''
  };
  upsertParentJob(db, { ...parent, childKnvbId: 'CHILD01', childRondoId: 13 });
  upsertParentJob(db, { ...parent, childKnvbId: 'CHILD02', childRondoId: 14 });

  const jobs = getReadyParentJobs(db);
  markParentJobSynced(db, jobs[0].id, 1);
  assert.equal(hasUnresolvedParentJobs(db, parent.parentRondoId), true);
  markParentJobSynced(db, jobs[1].id, 1);
  assert.equal(hasUnresolvedParentJobs(db, parent.parentRondoId), false);
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
