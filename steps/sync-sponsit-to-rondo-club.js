#!/usr/bin/env node
require('dotenv/config');

const { openDb, getContactRecords } = require('../lib/sponsit-db');
const { buildSponsorPayload, sponsorPayloadMatches, planRondoSponsorSync } = require('../lib/sponsit-rondo-sync');
const { rondoClubRequestWithRetry, rondoClubMultipartRequest } = require('../lib/rondo-club-client');
const { SponsitSession } = require('../lib/sponsit-session');

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
    logosImported: 0,
    relationsWritten: 0,
    errors: []
  };
  const request = options.request || rondoClubRequestWithRetry;
  const downloadLogo = options.downloadSponsorLogo;
  const uploadLogo = options.uploadSponsorLogo || uploadSponsorLogo;
  const createdIds = new Map();
  const sponsorIds = new Map();
  const updatedSponsorIds = new Set();
  const companyWork = [...plan.sponsors.updates, ...plan.sponsors.unchanged, ...plan.sponsors.creates];

  // Sponsors must exist before Sync is allowed to create a person. The core
  // payload deliberately leaves relations untouched until every person has a
  // safe, known Rondo ID.
  for (const item of companyWork) {
    const corePayload = buildSponsorPayload(item.company, plan.resolvedPeople, createdIds, { includeContacts: false });
    const existing = item.sponsor;
    try {
      if (existing) {
        sponsorIds.set(item.company.sourceKey, Number(existing.id));
        if (!sponsorPayloadMatches(existing, corePayload)) {
          await request(`rondo/v1/sponsors/${existing.id}`, 'PATCH', corePayload, options);
          result.companiesUpdated += 1;
          updatedSponsorIds.add(Number(existing.id));
        }
      } else {
        const response = await request('rondo/v1/sponsors', 'POST', corePayload, options);
        const sponsorId = Number(response.body?.id || response.id);
        if (!sponsorId) throw new Error('Rondo returned no sponsor ID');
        sponsorIds.set(item.company.sourceKey, sponsorId);
        result.companiesCreated += 1;
      }
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.company.sourceKey, action: existing ? 'update_sponsor' : 'create_sponsor' }));
    }
  }

  for (const item of companyWork) {
    if (!item.logoNeedsImport || !item.company.logo) continue;
    const sponsorId = sponsorIds.get(item.company.sourceKey);
    if (!sponsorId) continue;
    try {
      if (typeof downloadLogo !== 'function') throw new Error('No Sponsit logo downloader configured');
      const file = await downloadLogo(item.company.logo);
      await uploadLogo(sponsorId, item.company.logo, file, options);
      result.logosImported += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.company.sourceKey, action: 'import_sponsor_logo' }));
    }
  }

  for (const item of plan.people.updates) {
    try {
      await request(`wp/v2/people/${item.person.id}`, 'PATCH', { fields: item.fields }, options);
      result.peopleUpdated += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.candidate.sourceKey, action: 'update_person' }));
    }
  }

  for (const item of plan.people.creates) {
    const aliases = item.aliases || [item.candidate];
    const sourceKeys = new Set(aliases.map((candidate) => candidate.sourceKey));
    const owner = plan.companies.find((company) => (
      sponsorIds.has(company.sourceKey)
      && company.people.some((candidate) => sourceKeys.has(candidate.sourceKey))
    ));
    if (!owner) {
      result.errors.push({ sourceKey: item.candidate.sourceKey, action: 'create_person', message: 'No successfully synchronized sponsor exists for this person', code: 'rondo_sponsor_required', params: null });
      continue;
    }
    const ownerCandidate = owner.people.find((candidate) => sourceKeys.has(candidate.sourceKey)) || item.candidate;
    try {
      const response = await request(
        `rondo/v1/sponsors/${sponsorIds.get(owner.sourceKey)}/contacts`,
        'POST',
        buildContactCreatePayload(item.candidate, ownerCandidate.relation),
        options
      );
      const personId = createdPersonId(response.body || response, ownerCandidate.relation.sponsit_person_id);
      if (!personId) throw new Error('Rondo returned no person ID');
      aliases.forEach((candidate) => createdIds.set(candidate.sourceKey, personId));
      createdIds.set(item.candidate.sourceKey, personId);
      result.peopleCreated += 1;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.candidate.sourceKey, action: 'create_person' }));
    }
  }

  // Write complete relation sets only when every source person resolved. A
  // quarantined match must never erase an existing relationship.
  for (const item of companyWork) {
    const sponsorId = sponsorIds.get(item.company.sourceKey);
    if (!sponsorId || item.relationsBlocked) continue;
    const payload = buildSponsorPayload(item.company, plan.resolvedPeople, createdIds);
    const existing = item.sponsor;
    if (payload.fields.contacts.length !== item.company.people.length) continue;
    if (existing && sponsorPayloadMatches(existing, payload)) continue;
    try {
      await request(`rondo/v1/sponsors/${sponsorId}`, 'PATCH', { fields: { contacts: payload.fields.contacts } }, options);
      if (existing && !updatedSponsorIds.has(sponsorId)) {
        result.companiesUpdated += 1;
        updatedSponsorIds.add(sponsorId);
      }
      result.relationsWritten += payload.fields.contacts.length;
    } catch (error) {
      result.errors.push(buildApplyError(error, { sourceKey: item.company.sourceKey, action: 'update_sponsor_relations' }));
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

function uploadSponsorLogo(sponsorId, logo, file, options = {}) {
  return rondoClubMultipartRequest(
    `rondo/v1/sponsors/${sponsorId}/logo/upload`,
    {
      fieldName: 'logo',
      buffer: file.buffer,
      filename: logo.filename,
      contentType: file.contentType
    },
    { sponsit_logo_id: logo.sourceId },
    options
  );
}

function buildContactCreatePayload(candidate, relation) {
  const fields = candidate.fields || {};
  return {
    first_name: fields.first_name || '',
    last_name: fields.last_name || '',
    email: fields.email_1 || '',
    email_2: fields.email_2 || '',
    telephone: fields.telephone_1 || '',
    telephone_2: fields.telephone_2 || '',
    gender: fields.gender || '',
    birthdate: fields.birthdate || '',
    contact_role: relation.contact_role,
    is_primary: Boolean(relation.is_primary),
    receives_pass: Boolean(relation.receives_pass),
    is_primary_pass: Boolean(relation.is_primary_pass),
    sponsit_person_id: relation.sponsit_person_id || ''
  };
}

function createdPersonId(sponsor, sourceId) {
  const contacts = sponsor?.fields?.contacts || [];
  const sourceMatch = contacts.find((contact) => String(contact.sponsit_person_id || '') === String(sourceId || ''));
  return Number(sourceMatch?.person_id || 0);
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
  const sponsorWork = [...plan.sponsors.creates, ...plan.sponsors.updates, ...plan.sponsors.unchanged];
  return {
    companies: plan.companies.length,
    organizationSponsors: plan.companies.filter((company) => company.fields.sponsor_type === 'organization').length,
    personalSponsors: plan.companies.filter((company) => company.fields.sponsor_type === 'person').length,
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
    logosAvailable: plan.companies.filter((company) => Boolean(company.logo)).length,
    logosImport: sponsorWork.filter((item) => item.logoNeedsImport).length,
    relationWritesBlocked: [...plan.sponsors.creates, ...plan.sponsors.updates, ...plan.sponsors.unchanged]
      .filter((item) => item.relationsBlocked).length,
    quarantined: quarantined.length,
    quarantineReasons: quarantined.reduce((counts, item) => {
      counts[item.reason] = (counts[item.reason] || 0) + 1;
      return counts;
    }, {})
  };
}

async function runSponsitRondoSync(options = {}) {
  const db = openDb();
  let sponsitSession = null;
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
    if (summary.logosImport > 0 && typeof options.downloadSponsorLogo !== 'function') {
      sponsitSession = new SponsitSession({ logger: options.logger, verbose: options.verbose });
    }
    const applied = await applyPlan(plan, {
      ...options,
      downloadSponsorLogo: options.downloadSponsorLogo
        || ((logo) => sponsitSession.requestFile(logo.relativeUrl))
    });
    console.log(JSON.stringify({ applied }, null, 2));
    return { success: applied.errors.length === 0, dryRun: false, summary, applied };
  } finally {
    if (sponsitSession) await sponsitSession.close();
    db.close();
  }
}

module.exports = { fetchRondoPeople, fetchRondoSponsors, applyPlan, summarizePlan, uploadSponsorLogo, runSponsitRondoSync };

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
