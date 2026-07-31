const { buildRondoSponsorCandidates } = require('./sponsit-rondo-mapping');

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
  return Boolean(normalize(candidate.createFields.first_name) || normalize(candidate.createFields.last_name));
}

function identityMatches(candidate, person) {
  if (hasPersonalName(candidate)) {
    return personNameKey(candidate.createFields) === personNameKey(person.fields);
  }
  return normalize(candidate.createFields.company_name)
    && normalize(candidate.createFields.company_name) === normalize(person.fields?.company_name);
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

function planRondoSponsorSync(records, rondoPeople) {
  const candidates = records.flatMap(buildRondoSponsorCandidates);
  const byPersonId = indexMany(rondoPeople, (person) => normalize(person.fields?.sponsit_person_id));
  const byContactId = indexMany(rondoPeople, (person) => normalize(person.fields?.sponsit_contact_id));
  const byEmail = indexMany(rondoPeople, (person) => normalizeEmail(person.fields?.email_1));
  const candidateEmails = indexMany(candidates, (candidate) => normalizeEmail(candidate.createFields.email_1));
  const activePersonIds = new Set(candidates.map((candidate) => normalize(candidate.sponsitPersonId)).filter(Boolean));
  const activeContactIds = new Set(candidates.map((candidate) => normalize(candidate.sponsitContactId)).filter(Boolean));
  const updates = [];
  const unchanged = [];
  const creates = [];
  const quarantined = [];
  const usedRondoIds = new Set();

  for (const candidate of candidates) {
    const personId = normalize(candidate.sponsitPersonId);
    const contactId = normalize(candidate.sponsitContactId);
    const email = normalizeEmail(candidate.createFields.email_1);
    let matches = personId ? (byPersonId.get(personId) || []) : [];
    let strategy = 'sponsit_person_id';

    if (!matches.length && !personId) {
      matches = (byContactId.get(contactId) || []).filter((person) => !normalize(person.fields?.sponsit_person_id));
      strategy = 'sponsit_contact_id';
    }

    if (!matches.length && email) {
      if ((candidateEmails.get(email) || []).length > 1) {
        quarantined.push({ candidate, reason: 'duplicate_sponsit_email' });
        continue;
      }
      matches = (byEmail.get(email) || []).filter((person) => identityMatches(candidate, person));
      strategy = 'email_and_identity';
    }

    if (matches.length > 1) {
      quarantined.push({ candidate, reason: 'multiple_rondo_matches' });
      continue;
    }
    if (matches.length === 1) {
      const person = matches[0];
      if (usedRondoIds.has(person.id)) {
        quarantined.push({ candidate, reason: 'rondo_person_already_matched' });
        continue;
      }
      usedRondoIds.add(person.id);
      const match = { candidate, person, strategy };
      if (hasSponsorChanges(candidate.sponsorFields, person.fields || {})) updates.push(match);
      else unchanged.push(match);
      continue;
    }
    if (!email && !hasPersonalName(candidate) && !normalize(candidate.createFields.company_name)) {
      quarantined.push({ candidate, reason: 'insufficient_identity' });
      continue;
    }
    creates.push({ candidate });
  }

  const deactivations = rondoPeople.filter((person) => {
    const fields = person.fields || {};
    if (!['1', 'true', 'yes', 'on'].includes(normalize(fields.is_sponsor))) return false;
    const personId = normalize(fields.sponsit_person_id);
    const contactId = normalize(fields.sponsit_contact_id);
    if (personId) return !activePersonIds.has(personId);
    if (contactId) return !activeContactIds.has(contactId);
    return false;
  });

  return { candidates, creates, updates, unchanged, deactivations, quarantined };
}

function hasSponsorChanges(desired, current) {
  return Object.entries(desired).some(([key, value]) => {
    if (key === 'is_sponsor') {
      return ['1', 'true', 'yes', 'on'].includes(normalize(current[key])) !== Boolean(value);
    }
    return String(current[key] ?? '').trim() !== String(value ?? '').trim();
  });
}

module.exports = { normalizeEmail, identityMatches, hasSponsorChanges, planRondoSponsorSync };
