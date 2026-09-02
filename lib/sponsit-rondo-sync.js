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
  const personGroups = groupPeopleCandidates(peopleCandidates);
  const relationSourceMatches = relationshipPersonIndex(rondoSponsors, rondoPeople);
  const byLegacyPersonId = indexMany(rondoPeople, (person) => normalize(person.fields?.sponsit_person_id));
  const byEmail = indexMany(rondoPeople, (person) => normalizeEmail(person.fields?.email_1));
  const people = { creates: [], updates: [], unchanged: [], quarantined: [] };
  const resolvedPeople = new Map();

  for (const group of personGroups) {
    const candidate = group.candidate;
    const sourceIds = group.aliases.map((alias) => normalize(alias.sponsitPersonId)).filter(Boolean);
    const email = normalizeEmail(candidate.fields.email_1);
    let matches = sourceIds.flatMap((sourceId) => relationSourceMatches.get(sourceId) || []);
    let strategy = 'sponsor_relationship';
    if (!matches.length && sourceIds.length) {
      matches = sourceIds.flatMap((sourceId) => byLegacyPersonId.get(sourceId) || []);
      strategy = 'legacy_sponsit_person_id';
    }
    if (!matches.length && email) {
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
      group.aliases.forEach((alias) => resolvedPeople.set(alias.sourceKey, { personId: person.id, person, strategy }));
      const writableFields = (person.fields?.person_type || 'member') === 'contact'
        ? changedPersonFields(candidate.fields, person.fields || {})
        : {};
      const item = { candidate, aliases: group.aliases, person, strategy, fields: writableFields };
      if (Object.keys(writableFields).length) people.updates.push(item);
      else people.unchanged.push(item);
      continue;
    }
    if (!hasPersonalName(candidate)) {
      people.quarantined.push({ candidate, aliases: group.aliases, reason: 'insufficient_identity' });
      continue;
    }
    people.creates.push({ candidate, aliases: group.aliases });
    group.aliases.forEach((alias) => resolvedPeople.set(alias.sourceKey, { createSourceKey: candidate.sourceKey }));
  }

  assignPrimaryPassRelations(personGroups, resolvedPeople, rondoSponsors);

  const sponsorsBySource = indexMany(rondoSponsors, (sponsor) => normalize(sponsor.fields?.sponsit_contact_id));
  const sponsors = { creates: [], updates: [], unchanged: [], archives: [], quarantined: [] };
  const activeSourceIds = new Set(companies.map((company) => normalize(company.sponsitContactId)));

  for (const company of companies) {
    const matches = sponsorsBySource.get(normalize(company.sponsitContactId)) || [];
    if (matches.length > 1) {
      sponsors.quarantined.push({ company, reason: 'duplicate_rondo_sponsit_contact_id' });
      continue;
    }
    const relationsBlocked = company.people.some((candidate) => !resolvedPeople.has(candidate.sourceKey));
    const desired = buildSponsorPayload(company, resolvedPeople, new Map(), { includeContacts: !relationsBlocked });
    if (matches.length === 0) {
      sponsors.creates.push({ company, desired, relationsBlocked, logoNeedsImport: Boolean(company.logo) });
      continue;
    }
    const sponsor = matches[0];
    const item = { company, sponsor, desired, relationsBlocked, logoNeedsImport: sponsorLogoNeedsImport(company, sponsor) };
    if (sponsorPayloadMatches(sponsor, desired)) sponsors.unchanged.push(item);
    else sponsors.updates.push(item);
  }

  sponsors.archives = rondoSponsors.filter((sponsor) => {
    const sourceId = normalize(sponsor.fields?.sponsit_contact_id);
    return sourceId && sponsor.status === 'publish' && !activeSourceIds.has(sourceId);
  });

  return { companies, peopleCandidates, people, sponsors, resolvedPeople };
}

function sponsorLogoNeedsImport(company, sponsor) {
  if (!company.logo) return false;
  const attachmentId = Number(sponsor?.logo_attachment_id || 0);
  const currentSourceId = normalize(sponsor?.fields?.sponsit_logo_id);
  if (attachmentId > 0 && !currentSourceId) return false;
  return attachmentId === 0 || currentSourceId !== normalize(company.logo.sourceId);
}

function dedupePeople(candidates) {
  const bySource = new Map();
  for (const candidate of candidates) {
    if (!bySource.has(candidate.sourceKey)) bySource.set(candidate.sourceKey, candidate);
  }
  return [...bySource.values()];
}

function groupPeopleCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const email = normalizeEmail(candidate.fields.email_1);
    const identityKey = email && hasPersonalName(candidate)
      ? `identity:${email}|${personNameKey(candidate.fields)}`
      : `source:${candidate.sourceKey}`;
    if (!groups.has(identityKey)) groups.set(identityKey, []);
    groups.get(identityKey).push(candidate);
  }
  return [...groups.values()].map((aliases) => ({ candidate: aliases[0], aliases }));
}

/** Rondo permits one primary sponsor pass per person across all companies. */
function assignPrimaryPassRelations(personGroups, resolvedPeople = new Map(), rondoSponsors = []) {
  const manualPrimaryPersonIds = new Set();
  for (const sponsor of rondoSponsors) {
    if (sponsor.status !== 'publish' || normalize(sponsor.fields?.sponsit_contact_id)) continue;
    for (const contact of sponsor.fields?.contacts || []) {
      if (contact.receives_pass && contact.is_primary_pass && contact.person_id) {
        manualPrimaryPersonIds.add(Number(contact.person_id));
      }
    }
  }

  for (const group of personGroups) {
    const resolvedPersonId = group.aliases
      .map((candidate) => Number(resolvedPeople.get(candidate.sourceKey)?.personId || 0))
      .find(Boolean);
    const manualPrimaryExists = resolvedPersonId && manualPrimaryPersonIds.has(resolvedPersonId);
    group.aliases.forEach((candidate, index) => {
      candidate.relation.is_primary_pass = !manualPrimaryExists && index === 0 && Boolean(candidate.relation.receives_pass);
    });
  }
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

function buildSponsorPayload(company, resolvedPeople, createdIds = new Map(), options = {}) {
  const { includeContacts = true } = options;
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
  const fields = { ...company.fields };
  if (includeContacts) fields.contacts = contacts;
  return { title: company.title, status: company.status, fields };
}

function sponsorPayloadMatches(sponsor, desired) {
  if (decodeHtmlEntities(sponsor.title) !== decodeHtmlEntities(desired.title) || sponsor.status !== desired.status) return false;
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

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&(apos|#039);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-');
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
  sponsorLogoNeedsImport,
  planRondoSponsorSync
};
