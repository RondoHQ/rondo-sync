require('dotenv/config');

const { openDb, getLatestSportlinkResults } = require('../lib/laposta-db');
const {
  openDb: openRondoClubDb,
  getMemberFreeFieldsByKnvbId,
  getMemberInvoiceDataByKnvbId,
  getFreeFieldMappings
} = require('../lib/rondo-club-db');
const { createLoggerAdapter } = require('../lib/log-adapters');

/**
 * Map Sportlink gender codes to Rondo Club format
 * @param {string} sportlinkGender - Gender code from Sportlink (Male/Female)
 * @returns {string} - 'male', 'female', or empty string for unknown
 */
function mapGender(sportlinkGender) {
  const mapping = { 'Male': 'male', 'Female': 'female' };
  return mapping[sportlinkGender] || '';
}

/**
 * Extract birth year from date string
 * @param {string} dateOfBirth - Date in YYYY-MM-DD format
 * @returns {number|null} - Year as integer or null
 */
function extractBirthYear(dateOfBirth) {
  if (!dateOfBirth) return null;
  const year = parseInt(dateOfBirth.substring(0, 4), 10);
  return isNaN(year) ? null : year;
}

/**
 * Extract birthdate from date string
 * @param {string} dateOfBirth - Date in YYYY-MM-DD format
 * @returns {string|null} - Full date string or null if invalid
 */
function extractBirthdate(dateOfBirth) {
  if (!dateOfBirth) return null;
  const trimmed = dateOfBirth.trim();
  if (!trimmed.match(/^\d{4}-\d{2}-\d{2}$/)) return null;
  return trimmed;
}

function normalizeDate(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{2}-\d{2}-\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('-');
    return `${year}-${month}-${day}`;
  }
  return trimmed;
}

/**
 * Convert raw free-field value based on mapping type.
 * @param {string|null|undefined} value
 * @param {'string'|'number'|'date'|'boolean'} valueType
 * @returns {string|number|boolean|null}
 */
function convertMappedValue(value, valueType) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (valueType === 'number') {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  }

  if (valueType === 'date') {
    return normalizeDate(raw);
  }

  if (valueType === 'boolean') {
    const normalized = raw.toLowerCase();
    if (['1', 'true', 'yes', 'ja', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'nee', 'n'].includes(normalized)) return false;
    return null;
  }

  return raw;
}

/**
 * Apply configurable free-field mappings (Remarks1..Remarks8 -> ACF/meta field).
 * @param {Object} payload - Output payload with acf/meta objects
 * @param {Object} freeFields - Free fields row from DB
 * @param {Array<{source_field: string, target_field: string|null, target_scope: 'acf'|'meta', value_type: string}>} freeFieldMappings
 */
function applyMappedFreeFields(payload, freeFields, freeFieldMappings) {
  if (!freeFields || !Array.isArray(freeFieldMappings)) return;

  for (const mapping of freeFieldMappings) {
    const targetField = (mapping.target_field || '').trim();
    if (!targetField) continue;

    const sourceKey = String(mapping.source_field || '').toLowerCase(); // "remarks3"
    const rowKey = sourceKey.replace('remarks', 'remark'); // "remark3"
    const value = freeFields[rowKey];
    const converted = convertMappedValue(value, mapping.value_type || 'string');
    if (converted !== null) {
      const scope = mapping.target_scope === 'meta' ? 'meta' : 'acf';
      if (!payload[scope]) payload[scope] = {};
      payload[scope][targetField] = converted;
    }
  }
}

/**
 * Normalize comma-separated team names for stable storage.
 * Uses UnionTeams as primary source, with ClubTeams fallback.
 * @param {Object} member - Sportlink member record
 * @returns {string|null} - Comma-separated team names or null
 */
function extractTeams(member) {
  const rawValue = (member.UnionTeams || member.ClubTeams || '').trim();
  if (!rawValue) return null;

  const teams = rawValue
    .split(',')
    .map((team) => team.trim())
    .filter(Boolean);

  if (teams.length === 0) return null;
  return teams.join(', ');
}

/**
 * Build name fields, separating Dutch tussenvoegsel (infix) as its own field
 * @param {Object} member - Sportlink member record
 * @returns {{first_name: string, infix: string, last_name: string}}
 */
function buildName(member) {
  const firstName = (member.FirstName || '').trim();
  const infix = (member.Infix || '').trim().toLowerCase();
  const lastName = (member.LastName || '').trim();

  return {
    first_name: firstName,
    infix: infix,
    last_name: lastName
  };
}

/**
 * Build contact info array for ACF repeater
 * Only includes items where value is non-empty
 * @param {Object} member - Sportlink member record
 * @returns {Array<{contact_type: string, contact_label: string, contact_value: string}>}
 */
function buildContactInfo(member) {
  const contacts = [];
  const email = (member.Email || '').trim();
  const mobile = (member.Mobile || '').trim();
  const phone = (member.Telephone || '').trim();

  if (email) contacts.push({ contact_type: 'email', contact_label: '', contact_value: email });
  if (mobile) contacts.push({ contact_type: 'mobile', contact_label: '', contact_value: mobile });
  if (phone) contacts.push({ contact_type: 'phone', contact_label: '', contact_value: phone });

  return contacts;
}

/**
 * Build addresses array for ACF repeater
 * Only includes address if at least street or city present
 * @param {Object} member - Sportlink member record
 * @returns {Array<{address_label: string, street: string, postal_code: string, city: string, country: string}>}
 */
function buildAddresses(member) {
  const streetName = (member.StreetName || '').trim();
  const houseNumber = (member.AddressNumber || '').toString().trim();
  const houseNumberAppendix = (member.AddressNumberAppendix || '').trim();
  const city = (member.City || '').trim();

  // Omit empty address entirely
  if (!streetName && !city) return [];

  // Combine street name with house number and appendix
  const streetParts = [streetName, houseNumber].filter(Boolean);
  if (houseNumberAppendix) streetParts.push(houseNumberAppendix);
  const street = streetParts.join(' ');

  return [{
    address_label: '',
    street: street,
    postal_code: (member.ZipCode || '').trim(),
    city: city,
    country: 'Nederland'
  }];
}

/**
 * Format invoice address from invoice data
 * Combines street, house number, postal code, city into single formatted string
 * @param {Object} invoiceData - Invoice data from database
 * @returns {string} - Formatted address string or empty string if no data
 */
function formatInvoiceAddress(invoiceData) {
  const parts = [];

  // Build street with house number
  const streetParts = [invoiceData.invoice_street];
  if (invoiceData.invoice_house_number) {
    streetParts.push(invoiceData.invoice_house_number);
  }
  if (invoiceData.invoice_house_number_addition) {
    streetParts.push(invoiceData.invoice_house_number_addition);
  }
  const street = streetParts.filter(Boolean).join(' ');
  if (street) parts.push(street);

  // Add postal code and city
  const locationParts = [];
  if (invoiceData.invoice_postal_code) locationParts.push(invoiceData.invoice_postal_code);
  if (invoiceData.invoice_city) locationParts.push(invoiceData.invoice_city);
  const location = locationParts.join(' ');
  if (location) parts.push(location);

  // Add country if not Netherlands
  if (invoiceData.invoice_country && invoiceData.invoice_country !== 'Nederland') {
    parts.push(invoiceData.invoice_country);
  }

  return parts.join(', ');
}

/**
 * Transform a Sportlink member to Rondo Club person format
 * @param {Object} sportlinkMember - Raw Sportlink member record
 * @param {Object} [freeFields] - Optional free fields from Sportlink /other tab
 * @param {Object} [invoiceData] - Optional invoice data from Sportlink /financial tab
 * @returns {{knvb_id: string, email: string|null, person_image_date: string|null, data: Object}}
 */
function preparePerson(sportlinkMember, freeFields = null, invoiceData = null, freeFieldMappings = []) {
  const name = buildName(sportlinkMember);
  const gender = mapGender(sportlinkMember.GenderCode);
  const birthYear = extractBirthYear(sportlinkMember.DateOfBirth);
  const birthdate = extractBirthdate(sportlinkMember.DateOfBirth);
  const teams = extractTeams(sportlinkMember);

  const acf = {
    first_name: name.first_name,
    last_name: name.last_name,
    'knvb-id': sportlinkMember.PublicPersonId,
    contact_info: buildContactInfo(sportlinkMember),
    addresses: buildAddresses(sportlinkMember)
  };
  const payload = {
    acf: acf,
    meta: {
      team: teams || ''
    }
  };

  // Only add optional fields if they have values
  if (name.infix) acf.infix = name.infix;
  if (gender) acf.gender = gender;
  if (birthYear) acf.birth_year = birthYear;
  if (birthdate) acf.birthdate = birthdate;

  // Extract PersonImageDate for photo state tracking
  // Normalize to null if empty string or whitespace
  const personImageDate = (sportlinkMember.PersonImageDate || '').trim() || null;

  // Membership metadata fields
  const memberSince = (sportlinkMember.MemberSince || '').trim() || null;
  const relationEnd = (sportlinkMember.RelationEnd || '').trim() || null;
  const dateOfPassing = (sportlinkMember.DateOfPassing || '').trim() || null;
  const ageClass = (sportlinkMember.AgeClassDescription || '').trim() || null;
  const memberType = (sportlinkMember.TypeOfMemberDescription || '').trim() || null;

  if (memberSince) acf['lid-sinds'] = memberSince;
  if (relationEnd) acf['lid-tot'] = relationEnd;
  if (dateOfPassing) acf['datum-overlijden'] = dateOfPassing;
  if (ageClass) acf['leeftijdsgroep'] = ageClass;
  if (personImageDate) acf['datum-foto'] = personImageDate;
  if (memberType) acf['type-lid'] = memberType;

  // Free fields from Sportlink /other tab (FreeScout ID, VOG datum, financial block)
  if (freeFields) {
    applyMappedFreeFields(payload, freeFields, freeFieldMappings);
    // Financial block status (convert SQLite INTEGER 0/1 to boolean)
    // Explicitly check for 1 to treat null/undefined/0 as "not blocked"
    if (freeFields.has_financial_block !== undefined) {
      acf['financiele-blokkade'] = (freeFields.has_financial_block === 1);
    }
  }

  // Active members are explicitly marked as not former
  // (Members no longer in Sportlink are marked as former in separate step)
  acf.former_member = false;

  // Invoice data from Sportlink /financial tab
  // Only include if custom invoice address is set (not using member's default address)
  if (invoiceData) {
    // Check if a custom invoice address is set (is_default = 0 means custom address)
    if (invoiceData.invoice_address_is_default === 0) {
      const formattedAddress = formatInvoiceAddress(invoiceData);
      if (formattedAddress) {
        acf['factuur-adres'] = formattedAddress;
      }
    }
    // Invoice email (always include if present)
    if (invoiceData.invoice_email) {
      acf['factuur-email'] = invoiceData.invoice_email;
    }
    // External invoice code/reference (always include if present)
    if (invoiceData.invoice_external_code) {
      acf['factuur-referentie'] = invoiceData.invoice_external_code;
    }
  }

  return {
    knvb_id: sportlinkMember.PublicPersonId,
    email: (sportlinkMember.Email || '').trim().toLowerCase() || null,
    person_image_date: personImageDate,
    data: {
      status: 'publish',
      ...payload
    }
  };
}

/**
 * Validate member has required fields for Rondo Club sync
 * @param {Object} member - Sportlink member record
 * @returns {boolean}
 */
function isValidMember(member) {
  // PublicPersonId (KNVB ID) is required for matching
  if (!member.PublicPersonId) return false;
  // Must have at least a first name (required by Rondo Club API)
  if (!member.FirstName) return false;
  return true;
}

/**
 * Prepare Rondo Club members from Sportlink data
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @returns {Promise<{success: boolean, members: Array, skipped: number, error?: string}>}
 */
async function runPrepare(options = {}) {
  const { logger, verbose = false } = options;

  const { log, verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });

  try {
    // Load Sportlink data from SQLite
    const db = openDb();
    let sportlinkData;
    try {
      const resultsJson = getLatestSportlinkResults(db);
      if (!resultsJson) {
        const errorMsg = 'No Sportlink results found in SQLite. Run the download first.';
        logError(errorMsg);
        return { success: false, members: [], skipped: 0, error: errorMsg };
      }
      sportlinkData = JSON.parse(resultsJson);
    } finally {
      db.close();
    }

    const members = Array.isArray(sportlinkData.Members) ? sportlinkData.Members : [];
    logVerbose(`Found ${members.length} Sportlink members in database`);

    // Open Rondo Club DB to look up free fields
    const rondoClubDb = openRondoClubDb();
    const freeFieldMappings = getFreeFieldMappings(rondoClubDb);

    // Filter out invalid members and transform valid ones
    const validMembers = [];
    let skippedCount = 0;
    let freeFieldsCount = 0;
    let invoiceDataCount = 0;

    try {
      members.forEach((member, index) => {
        if (!isValidMember(member)) {
          skippedCount++;
          const reason = !member.PublicPersonId
            ? 'missing KNVB ID'
            : 'missing first name';
          logVerbose(`Skipping member at index ${index}: ${reason}`);
          return;
        }

        // Look up free fields (FreeScout ID, VOG datum) for this member
        const freeFields = getMemberFreeFieldsByKnvbId(rondoClubDb, member.PublicPersonId);
        if (freeFields && (freeFields.freescout_id || freeFields.vog_datum)) {
          freeFieldsCount++;
        }

        // Look up invoice data for this member
        const invoiceData = getMemberInvoiceDataByKnvbId(rondoClubDb, member.PublicPersonId);
        if (invoiceData && (invoiceData.invoice_email || invoiceData.invoice_address_is_default === 0)) {
          invoiceDataCount++;
        }

        const prepared = preparePerson(member, freeFields, invoiceData, freeFieldMappings);
        validMembers.push(prepared);
      });
    } finally {
      rondoClubDb.close();
    }

    logVerbose(`Prepared ${validMembers.length} members for Rondo Club sync (${skippedCount} skipped)`);
    if (freeFieldsCount > 0) {
      logVerbose(`  Including free fields for ${freeFieldsCount} members`);
    }
    if (invoiceDataCount > 0) {
      logVerbose(`  Including invoice data for ${invoiceDataCount} members`);
    }

    if (verbose && validMembers.length > 0) {
      logVerbose('Sample prepared member:');
      logVerbose(JSON.stringify(validMembers[0], null, 2));
    }

    return {
      success: true,
      members: validMembers,
      skipped: skippedCount
    };
  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error preparing Rondo Club members:', errorMsg);
    return { success: false, members: [], skipped: 0, error: errorMsg };
  }
}

module.exports = { runPrepare, preparePerson, isValidMember };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');

  runPrepare({ verbose })
    .then(result => {
      if (!result.success) {
        process.exitCode = 1;
      } else if (!verbose) {
        // In default mode, print summary
        console.log(`Prepared ${result.members.length} members for Rondo Club sync (${result.skipped} skipped - missing KNVB ID or first name)`);
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
