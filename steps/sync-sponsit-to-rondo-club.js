#!/usr/bin/env node
require('dotenv/config');

const { openDb, getContactRecords } = require('../lib/sponsit-db');
const { planRondoSponsorSync } = require('../lib/sponsit-rondo-sync');
const { rondoClubRequestWithRetry } = require('../lib/rondo-club-client');

async function fetchRondoPeople(options = {}) {
  // The public people collection can look like an empty database when Basic
  // Auth is rejected, so validate the application password explicitly first.
  await rondoClubRequestWithRetry('wp/v2/users/me?_fields=id', 'GET', null, options);
  const people = [];
  for (let page = 1; ; page += 1) {
    try {
      const response = await rondoClubRequestWithRetry(
        `wp/v2/people?per_page=100&page=${page}&_fields=id,title,acf`,
        'GET',
        null,
        options
      );
      const batch = Array.isArray(response.body) ? response.body : [];
      people.push(...batch);
      if (batch.length < 100) break;
    } catch (error) {
      if (error.status === 400 && people.length > 0) break;
      throw error;
    }
  }
  return people;
}

async function applyPlan(plan, options = {}) {
  const result = { created: 0, updated: 0, deactivated: 0, errors: [] };
  for (const item of plan.updates) {
    try {
      await rondoClubRequestWithRetry(`wp/v2/people/${item.person.id}`, 'PATCH', {
        acf: item.candidate.sponsorAcf
      }, options);
      result.updated += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.candidate.sourceKey, action: 'update' }));
    }
  }
  for (const item of plan.creates) {
    try {
      await rondoClubRequestWithRetry('wp/v2/people', 'POST', {
        title: item.candidate.displayName || item.candidate.createAcf.company_name || 'Sponsor',
        status: 'publish',
        acf: item.candidate.createAcf
      }, options);
      result.created += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.candidate.sourceKey, action: 'create' }));
    }
  }
  for (const person of plan.deactivations) {
    try {
      await rondoClubRequestWithRetry(`wp/v2/people/${person.id}`, 'PATCH', {
        acf: { is_sponsor: false, sponsor_pass_variant: '' }
      }, options);
      result.deactivated += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { rondoId: person.id, action: 'deactivate' }));
    }
  }
  return result;
}

function buildApplyError(error, context) {
  return {
    ...context,
    message: error.details?.message || error.message,
    code: error.details?.code || null,
    params: error.details?.data?.params || null
  };
}

async function runSponsitRondoSync(options = {}) {
  const db = openDb();
  try {
    const records = getContactRecords(db, { activeOnly: true });
    const people = await fetchRondoPeople(options);
    const plan = planRondoSponsorSync(records, people);
    const summary = {
      candidates: plan.candidates.length,
      existingPeople: people.length,
      creates: plan.creates.length,
      updates: plan.updates.length,
      memberSponsorUpdates: plan.updates.filter((item) => (item.person.acf?.person_type || 'member') !== 'contact').length,
      deactivations: plan.deactivations.length,
      quarantined: plan.quarantined.length,
      quarantineReasons: plan.quarantined.reduce((counts, item) => {
        counts[item.reason] = (counts[item.reason] || 0) + 1;
        return counts;
      }, {})
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!options.apply) return { success: true, dryRun: true, summary };
    const applied = await applyPlan(plan, options);
    console.log(JSON.stringify({ applied }, null, 2));
    return { success: applied.errors.length === 0, dryRun: false, summary, applied };
  } finally {
    db.close();
  }
}

module.exports = { fetchRondoPeople, applyPlan, runSponsitRondoSync };

if (require.main === module) {
  runSponsitRondoSync({
    apply: process.argv.includes('--apply'),
    verbose: process.argv.includes('--verbose')
  }).then((result) => {
    if (!result.success) process.exitCode = 2;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
