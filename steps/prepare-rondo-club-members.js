require('dotenv/config');

const { openDb, getLatestSportlinkResults } = require('../lib/laposta-db');
const {
  openDb: openRondoClubDb,
  getMemberFreeFieldsByKnvbId,
  getMemberInvoiceDataByKnvbId,
  getFreeFieldMappings
} = require('../lib/rondo-club-db');
const { createLoggerAdapter } = require('../lib/log-adapters');
const { normalizePhone } = require('../lib/phone-normalizer');
const { READ_ONLY_OR_UNREGISTERED_PERSON_FIELDS } = require('../lib/canonical-fields');

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

/**
 * Derive a KNVB youth age class from a birthdate and season boundary.
 * The KNVB season starts on 1 July and is named after its ending year, so a
 * player born in 2019 is Onder 8 throughout the 2026/27 season.
 *
 * Only youth classes Onder 6 through Onder 19 are derived. Adult and special
 * categories remain owned by Sportlink.
 *
 * @param {string|null} dateOfBirth - Date in YYYY-MM-DD format
 * @param {Date} referenceDate - Date used to determine the current KNVB season
 * @returns {string|null} Derived age class or null outside the youth range
 */
function deriveYouthAgeClass(dateOfBirth, referenceDate = new Date()) {
  const birthdate = extractBirthdate(dateOfBirth);
  if (!birthdate || !(referenceDate instanceof Date) || Number.isNaN(referenceDate.getTime())) {
    return null;
  }

  const birthYear = Number(birthdate.slice(0, 4));
  const seasonEndYear = referenceDate.getUTCFullYear() + (referenceDate.getUTCMonth() >= 6 ? 1 : 0);
  const ageClassNumber = seasonEndYear - birthYear;

  if (ageClassNumber < 6 || ageClassNumber > 19) return null;
  return `Onder ${ageClassNumber}`;
}

/**
 * Resolve Sportlink's age class with a birthdate-based youth fallback.
 *
 * @param {Object} member - Raw Sportlink member record
 * @param {Date} referenceDate - Date used to determine the current KNVB season
 * @returns {{value: string|null, correction: string|null}}
 */
function resolveAgeClass(member, referenceDate = new Date()) {
  const sourceValue = (member.AgeClassDescription || '').trim() || null;
  const derivedValue = deriveYouthAgeClass(member.DateOfBirth, referenceDate);

  if (!derivedValue) return { value: sourceValue, correction: null };
  if (!sourceValue) {
    return {
      value: derivedValue,
      correction: `Sportlink omitted AgeClassDescription; derived ${derivedValue} from ${member.DateOfBirth}`
    };
  }

  const youthMatch = sourceValue.match(/^Onder (\d{1,2})$/i);
  const sourceNumber = youthMatch ? Number(youthMatch[1]) : null;
  if (sourceNumber !== null && sourceNumber >= 6 && sourceNumber <= 19 && sourceValue !== derivedValue) {
    return {
      value: derivedValue,
      correction: `Sportlink returned ${sourceValue}; derived ${derivedValue} from ${member.DateOfBirth}`
    };
  }

  return { value: sourceValue, correction: null };
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
 * Apply configurable free-field mappings (Remarks1..Remarks8 -> native field/meta field).
 * @param {Object} payload - Output payload with fields/meta objects
 * @param {Object} freeFields - Free fields row from DB
 * @param {Array<{source_field: string, target_field: string|null, target_scope: 'fields'|'meta', value_type: string}>} freeFieldMappings
 */
function applyMappedFreeFields(payload, freeFields, freeFieldMappings) {
  if (!freeFields || !Array.isArray(freeFieldMappings)) return;

  for (const mapping of freeFieldMappings) {
    const targetField = (mapping.target_field || '').trim();
    if (!targetField) continue;
    if (mapping.target_scope !== 'meta' && READ_ONLY_OR_UNREGISTERED_PERSON_FIELDS.has(targetField)) continue;

    const sourceKey = String(mapping.source_field || '').toLowerCase(); // "remarks3"
    const rowKey = sourceKey.replace('remarks', 'remark'); // "remark3"
    const value = freeFields[rowKey];
    const converted = convertMappedValue(value, mapping.value_type || 'string');
    if (converted !== null) {
      const scope = mapping.target_scope === 'meta' ? 'meta' : 'fields';
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
 * Build fixed contact fields object for native field.
 * Maps Sportlink API field names to the 6 fixed native field contact fields.
 * Phone numbers are normalized to E.164 format.
 * @param {Object} member - Sportlink member record
 * @returns {Object} Object with email_1, email_2, mobile_1, mobile_2, telephone_1, telephone_2
 */
function buildFixedContactFields(member) {
  return {
    email_1: (member.Email || '').trim() || null,
    email_2: (member.EmailAlternative || '').trim() || null,
    mobile_1: normalizePhone((member.Mobile || '').trim()) || null,
    mobile_2: normalizePhone((member.MobileAlternative || '').trim()) || null,
    telephone_1: normalizePhone((member.Telephone || '').trim()) || null,
    telephone_2: normalizePhone((member.TelephoneAlternative || '').trim()) || null,
  };
}

/**
 * Build addresses array for native field repeater
 * Only includes address if at least street name or city present
 * @param {Object} member - Sportlink member record
 * @returns {Array<Object>}
 */
function buildAddresses(member) {
  const streetName = (member.StreetName || '').trim();
  const city = (member.City || '').trim();

  // Omit empty address entirely
  if (!streetName && !city) return [];

  return [{
    address_label: 'Home',
    street_name: streetName,
    house_number: (member.AddressNumber || '').toString().trim(),
    house_number_addition: (member.AddressNumberAppendix || '').trim(),
    postal_code: (member.ZipCode || '').trim(),
    city: city,
    country: (member.CountryName || '').trim(),
    country_code: (member.CountryCode || '').trim()
  }];
}

/**
 * Build invoice address as native field repeater row
 * @param {Object} invoiceData - Invoice data from database
 * @returns {Object|null} - Address repeater row or null if no data
 */
function buildInvoiceAddress(invoiceData) {
  const streetName = (invoiceData.invoice_street || '').trim();
  const city = (invoiceData.invoice_city || '').trim();

  if (!streetName && !city) return null;

  return {
    address_label: 'Factuur',
    street_name: streetName,
    house_number: (invoiceData.invoice_house_number || '').trim(),
    house_number_addition: (invoiceData.invoice_house_number_addition || '').trim(),
    postal_code: (invoiceData.invoice_postal_code || '').trim(),
    city: city,
    country: (invoiceData.invoice_country || '').trim()
  };
}

/**
 * Transform a Sportlink member to Rondo Club person format
 * @param {Object} sportlinkMember - Raw Sportlink member record
 * @param {Object} [freeFields] - Optional free fields from Sportlink /other tab
 * @param {Object} [invoiceData] - Optional invoice data from Sportlink /financial tab
 * @param {Object} [options]
 * @param {{log: Function}} [options.logger] - Logger for age-class corrections
 * @param {Date} [options.referenceDate] - Date used to determine the KNVB season
 * @returns {{knvb_id: string, email: string|null, person_image_date: string|null, data: Object}}
 */
function preparePerson(sportlinkMember, freeFields = null, invoiceData = null, freeFieldMappings = [], options = {}) {
  const name = buildName(sportlinkMember);
  const gender = mapGender(sportlinkMember.GenderCode);
  const birthdate = extractBirthdate(sportlinkMember.DateOfBirth);
  const teams = extractTeams(sportlinkMember);
  const ageClassResolution = resolveAgeClass(sportlinkMember, options.referenceDate || new Date());

  const fields = {
    first_name: name.first_name,
    last_name: name.last_name,
    'knvb_id': sportlinkMember.PublicPersonId,
    addresses: buildAddresses(sportlinkMember)
  };

  // Add fixed contact fields (email_1, email_2, mobile_1, mobile_2, telephone_1, telephone_2)
  const contactFields = buildFixedContactFields(sportlinkMember);
  for (const [key, value] of Object.entries(contactFields)) {
    if (value !== null) {
      fields[key] = value;
    }
  }
  const payload = {
    fields: fields,
    meta: {
      team: teams || ''
    }
  };

  // Only add optional fields if they have values
  if (name.infix) fields.infix = name.infix;
  if (gender) fields.gender = gender;
  if (birthdate) fields.birthdate = birthdate;

  // Extract PersonImageDate for photo state tracking
  // Normalize to null if empty string or whitespace
  const personImageDate = (sportlinkMember.PersonImageDate || '').trim() || null;

  // Membership metadata fields
  const memberSince = (sportlinkMember.MemberSince || '').trim() || null;
  const relationEnd = (sportlinkMember.RelationEnd || '').trim() || null;
  const dateOfPassing = (sportlinkMember.DateOfPassing || '').trim() || null;
  const ageClass = ageClassResolution.value;
  const memberType = (sportlinkMember.TypeOfMemberDescription || '').trim() || null;
  const hasGameActivities = Object.prototype.hasOwnProperty.call(sportlinkMember, 'KernelGameActivities');
  const gameActivities = hasGameActivities
    ? (sportlinkMember.KernelGameActivities || '').trim().replace(/\s{2,}/g, ' ') || null
    : undefined;
  const tooltip = (sportlinkMember.Tooltip || '').trim();

  if (memberSince) fields['lid_sinds'] = memberSince;
  // Always include lid-tot so previously set values are cleared when a member rejoins.
  fields['lid_tot'] = relationEnd || null;
  // Always include the source-owned death date so a corrected Sportlink value
  // can clear a previously stored date in Rondo Club.
  fields['datum_overlijden'] = dateOfPassing;
  if (ageClass) fields['leeftijdsgroep'] = ageClass;
  if (ageClassResolution.correction && options.logger?.log) {
    options.logger.log(`Age-class correction for ${sportlinkMember.PublicPersonId}: ${ageClassResolution.correction}`);
  }
  if (personImageDate) fields['datum_foto'] = personImageDate;
  if (memberType) fields['type_lid'] = memberType;
  // An explicitly empty Sportlink value clears stale activity. Partial source
  // responses, such as the individual /general fetch, omit this property and
  // must not be interpreted as an empty value.
  if (hasGameActivities) fields['spelactiviteit'] = gameActivities;

  // Sportlink Tooltip "Actie van een ander (overschrijving)" marks members who
  // were transferred in from another club and still need their KNVB transfer
  // processed — they show up in Sportlink (and thus get synced to Rondo) but
  // have no voetbalactiviteit yet. Always write the field so it clears once
  // the transfer is processed.
  fields['wacht_op_overschrijving'] = /overschrijving/i.test(tooltip);

  // Free fields from Sportlink /other tab (FreeScout ID, VOG datum, financial block)
  if (freeFields) {
    applyMappedFreeFields(payload, freeFields, freeFieldMappings);
    // Financial block status (convert SQLite INTEGER 0/1 to boolean)
    // Explicitly check for 1 to treat null/undefined/0 as "not blocked"
    if (freeFields.has_financial_block !== undefined) {
      fields['financiele_blokkade'] = (freeFields.has_financial_block === 1);
    }
  }

  // Individual refreshes can still open a person after Sportlink has changed
  // their member type. Reflect that transition immediately instead of waiting
  // for the separate former-member import.
  fields.former_member = ['Oud bondslid', 'Oud verenigingslid'].includes(memberType);

  // Invoice data from Sportlink /financial tab
  if (invoiceData) {
    // Add invoice address to addresses repeater if custom address is set
    if (invoiceData.invoice_address_is_default === 0) {
      const invoiceAddress = buildInvoiceAddress(invoiceData);
      if (invoiceAddress) {
        fields.addresses.push(invoiceAddress);
      }
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

        const prepared = preparePerson(member, freeFields, invoiceData, freeFieldMappings, { logger: { log } });
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

module.exports = { runPrepare, preparePerson, isValidMember, deriveYouthAgeClass, resolveAgeClass };

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
