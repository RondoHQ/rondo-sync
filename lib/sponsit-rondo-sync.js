const { buildRondoSponsorCandidates } = require('./sponsit-rondo-mapping');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return normalize(value);
}

function personNameKey(acf = {}) {
  return `${normalize(acf.first_name)}|${normalize(acf.last_name)}`;
}

function hasPersonalName(candidate) {
  return Boolean(normalize(candidate.createAcf.first_name) || normalize(candidate.createAcf.last_name));
}

function identityMatches(candidate, person) {
  if (hasPersonalName(candidate)) {
    return personNameKey(candidate.createAcf) === personNameKey(person.acf);
  }
  return normalize(candidate.createAcf.company_name)
    && normalize(candidate.createAcf.company_name) === normalize(person.acf?.company_name);
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
  const byPersonId = indexMany(rondoPeople, (person) => normalize(person.acf?.sponsit_person_id));
  const byContactId = indexMany(rondoPeople, (person) => normalize(person.acf?.sponsit_contact_id));
  const byEmail = indexMany(rondoPeople, (person) => normalizeEmail(person.acf?.email_1));
  const candidateEmails = indexMany(candidates, (candidate) => normalizeEmail(candidate.createAcf.email_1));
  const activePersonIds = new Set(candidates.map((candidate) => normalize(candidate.sponsitPersonId)).filter(Boolean));
  const activeContactIds = new Set(candidates.map((candidate) => normalize(candidate.sponsitContactId)).filter(Boolean));
  const updates = [];
  const creates = [];
  const quarantined = [];
  const usedRondoIds = new Set();

  for (const candidate of candidates) {
    const personId = normalize(candidate.sponsitPersonId);
    const contactId = normalize(candidate.sponsitContactId);
    const email = normalizeEmail(candidate.createAcf.email_1);
    let matches = personId ? (byPersonId.get(personId) || []) : [];
    let strategy = 'sponsit_person_id';

    if (!matches.length && !personId) {
      matches = (byContactId.get(contactId) || []).filter((person) => !normalize(person.acf?.sponsit_person_id));
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
      updates.push({ candidate, person, strategy });
      continue;
    }
    if (!email && !hasPersonalName(candidate) && !normalize(candidate.createAcf.company_name)) {
      quarantined.push({ candidate, reason: 'insufficient_identity' });
      continue;
    }
    creates.push({ candidate });
  }

  const deactivations = rondoPeople.filter((person) => {
    const acf = person.acf || {};
    if (!['1', 'true', 'yes', 'on'].includes(normalize(acf.is_sponsor))) return false;
    const personId = normalize(acf.sponsit_person_id);
    const contactId = normalize(acf.sponsit_contact_id);
    if (personId) return !activePersonIds.has(personId);
    if (contactId) return !activeContactIds.has(contactId);
    return false;
  });

  return { candidates, creates, updates, deactivations, quarantined };
}

module.exports = { normalizeEmail, identityMatches, planRondoSponsorSync };
