const { normalizeDateOnly } = require('./utils');

const PASS_VARIANT_BUSINESSCLUB = 'businessclub';
const PASS_VARIANT_AWC_SPONSOR = 'awc_sponsor';

/**
 * Map one Sponsit company snapshot to one Rondo sponsor company and zero or
 * more real person candidates. Company-only records deliberately create no
 * placeholder person.
 */
function buildRondoSponsorCompanyCandidate(record) {
  const contact = record.contact || {};
  const people = Array.isArray(record.people) ? record.people : [];
  const sponsitContactId = Number(contact.id);
  const sponsorRole = deriveSponsorPassVariant(record);
  const title = clean(contact.name) || `Sponsit sponsor ${sponsitContactId}`;
  const address = mapSponsorAddress(record.addresses);

  return {
    sourceKey: `sponsit:${sponsitContactId}`,
    sponsitContactId,
    sponsitStatus: contact.status?.code || contact.status?.name || contact.status || null,
    title,
    status: 'publish',
    fields: {
      sponsor_role: sponsorRole,
      sponsit_contact_id: String(sponsitContactId),
      ...address
    },
    people: people.map((person, index) => buildPersonCandidate(person, contact, sponsitContactId, index))
  };
}

/** Compatibility helper for tooling that wants all mapped contact people. */
function buildRondoSponsorCandidates(record) {
  return buildRondoSponsorCompanyCandidate(record).people;
}

function buildPersonCandidate(person, contact, sponsitContactId, index) {
  const firstName = clean(person.firstname);
  const lastName = clean(person.lastname);
  const sponsitPersonId = person.id ? Number(person.id) : null;
  const sourceKey = sponsitPersonId
    ? `sponsit-person:${sponsitPersonId}`
    : `sponsit-contact:${sponsitContactId}:${index}`;
  const fields = {
    person_type: 'contact',
    first_name: firstName,
    last_name: lastName,
    email_1: clean(person.email1)
  };
  addIfPresent(fields, 'gender', mapGender(person.gender));
  addIfPresent(fields, 'birthdate', normalizeDateOnly(person.birthday));
  addIfPresent(fields, 'email_2', clean(person.email2));
  addIfPresent(fields, 'telephone_1', clean(person.telephone1));
  addIfPresent(fields, 'telephone_2', clean(person.telephone2));

  return {
    sourceKey,
    sponsitContactId,
    sponsitPersonId,
    displayName: clean(person.name) || [firstName, lastName].filter(Boolean).join(' ') || clean(contact.name),
    fields,
    relation: {
      contact_role: 'Contactpersoon',
      is_primary: index === 0,
      receives_pass: true,
      is_primary_pass: true,
      sponsit_person_id: sponsitPersonId ? String(sponsitPersonId) : ''
    }
  };
}

function deriveSponsorPassVariant(record) {
  const contact = record.contact || {};
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  const hasBusinessClubTag = tags.some((tag) => {
    const name = typeof tag === 'object' ? tag.name : tag;
    const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalized === 'bcawc' || normalized.includes('businessclub');
  });

  return hasBusinessClubTag || hasBusinessClubCustomField(contact.customfields)
    ? PASS_VARIANT_BUSINESSCLUB
    : PASS_VARIANT_AWC_SPONSOR;
}

function hasBusinessClubCustomField(customfields) {
  if (!customfields) return false;
  if (Array.isArray(customfields)) {
    return customfields.some((field) => {
      const identifier = String(field?.identifier || field?.name || field?.key || '').toLowerCase();
      if (!identifier.includes('customfield_1') && !identifier.includes('bc sinds')) return false;
      return hasValue(field?.value ?? field?.pivot?.value ?? field?.content);
    });
  }
  if (typeof customfields === 'object') {
    return Object.entries(customfields).some(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      return (normalizedKey.includes('customfield_1') || normalizedKey.includes('bc_sinds')) && hasValue(value);
    });
  }
  return false;
}

function mapAddresses(addresses) {
  if (!Array.isArray(addresses)) return [];
  return addresses.map((address, index) => {
    const parsed = splitStreetAddress(address.address);
    return {
      address_label: address.is_mailing ? 'Postadres' : (index === 0 ? 'Hoofdadres' : 'Adres'),
      street_name: parsed.streetName,
      house_number: parsed.houseNumber,
      house_number_addition: parsed.addition,
      postal_code: clean(address.postcode),
      city: clean(address.city),
      state: '',
      country: '',
      country_code: clean(address.country_code || 'NL').toUpperCase()
    };
  });
}

function mapSponsorAddress(addresses) {
  const mapped = mapAddresses(addresses);
  if (!mapped.length) return {};
  const address = mapped.find((item) => item.address_label === 'Hoofdadres') || mapped[0];
  return {
    address_street_name: address.street_name,
    address_house_number: address.house_number,
    address_house_number_addition: address.house_number_addition,
    address_postal_code: address.postal_code,
    address_city: address.city,
    address_country: address.country,
    address_country_code: address.country_code
  };
}

function splitStreetAddress(value) {
  const address = clean(value);
  if (!address) return { streetName: '', houseNumber: '', addition: '' };
  const match = address.match(/^(.*?)\s+(\d+)(?:\s*[-/]?\s*([A-Za-z0-9-]+))?$/);
  if (!match) return { streetName: address, houseNumber: '', addition: '' };
  return { streetName: clean(match[1]), houseNumber: clean(match[2]), addition: clean(match[3]) };
}

function mapGender(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['male', 'man', 'm', 'heer', 'dhr'].includes(normalized)) return 'male';
  if (['female', 'vrouw', 'v', 'mevrouw', 'mevr'].includes(normalized)) return 'female';
  if (['non_binary', 'non-binary', 'nonbinary'].includes(normalized)) return 'non_binary';
  return '';
}

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function addIfPresent(target, key, value) {
  if (value !== '' && value !== null && value !== undefined) target[key] = value;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'object') return Object.values(value).some(hasValue);
  return String(value).trim() !== '';
}

module.exports = {
  PASS_VARIANT_BUSINESSCLUB,
  PASS_VARIANT_AWC_SPONSOR,
  buildRondoSponsorCompanyCandidate,
  buildRondoSponsorCandidates,
  deriveSponsorPassVariant,
  mapAddresses,
  mapSponsorAddress,
  splitStreetAddress,
  mapGender
};
