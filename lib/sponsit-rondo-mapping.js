const { normalizeDateToYYYYMMDD } = require('./utils');

const PASS_VARIANT_BUSINESSCLUB = 'businessclub';
const PASS_VARIANT_AWC_SPONSOR = 'awc_sponsor';

/**
 * Build dry-run Rondo sponsor candidates from a Sponsit contact snapshot.
 * No network writes happen here; this is the reviewable mapping boundary.
 */
function buildRondoSponsorCandidates(record) {
  const contact = record.contact || {};
  const people = Array.isArray(record.people) ? record.people : [];
  const subjects = people.length > 0 ? people : [null];
  const passVariant = deriveSponsorPassVariant(record);

  return subjects.map((person) => {
    const sourcePerson = person || contact;
    const isCompany = String(contact.type || '').toLowerCase() === 'company';
    const companyName = isCompany ? clean(contact.name) : '';
    const firstName = clean(sourcePerson.firstname);
    const lastName = clean(sourcePerson.lastname);
    const displayName = clean(sourcePerson.name) || clean(contact.name);

    const sponsorAcf = {
      is_sponsor: true,
      sponsor_pass_variant: passVariant,
      sponsit_contact_id: String(contact.id),
      sponsit_person_id: person?.id ? String(person.id) : ''
    };
    if (companyName) sponsorAcf.company_name = companyName;
    const createAcf = {
      ...sponsorAcf,
      person_type: 'contact',
      first_name: firstName,
      last_name: lastName,
      gender: mapGender(sourcePerson.gender),
      birthdate: normalizeDateToYYYYMMDD(sourcePerson.birthday),
      email_1: clean(sourcePerson.email1 || contact.email1),
      email_2: clean(sourcePerson.email2 || contact.email2),
      telephone_1: clean(sourcePerson.telephone1 || contact.telephone1),
      telephone_2: clean(sourcePerson.telephone2 || contact.telephone2),
      addresses: mapAddresses(record.addresses)
    };

    return {
      sourceKey: `sponsit:${contact.id}:${person?.id || 'contact'}`,
      sponsitContactId: Number(contact.id),
      sponsitPersonId: person?.id ? Number(person.id) : null,
      sponsitStatus: contact.status?.code || contact.status?.name || contact.status || null,
      sponsorAcf,
      createAcf,
      displayName
    };
  });
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
      const identifier = String(
        field?.identifier || field?.name || field?.key || ''
      ).toLowerCase();
      if (!identifier.includes('customfield_1') && !identifier.includes('bc sinds')) {
        return false;
      }
      return hasValue(field?.value ?? field?.pivot?.value ?? field?.content);
    });
  }
  if (typeof customfields === 'object') {
    for (const [key, value] of Object.entries(customfields)) {
      const normalizedKey = key.toLowerCase();
      if ((normalizedKey.includes('customfield_1') || normalizedKey.includes('bc_sinds'))
        && hasValue(value)) {
        return true;
      }
    }
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

function splitStreetAddress(value) {
  const address = clean(value);
  if (!address) return { streetName: '', houseNumber: '', addition: '' };
  const match = address.match(/^(.*?)\s+(\d+)(?:\s*[-/]?\s*([A-Za-z0-9-]+))?$/);
  if (!match) return { streetName: address, houseNumber: '', addition: '' };
  return {
    streetName: clean(match[1]),
    houseNumber: clean(match[2]),
    addition: clean(match[3])
  };
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

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'object') return Object.values(value).some(hasValue);
  return String(value).trim() !== '';
}

module.exports = {
  PASS_VARIANT_BUSINESSCLUB,
  PASS_VARIANT_AWC_SPONSOR,
  buildRondoSponsorCandidates,
  deriveSponsorPassVariant,
  mapAddresses,
  splitStreetAddress,
  mapGender
};
