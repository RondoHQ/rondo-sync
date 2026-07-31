#!/usr/bin/env node

const { openDb, getContactRecords, getSponsitStats } = require('../lib/sponsit-db');
const {
  buildRondoSponsorCandidates,
  PASS_VARIANT_BUSINESSCLUB,
  PASS_VARIANT_AWC_SPONSOR
} = require('../lib/sponsit-rondo-mapping');

function parseArgs(argv = process.argv.slice(2)) {
  const contactIdArg = argv.find((arg) => arg.startsWith('--contact-id='));
  return {
    activeOnly: argv.includes('--active'),
    json: argv.includes('--json'),
    summaryOnly: argv.includes('--summary'),
    contactId: contactIdArg ? Number(contactIdArg.split('=')[1]) : null
  };
}

function main() {
  const options = parseArgs();
  const db = openDb();
  try {
    const stats = getSponsitStats(db);
    const activeRecords = getContactRecords(db, { activeOnly: true });
    const candidates = activeRecords.flatMap(buildRondoSponsorCandidates);
    const variantCounts = candidates.reduce((counts, candidate) => {
      const variant = candidate.sponsorFields.sponsor_pass_variant;
      counts[variant] = (counts[variant] || 0) + 1;
      return counts;
    }, {});

    const summary = {
      contacts: stats.contacts,
      activeSponsors: stats.activeSponsors,
      contactPeople: stats.people,
      rondoCandidates: stats.rondoCandidates,
      passVariants: {
        [PASS_VARIANT_BUSINESSCLUB]: variantCounts[PASS_VARIANT_BUSINESSCLUB] || 0,
        [PASS_VARIANT_AWC_SPONSOR]: variantCounts[PASS_VARIANT_AWC_SPONSOR] || 0
      },
      statuses: stats.statuses
    };

    if (options.summaryOnly) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const records = getContactRecords(db, {
      activeOnly: options.activeOnly,
      contactId: options.contactId
    });

    if (options.json) {
      console.log(JSON.stringify({ summary, records }, null, 2));
      return;
    }

    console.log('SPONSIT CONTACT IMPORT');
    console.log('======================');
    console.log(`Contacts: ${summary.contacts}`);
    console.log(`Current sponsors: ${summary.activeSponsors}`);
    console.log(`Contact people: ${summary.contactPeople}`);
    console.log(`Proposed Rondo records: ${summary.rondoCandidates}`);
    console.log(`Businessclub passes: ${summary.passVariants.businessclub}`);
    console.log(`AWC sponsor passes: ${summary.passVariants.awc_sponsor}`);
    console.log('');
    console.log(`${records.length} record(s) selected. Use --json to show personal data.`);
  } finally {
    db.close();
  }
}

module.exports = { parseArgs };

if (require.main === module) main();
