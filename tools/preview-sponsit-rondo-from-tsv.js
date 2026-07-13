#!/usr/bin/env node

const fs = require('fs');
const { openDb, getContactRecords } = require('../lib/sponsit-db');
const { planRondoSponsorSync } = require('../lib/sponsit-rondo-sync');

const columns = [
  'id', 'person_type', 'is_sponsor', 'sponsit_contact_id', 'sponsit_person_id',
  'first_name', 'last_name', 'email_1', 'company_name'
];

function parsePeople(input) {
  return input.trim().split('\n').filter(Boolean).map((line) => {
    const values = line.split('\t');
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index] || '']));
    return {
      id: Number(row.id),
      acf: Object.fromEntries(columns.slice(1).map((column) => [column, row[column]]))
    };
  });
}

function main() {
  const people = parsePeople(fs.readFileSync(0, 'utf8'));
  const db = openDb();
  try {
    const records = getContactRecords(db, { activeOnly: true });
    const plan = planRondoSponsorSync(records, people);
    console.log(JSON.stringify({
      candidates: plan.candidates.length,
      existingPeople: people.length,
      creates: plan.creates.length,
      updates: plan.updates.length,
      unchanged: plan.unchanged.length,
      memberSponsorUpdates: plan.updates.filter((item) => (item.person.acf?.person_type || 'member') !== 'contact').length,
      contactSponsorUpdates: plan.updates.filter((item) => item.person.acf?.person_type === 'contact').length,
      deactivations: plan.deactivations.length,
      quarantined: plan.quarantined.length,
      quarantineReasons: plan.quarantined.reduce((counts, item) => {
        counts[item.reason] = (counts[item.reason] || 0) + 1;
        return counts;
      }, {})
    }, null, 2));
  } finally {
    db.close();
  }
}

module.exports = { parsePeople };

if (require.main === module) main();
