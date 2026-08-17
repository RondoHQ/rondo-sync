const { buildRondoSponsorCompanyCandidate } = require('./sponsit-rondo-mapping');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return normalize(value);
}

function personNameKey(fields = {}) {
  return `${normalize(fields.first_name)}|${normalize(fields.last_name)}`;
}

function hasPersonalName(candidate) {
  return Boolean(normalize(candidate.fields.first_name) || normalize(candidate.fields.last_name));
}

function identityMatches(candidate, person) {
  return hasPersonalName(candidate) && personNameKey(candidate.fields) === personNameKey(person.fields);
}

function indexMany(items, keyFn) {
  const index = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(item);
  }
  return index;
}

/** Plan companies, people, relationships and archives as separate domains. */
function planRondoSponsorSync(records, rondoPeople = [], rondoSponsors = []) {
  const companies = records.map(buildRondoSponsorCompanyCandidate);
  const peopleCandidates = dedupePeople(companies.flatMap((company) => company.people));
  const relationSourceMatches = relationshipPersonIndex(rondoSponsors, rondoPeople);
  const byLegacyPersonId = indexMany(rondoPeople, (person) => normalize(person.fields?.sponsit_person_id));
  const byEmail = indexMany(rondoPeople, (person) => normalizeEmail(person.fields?.email_1));
  const candidateEmails = indexMany(peopleCandidates, (candidate) => normalizeEmail(candidate.fields.email_1));
  const people = { creates: [], updates: [], unchanged: [], quarantined: [] };
  const resolvedPeople = new Map();
  const usedRondoIds = new Set();

  for (const candidate of peopleCandidates) {
    const sourceId = normalize(candidate.sponsitPersonId);
    const email = normalizeEmail(candidate.fields.email_1);
    let matches = sourceId ? (relationSourceMatches.get(sourceId) || []) : [];
    let strategy = 'sponsor_relationship';
    if (!matches.length && sourceId) {
      matches = byLegacyPersonId.get(sourceId) || [];
      strategy = 'legacy_sponsit_person_id';
    }
    if (!matches.length && email) {
      if ((candidateEmails.get(email) || []).length > 1) {
        people.quarantined.push({ candidate, reason: 'duplicate_sponsit_email' });
        continue;
      }
      matches = (byEmail.get(email) || []).filter((person) => identityMatches(candidate, person));
      strategy = 'email_and_identity';
    }
    matches = uniquePeople(matches);
    if (matches.length > 1) {
      people.quarantined.push({ candidate, reason: 'multiple_rondo_matches' });
      continue;
    }
    if (matches.length === 1) {
      const person = matches[0];
      if (usedRondoIds.has(person.id)) {
        people.quarantined.push({ candidate, reason: 'rondo_person_already_matched' });
        continue;
      }
      usedRondoIds.add(person.id);
      resolvedPeople.set(candidate.sourceKey, { personId: person.id, person, strategy });
      const writableFields = (person.fields?.person_type || 'member') === 'contact'
        ? changedPersonFields(candidate.fields, person.fields || {})
        : {};
      const item = { candidate, person, strategy, fields: writableFields };
      if (Object.keys(writableFields).length) people.updates.push(item);
      else people.unchanged.push(item);
      continue;
    }
    if (!hasPersonalName(candidate)) {
      people.quarantined.push({ candidate, reason: 'insufficient_identity' });
      continue;
    }
    people.creates.push({ candidate });
    resolvedPeople.set(candidate.sourceKey, { createSourceKey: candidate.sourceKey });
  }

  const sponsorsBySource = indexMany(rondoSponsors, (sponsor) => normalize(sponsor.fields?.sponsit_contact_id));
  const sponsors = { creates: [], updates: [], unchanged: [], archives: [], quarantined: [] };
  const activeSourceIds = new Set(companies.map((company) => normalize(company.sponsitContactId)));

  for (const company of companies) {
    const matches = sponsorsBySource.get(normalize(company.sponsitContactId)) || [];
    if (matches.length > 1) {
      sponsors.quarantined.push({ company, reason: 'duplicate_rondo_sponsit_contact_id' });
      continue;
    }
    const desired = buildSponsorPayload(company, resolvedPeople);
    if (matches.length === 0) {
      sponsors.creates.push({ company, desired });
      continue;
    }
    const sponsor = matches[0];
    const item = { company, sponsor, desired };
    if (sponsorPayloadMatches(sponsor, desired)) sponsors.unchanged.push(item);
    else sponsors.updates.push(item);
  }

  sponsors.archives = rondoSponsors.filter((sponsor) => {
    const sourceId = normalize(sponsor.fields?.sponsit_contact_id);
    return sourceId && sponsor.status === 'publish' && !activeSourceIds.has(sourceId);
  });

  return { companies, peopleCandidates, people, sponsors, resolvedPeople };
}

function dedupePeople(candidates) {
  const bySource = new Map();
  for (const candidate of candidates) {
    if (!bySource.has(candidate.sourceKey)) bySource.set(candidate.sourceKey, candidate);
  }
  return [...bySource.values()];
}

function relationshipPersonIndex(sponsors, people) {
  const peopleById = new Map(people.map((person) => [Number(person.id), person]));
  const pairs = [];
  for (const sponsor of sponsors) {
    for (const contact of sponsor.fields?.contacts || []) {
      if (!contact.sponsit_person_id || !contact.person_id) continue;
      const person = peopleById.get(Number(contact.person_id)) || { id: Number(contact.person_id), fields: {} };
      pairs.push({ sourceId: normalize(contact.sponsit_person_id), person });
    }
  }
  return indexMany(pairs, (pair) => pair.sourceId);
}

function uniquePeople(matches) {
  const people = matches.map((match) => match.person || match);
  return [...new Map(people.map((person) => [Number(person.id), person])).values()];
}

function changedPersonFields(desired, current) {
  const fields = {};
  for (const [key, value] of Object.entries(desired)) {
    if (key === 'person_type') continue;
    if (String(current[key] ?? '').trim() !== String(value ?? '').trim()) fields[key] = value;
  }
  return fields;
}

function buildSponsorPayload(company, resolvedPeople, createdIds = new Map()) {
  const contacts = [];
  for (const personCandidate of company.people) {
    const resolution = resolvedPeople.get(personCandidate.sourceKey);
    const personId = resolution?.personId || createdIds.get(personCandidate.sourceKey);
    if (!personId) continue;
    contacts.push({ person_id: Number(personId), ...personCandidate.relation });
  }
  if (contacts.length) {
    contacts.forEach((contact, index) => { contact.is_primary = index === 0; });
  }
  return { title: company.title, status: company.status, fields: { ...company.fields, contacts } };
}

function sponsorPayloadMatches(sponsor, desired) {
  if (sponsor.title !== desired.title || sponsor.status !== desired.status) return false;
  const current = sponsor.fields || {};
  for (const [key, value] of Object.entries(desired.fields)) {
    if (key === 'contacts') {
      if (JSON.stringify(normalizeContacts(current.contacts || [])) !== JSON.stringify(normalizeContacts(value))) return false;
    } else if (String(current[key] ?? '').trim() !== String(value ?? '').trim()) {
      return false;
    }
  }
  return true;
}

function normalizeContacts(contacts) {
  return contacts.map((contact) => ({
    person_id: Number(contact.person_id),
    contact_role: String(contact.contact_role || 'Contactpersoon'),
    is_primary: Boolean(contact.is_primary),
    receives_pass: Boolean(contact.receives_pass),
    is_primary_pass: Boolean(contact.is_primary_pass),
    sponsit_person_id: String(contact.sponsit_person_id || '')
  })).sort((a, b) => a.person_id - b.person_id);
}

module.exports = {
  normalizeEmail,
  identityMatches,
  changedPersonFields,
  buildSponsorPayload,
  sponsorPayloadMatches,
  planRondoSponsorSync
};
