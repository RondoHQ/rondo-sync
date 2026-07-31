require('dotenv/config');

const { openDb, getLatestSportlinkResults } = require('../lib/laposta-db');

const RONDO_URL = process.env.RONDO_URL;
const RONDO_USERNAME = process.env.RONDO_USERNAME;
const RONDO_APP_PASSWORD = process.env.RONDO_APP_PASSWORD;

async function rondoClubRequest(endpoint, method = 'GET', body = null) {
  const url = `${RONDO_URL}/wp-json/${endpoint}`;
  const auth = Buffer.from(`${RONDO_USERNAME}:${RONDO_APP_PASSWORD}`).toString('base64');

  const options = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed: ${response.status}`);
  }
  return response.json();
}

async function getAllRondoClubPeople() {
  const people = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const batch = await rondoClubRequest(`wp/v2/people?per_page=${perPage}&page=${page}`);
    if (batch.length === 0) break;
    people.push(...batch);
    console.log(`Fetched page ${page} (${people.length} total)...`);
    if (batch.length < perPage) break;
    page++;
  }

  return people;
}

function buildExpectedSets() {
  const db = openDb();
  const resultsJson = getLatestSportlinkResults(db);
  const data = JSON.parse(resultsJson);
  const members = data.Members || [];
  db.close();

  // Expected KNVB IDs (members)
  const expectedKnvbIds = new Set();
  const memberEmails = new Map(); // email -> name (for dedup check)

  members.forEach(m => {
    if (m.PublicPersonId) {
      expectedKnvbIds.add(m.PublicPersonId);
    }
    const email = (m.Email || '').toLowerCase().trim();
    if (email) {
      const name = [m.FirstName, m.Infix, m.LastName].filter(Boolean).join(' ').toLowerCase();
      memberEmails.set(email, name);
    }
  });

  // Expected parent emails (pure parents only)
  const expectedParentEmails = new Set();
  members.forEach(m => {
    // Parent 1
    const email1 = (m.EmailAddressParent1 || '').toLowerCase().trim();
    const name1 = (m.NameParent1 || '').toLowerCase().trim();
    if (email1 && name1) {
      // Only add if NOT a member with matching name
      const memberName = memberEmails.get(email1);
      if (memberName !== name1) {
        expectedParentEmails.add(email1);
      }
    }

    // Parent 2
    const email2 = (m.EmailAddressParent2 || '').toLowerCase().trim();
    const name2 = (m.NameParent2 || '').toLowerCase().trim();
    if (email2 && name2) {
      const memberName = memberEmails.get(email2);
      if (memberName !== name2) {
        expectedParentEmails.add(email2);
      }
    }
  });

  return { expectedKnvbIds, expectedParentEmails };
}

async function runCleanup(options = {}) {
  const { dryRun = true, verbose = false } = options;

  console.log(dryRun ? '=== DRY RUN ===' : '=== DELETING RECORDS ===');
  console.log('');

  // Get all Rondo Club people
  console.log('Fetching all people from Rondo Club...');
  const rondoClubPeople = await getAllRondoClubPeople();
  console.log(`Found ${rondoClubPeople.length} people in Rondo Club`);
  console.log('');

  // Build expected sets
  console.log('Building expected records from Sportlink...');
  const { expectedKnvbIds, expectedParentEmails } = buildExpectedSets();
  console.log(`Expected: ${expectedKnvbIds.size} members + ${expectedParentEmails.size} pure parents`);
  console.log('');

  // Group Rondo Club records
  const byKnvbId = new Map(); // knvbId -> [records]
  const parentsByEmail = new Map(); // email -> [records without KNVB ID]

  for (const person of rondoClubPeople) {
    const knvbId = person.fields?.['knvb_id'] || null;
    const email = (person.fields?.email_1 || person.fields?.email_2 || '').toLowerCase().trim();
    const firstName = (person.fields?.first_name || '').trim();
    const lastName = (person.fields?.last_name || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    const record = { id: person.id, knvbId, email, fullName };

    if (knvbId) {
      if (!byKnvbId.has(knvbId)) {
        byKnvbId.set(knvbId, []);
      }
      byKnvbId.get(knvbId).push(record);
    } else if (email) {
      // No KNVB ID - potential parent
      if (!parentsByEmail.has(email)) {
        parentsByEmail.set(email, []);
      }
      parentsByEmail.get(email).push(record);
    }
  }

  // Determine what to keep and delete
  const toKeep = [];
  const toDelete = [];

  // Process members (by KNVB ID)
  for (const [knvbId, records] of byKnvbId) {
    if (expectedKnvbIds.has(knvbId)) {
      // Keep the OLDEST record (lowest ID - likely has relationships established)
      records.sort((a, b) => a.id - b.id);
      toKeep.push({ ...records[0], reason: 'member (oldest)' });
      // Delete duplicates
      for (let i = 1; i < records.length; i++) {
        toDelete.push({ ...records[i], reason: 'duplicate member' });
      }
    } else {
      // KNVB ID not in expected - delete all
      for (const record of records) {
        toDelete.push({ ...record, reason: 'member not in Sportlink' });
      }
    }
  }

  // Process pure parents (by email, no KNVB ID)
  for (const [email, records] of parentsByEmail) {
    if (expectedParentEmails.has(email)) {
      // Keep the OLDEST record (lowest ID)
      records.sort((a, b) => a.id - b.id);
      toKeep.push({ ...records[0], reason: 'pure parent (oldest)' });
      // Delete duplicates
      for (let i = 1; i < records.length; i++) {
        toDelete.push({ ...records[i], reason: 'duplicate parent' });
      }
    } else {
      // Email not in expected parents - delete all
      for (const record of records) {
        toDelete.push({ ...record, reason: 'parent not in Sportlink' });
      }
    }
  }

  console.log('=== RESULTS ===');
  console.log(`To keep: ${toKeep.length}`);
  console.log(`To delete: ${toDelete.length}`);
  console.log('');

  // Group deletions by reason
  const byReason = {};
  for (const record of toDelete) {
    if (!byReason[record.reason]) {
      byReason[record.reason] = [];
    }
    byReason[record.reason].push(record);
  }

  console.log('Deletion breakdown:');
  for (const [reason, records] of Object.entries(byReason)) {
    console.log(`  ${reason}: ${records.length}`);
  }
  console.log('');

  if (verbose && toDelete.length > 0) {
    console.log('Records to delete (first 50):');
    toDelete.slice(0, 50).forEach(r => {
      console.log(`  ID ${r.id}: "${r.fullName}" - ${r.reason}`);
    });
    if (toDelete.length > 50) {
      console.log(`  ... and ${toDelete.length - 50} more`);
    }
    console.log('');
  }

  if (!dryRun && toDelete.length > 0) {
    console.log('Deleting...');
    let deleted = 0;
    let errors = 0;
    for (const record of toDelete) {
      try {
        await rondoClubRequest(`wp/v2/people/${record.id}?force=true`, 'DELETE');
        deleted++;
        if (deleted % 50 === 0) {
          console.log(`  Deleted ${deleted}/${toDelete.length}...`);
        }
      } catch (error) {
        errors++;
        console.error(`  Failed to delete ID ${record.id}: ${error.message}`);
      }
    }
    console.log(`Done. Deleted: ${deleted}, Errors: ${errors}`);
  } else if (dryRun && toDelete.length > 0) {
    console.log('Run with --delete to actually delete these records.');
  } else {
    console.log('No records to delete.');
  }
}

// CLI entry point
if (require.main === module) {
  const dryRun = !process.argv.includes('--delete');
  const verbose = process.argv.includes('--verbose');

  runCleanup({ dryRun, verbose })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { runCleanup };
