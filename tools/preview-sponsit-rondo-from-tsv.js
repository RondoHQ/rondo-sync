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
      fields: Object.fromEntries(columns.slice(1).map((column) => [column, row[column]]))
    };
  });
}

function main() {
  const people = parsePeople(fs.readFileSync(0, 'utf8'));
  const db = openDb();
  try {
    const records = getContactRecords(db, { activeOnly: true });
    const plan = planRondoSponsorSync(records, people);
    const quarantined = [...plan.people.quarantined, ...plan.sponsors.quarantined];
    console.log(JSON.stringify({
      companies: plan.companies.length,
      contactPeople: plan.peopleCandidates.length,
      existingPeople: people.length,
      peopleCreate: plan.people.creates.length,
      peopleUpdate: plan.people.updates.length,
      companiesCreate: plan.sponsors.creates.length,
      companiesUpdate: plan.sponsors.updates.length,
      companiesArchive: plan.sponsors.archives.length,
      quarantined: quarantined.length,
      quarantineReasons: quarantined.reduce((counts, item) => {
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
