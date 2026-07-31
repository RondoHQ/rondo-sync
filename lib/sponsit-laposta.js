const { buildRondoSponsorCandidates } = require('./sponsit-rondo-mapping');
const { planRondoSponsorSync, normalizeEmail } = require('./sponsit-rondo-sync');

const SPONSIT_LAPOSTA_FIELDS = [
  'voornaam',
  'achternaam',
  'businessclub',
  'bedrijfsnaam',
  'sponsorvariant',
  'sponsitcontactid',
  'sponsitpersoonid',
  'islid'
];

function buildSponsitLapostaPlan(records, rondoPeople = []) {
  const candidates = records.flatMap(buildRondoSponsorCandidates);
  const rondoPlan = planRondoSponsorSync(records, rondoPeople);
  const memberSourceKeys = new Set(
    [...rondoPlan.updates, ...rondoPlan.unchanged]
      .filter((item) => (item.person.fields?.person_type || 'member') !== 'contact')
      .map((item) => item.candidate.sourceKey)
  );
  const byEmail = new Map();
  for (const candidate of candidates) {
    const email = normalizeEmail(candidate.createAcf.email_1);
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(candidate);
  }

  const members = [];
  const quarantined = [];
  for (const [email, grouped] of byEmail) {
    if (!email) {
      grouped.forEach((candidate) => quarantined.push({ candidate, reason: 'missing_email' }));
      continue;
    }
    if (!isValidLapostaEmail(email)) {
      grouped.forEach((candidate) => quarantined.push({ candidate, reason: 'invalid_email' }));
      continue;
    }
    if (grouped.length > 1) {
      grouped.forEach((candidate) => quarantined.push({ candidate, reason: 'duplicate_sponsit_email' }));
      continue;
    }
    const candidate = grouped[0];
    const businessclub = candidate.sponsorAcf.sponsor_pass_variant === 'businessclub';
    const personName = [candidate.createAcf.first_name, candidate.createAcf.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    members.push({
      sourceKey: candidate.sourceKey,
      email,
      custom_fields: {
        voornaam: candidate.createAcf.first_name,
        achternaam: candidate.createAcf.last_name,
        businessclub: businessclub ? 'Ja' : 'Nee',
        bedrijfsnaam: candidate.createAcf.company_name || personName,
        sponsorvariant: businessclub ? 'Businessclub AWC' : 'AWC Sponsor',
        sponsitcontactid: String(candidate.sponsitContactId),
        sponsitpersoonid: candidate.sponsitPersonId ? String(candidate.sponsitPersonId) : '',
        islid: memberSourceKeys.has(candidate.sourceKey) ? 'Ja' : 'Nee'
      }
    });
  }
  return { members, quarantined };
}

function isValidLapostaEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function validateLapostaFields(fields) {
  const available = new Set(fields.map((field) => String(field.custom_name || field.tag || '').toLowerCase()));
  return SPONSIT_LAPOSTA_FIELDS.filter((name) => !available.has(name));
}

function getMemberCustomField(member, name) {
  const fields = member.custom_fields || member.customFields || {};
  if (Array.isArray(fields)) {
    const found = fields.find((field) => String(field.custom_name || field.tag || '').toLowerCase() === name);
    return found?.value ?? '';
  }
  const value = fields[name];
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value ?? '';
}

function lapostaMemberMatches(member, desired) {
  return normalizeEmail(member.email || member.EmailAddress) === normalizeEmail(desired.email)
    && Object.entries(desired.custom_fields || {}).every(([name, value]) => (
      String(getMemberCustomField(member, name) ?? '').trim() === String(value ?? '').trim()
    ));
}

module.exports = {
  SPONSIT_LAPOSTA_FIELDS,
  buildSponsitLapostaPlan,
  validateLapostaFields,
  getMemberCustomField,
  isValidLapostaEmail,
  lapostaMemberMatches
};
