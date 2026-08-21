const { buildRondoSponsorCompanyCandidate } = require('./sponsit-rondo-mapping');
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

function buildSponsitLapostaPlan(records, rondoPeople = [], rondoSponsors = []) {
  const companies = records.map(buildRondoSponsorCompanyCandidate);
  const rondoPlan = planRondoSponsorSync(records, rondoPeople, rondoSponsors);
  const entries = companies.flatMap((company) => company.people.map((person) => ({ company, person })));
  const byEmail = new Map();
  for (const entry of entries) {
    const email = normalizeEmail(entry.person.fields.email_1);
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(entry);
  }

  const members = [];
  const quarantined = [];
  for (const [email, grouped] of byEmail) {
    if (!email) {
      grouped.forEach((entry) => quarantined.push({ candidate: entry.person, reason: 'missing_email' }));
      continue;
    }
    if (!isValidLapostaEmail(email)) {
      grouped.forEach((entry) => quarantined.push({ candidate: entry.person, reason: 'invalid_email' }));
      continue;
    }

    const identities = new Set(grouped.map((entry) => (
      `${normalizeEmail(entry.person.fields.first_name)}|${normalizeEmail(entry.person.fields.last_name)}`
    )));
    if (identities.size > 1) {
      grouped.forEach((entry) => quarantined.push({ candidate: entry.person, reason: 'duplicate_sponsit_email' }));
      continue;
    }

    const entry = grouped.find((item) => item.company.fields.sponsor_role === 'businessclub') || grouped[0];
    const { company, person } = entry;
    const resolution = rondoPlan.resolvedPeople.get(person.sourceKey);
    const isMember = (resolution?.person?.fields?.person_type || 'contact') !== 'contact';
    const businessclub = company.fields.sponsor_role === 'businessclub';
    members.push({
      sourceKey: person.sourceKey,
      email,
      custom_fields: {
        voornaam: person.fields.first_name,
        achternaam: person.fields.last_name,
        businessclub: businessclub ? 'Ja' : 'Nee',
        bedrijfsnaam: company.title,
        sponsorvariant: businessclub ? 'Businessclub AWC' : 'AWC Sponsor',
        sponsitcontactid: String(company.sponsitContactId),
        sponsitpersoonid: person.sponsitPersonId ? String(person.sponsitPersonId) : '',
        islid: isMember ? 'Ja' : 'Nee'
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

/**
 * Only person-backed Sponsit rows are safe to remove automatically. Older
 * sync versions created company-email fallback rows without a Sponsit person
 * ID. The contact-only model no longer generates those rows, but that model
 * change must not silently unsubscribe them from Laposta.
 */
function shouldUnsubscribeSponsitMember(member, desiredEmails) {
  const email = normalizeEmail(member.email || member.EmailAddress);
  return Boolean(getMemberCustomField(member, 'sponsitcontactid'))
    && Boolean(getMemberCustomField(member, 'sponsitpersoonid'))
    && !desiredEmails.has(email);
}

module.exports = {
  SPONSIT_LAPOSTA_FIELDS,
  buildSponsitLapostaPlan,
  validateLapostaFields,
  getMemberCustomField,
  isValidLapostaEmail,
  lapostaMemberMatches,
  shouldUnsubscribeSponsitMember
};
