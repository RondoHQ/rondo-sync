#!/usr/bin/env node
require('dotenv/config');

const { openDb, getContactRecords } = require('../lib/sponsit-db');
const { buildSponsorPayload, sponsorPayloadMatches, planRondoSponsorSync } = require('../lib/sponsit-rondo-sync');
const { rondoClubRequestWithRetry } = require('../lib/rondo-club-client');

async function fetchRondoPeople(options = {}) {
  await rondoClubRequestWithRetry('wp/v2/users/me?_fields=id', 'GET', null, options);
  const people = [];
  for (let page = 1; ; page += 1) {
    try {
      const response = await rondoClubRequestWithRetry(
        `wp/v2/people?per_page=100&page=${page}&_fields=id,title,fields`,
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

async function fetchRondoSponsors(options = {}) {
  const sponsors = [];
  for (let page = 1; ; page += 1) {
    const response = await rondoClubRequestWithRetry(
      `rondo/v1/sponsors?status=all&per_page=100&page=${page}`,
      'GET',
      null,
      options
    );
    const body = response.body || {};
    const batch = Array.isArray(body.items) ? body.items : [];
    sponsors.push(...batch);
    if (page >= Number(body.total_pages || 1)) break;
  }
  return sponsors;
}

async function applyPlan(plan, options = {}) {
  const result = {
    peopleCreated: 0,
    peopleUpdated: 0,
    companiesCreated: 0,
    companiesUpdated: 0,
    companiesArchived: 0,
    relationsWritten: 0,
    errors: []
  };
  const request = options.request || rondoClubRequestWithRetry;
  const createdIds = new Map();

  for (const item of plan.people.updates) {
    try {
      await request(`wp/v2/people/${item.person.id}`, 'PATCH', { fields: item.fields }, options);
      result.peopleUpdated += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.candidate.sourceKey, action: 'update_person' }));
    }
  }

  for (const item of plan.people.creates) {
    try {
      const response = await request('wp/v2/people', 'POST', {
        title: item.candidate.displayName || 'Sponsorcontact',
        status: 'publish',
        fields: item.candidate.fields
      }, options);
      const personId = Number(response.body?.id || response.id);
      if (!personId) throw new Error('Rondo returned no person ID');
      createdIds.set(item.candidate.sourceKey, personId);
      result.peopleCreated += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.candidate.sourceKey, action: 'create_person' }));
    }
  }

  const companyWork = [...plan.sponsors.updates, ...plan.sponsors.unchanged, ...plan.sponsors.creates];
  for (const item of companyWork) {
    const payload = buildSponsorPayload(item.company, plan.resolvedPeople, createdIds);
    const existing = item.sponsor;
    if (existing && sponsorPayloadMatches(existing, payload)) continue;
    try {
      if (existing) {
        await request(`rondo/v1/sponsors/${existing.id}`, 'PATCH', payload, options);
        result.companiesUpdated += 1;
      } else {
        await request('rondo/v1/sponsors', 'POST', payload, options);
        result.companiesCreated += 1;
      }
      result.relationsWritten += payload.fields.contacts.length;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.company.sourceKey, action: existing ? 'update_company' : 'create_company' }));
    }
  }

  for (const sponsor of plan.sponsors.archives) {
    try {
      await request(`rondo/v1/sponsors/${sponsor.id}`, 'DELETE', null, options);
      result.companiesArchived += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { rondoId: sponsor.id, action: 'archive_company' }));
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

function summarizePlan(plan, existingPeople, existingSponsors) {
  const quarantined = [...plan.people.quarantined, ...plan.sponsors.quarantined];
  return {
    companies: plan.companies.length,
    people: plan.peopleCandidates.length,
    relations: plan.companies.reduce((sum, company) => sum + company.people.length, 0),
    existingPeople: existingPeople.length,
    existingCompanies: existingSponsors.length,
    peopleCreate: plan.people.creates.length,
    peopleUpdate: plan.people.updates.length,
    peopleUnchanged: plan.people.unchanged.length,
    companiesCreate: plan.sponsors.creates.length,
    companiesUpdate: plan.sponsors.updates.length,
    companiesUnchanged: plan.sponsors.unchanged.length,
    companiesArchive: plan.sponsors.archives.length,
    quarantined: quarantined.length,
    quarantineReasons: quarantined.reduce((counts, item) => {
      counts[item.reason] = (counts[item.reason] || 0) + 1;
      return counts;
    }, {})
  };
}

async function runSponsitRondoSync(options = {}) {
  const db = openDb();
  try {
    const records = getContactRecords(db, { activeOnly: true });
    const [people, sponsors] = await Promise.all([
      fetchRondoPeople(options),
      fetchRondoSponsors(options)
    ]);
    const plan = planRondoSponsorSync(records, people, sponsors);
    const summary = summarizePlan(plan, people, sponsors);
    console.log(JSON.stringify(summary, null, 2));
    if (!options.apply) return { success: true, dryRun: true, summary };
    const applied = await applyPlan(plan, options);
    console.log(JSON.stringify({ applied }, null, 2));
    return { success: applied.errors.length === 0, dryRun: false, summary, applied };
  } finally {
    db.close();
  }
}

module.exports = { fetchRondoPeople, fetchRondoSponsors, applyPlan, summarizePlan, runSponsitRondoSync };

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
