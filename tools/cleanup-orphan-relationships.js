require('dotenv/config');

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
    let errorDetails = '';
    try {
      const errorBody = await response.json();
      errorDetails = JSON.stringify(errorBody);
    } catch (e) {
      try {
        errorDetails = await response.text();
      } catch (e2) {
        errorDetails = 'Could not read error body';
      }
    }
    throw new Error(`${method} ${endpoint} failed: ${response.status} - ${errorDetails}`);
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

async function runCleanup(options = {}) {
  const { dryRun = true, verbose = false } = options;

  console.log(dryRun ? '=== DRY RUN ===' : '=== CLEANING ORPHAN RELATIONSHIPS ===');
  console.log('');

  // Get all Rondo Club people
  console.log('Fetching all people from Rondo Club...');
  const rondoClubPeople = await getAllRondoClubPeople();
  console.log(`Found ${rondoClubPeople.length} people in Rondo Club`);
  console.log('');

  // Build set of valid person IDs
  const validIds = new Set(rondoClubPeople.map(p => p.id));
  console.log(`Valid person IDs: ${validIds.size}`);
  console.log('');

  // Find people with orphaned relationships
  const toFix = [];

  for (const person of rondoClubPeople) {
    const relationships = person.fields?.relationships || [];
    if (relationships.length === 0) continue;

    const orphanedRelations = [];
    const validRelations = [];

    for (const rel of relationships) {
      const relatedId = rel.related_person_id;
      if (relatedId && !validIds.has(relatedId)) {
        orphanedRelations.push(rel);
      } else {
        validRelations.push(rel);
      }
    }

    if (orphanedRelations.length > 0) {
      const firstName = (person.fields?.first_name || '').trim();
      const lastName = (person.fields?.last_name || '').trim();
      const fullName = [firstName, lastName].filter(Boolean).join(' ');

      toFix.push({
        id: person.id,
        fullName,
        originalCount: relationships.length,
        orphanedCount: orphanedRelations.length,
        orphanedIds: orphanedRelations.map(r => r.related_person_id),
        validRelations
      });
    }
  }

  console.log('=== RESULTS ===');
  console.log(`People with orphaned relationships: ${toFix.length}`);

  const totalOrphaned = toFix.reduce((sum, p) => sum + p.orphanedCount, 0);
  console.log(`Total orphaned relationships: ${totalOrphaned}`);
  console.log('');

  if (verbose && toFix.length > 0) {
    console.log('People to fix (first 30):');
    toFix.slice(0, 30).forEach(p => {
      console.log(`  ID ${p.id}: "${p.fullName}" - ${p.orphanedCount} orphaned (pointing to: ${p.orphanedIds.join(', ')})`);
    });
    if (toFix.length > 30) {
      console.log(`  ... and ${toFix.length - 30} more`);
    }
    console.log('');
  }

  if (!dryRun && toFix.length > 0) {
    console.log('Fixing...');
    let fixed = 0;
    let errors = 0;

    for (const person of toFix) {
      try {
        // Fetch current person to get required fields
        const current = await rondoClubRequest(`wp/v2/people/${person.id}`);
        const payload = {
          fields: {
            first_name: current.fields?.first_name || '',
            last_name: current.fields?.last_name || '',
            relationships: person.validRelations
          }
        };
        await rondoClubRequest(`wp/v2/people/${person.id}`, 'PUT', payload);
        fixed++;
        if (fixed % 20 === 0) {
          console.log(`  Fixed ${fixed}/${toFix.length}...`);
        }
      } catch (error) {
        errors++;
        console.error(`  Failed to fix ID ${person.id} ("${person.fullName}"): ${error.message}`);
        if (verbose) {
          console.error(`    Payload: ${JSON.stringify(person.validRelations)}`);
        }
      }
    }
    console.log(`Done. Fixed: ${fixed}, Errors: ${errors}`);
  } else if (dryRun && toFix.length > 0) {
    console.log('Run with --fix to actually clean these relationships.');
  } else {
    console.log('No orphaned relationships found.');
  }
}

// CLI entry point
if (require.main === module) {
  const dryRun = !process.argv.includes('--fix');
  const verbose = process.argv.includes('--verbose');

  runCleanup({ dryRun, verbose })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { runCleanup };
