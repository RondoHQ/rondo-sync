require('dotenv/config');

const { openDb, getLatestSportlinkResults } = require('../lib/laposta-db');
const { normalizeEmail, isValidEmail, buildChildFullName, hasValue } = require('../lib/parent-dedupe');
const { createLoggerAdapter } = require('../lib/log-adapters');

/**
 * Build parent name from Sportlink NameParent field
 * Returns null if no name is available (skip this parent)
 * @param {Object} member - Sportlink member record
 * @param {number} parentIndex - 1 or 2
 * @returns {{first_name: string, last_name: string}|null}
 */
function buildParentName(member, parentIndex) {
  const nameField = parentIndex === 1 ? 'NameParent1' : 'NameParent2';
  const parentName = member[nameField];

  if (hasValue(parentName)) {
    return { first_name: String(parentName).trim(), last_name: '' };
  }

  // No name available - skip this parent (don't create placeholder records)
  return null;
}

/**
 * Build address from child's Sportlink record
 * @param {Object} member - Sportlink member record
 * @returns {Object|null} - Address object or null if no address
 */
function buildParentAddress(member) {
  const streetName = (member.StreetName || '').trim();
  const city = (member.City || '').trim();
  if (!streetName && !city) return null;

  return {
    address_label: 'Home',
    street_name: streetName,
    house_number: (member.AddressNumber || '').toString().trim(),
    house_number_addition: (member.AddressNumberAppendix || '').trim(),
    postal_code: (member.ZipCode || '').trim(),
    city: city,
    country: (member.CountryName || '').trim()
  };
}

/**
 * Build contact info array for parent
 * @param {string} email - Parent email
 * @param {Set} phones - Set of phone numbers
 * @returns {Array<{contact_type: string, contact_label: string, contact_value: string}>}
 */
function buildParentContactInfo(email, phones) {
  const contacts = [];
  if (email) contacts.push({ contact_type: 'email', contact_label: '', contact_value: email });
  phones.forEach(phone => {
    if (phone) contacts.push({ contact_type: 'phone', contact_label: '', contact_value: phone });
  });
  return contacts;
}

/**
 * Transform parent data to Rondo Club person format
 * @param {string} email - Parent email
 * @param {Object} data - Parent data (name, phones, address, childKnvbIds)
 * @returns {{email: string, childKnvbIds: Array, data: Object}}
 */
function prepareParent(email, data) {
  return {
    email: email,
    childKnvbIds: data.childKnvbIds,  // For relationship linking in sync phase
    data: {
      status: 'publish',
      acf: {
        first_name: data.name.first_name,
        last_name: data.name.last_name,
        contact_info: buildParentContactInfo(email, data.phones),
        addresses: data.address ? [data.address] : []
      }
    }
  };
}

/**
 * Prepare Rondo Club parents from Sportlink data
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @returns {Promise<{success: boolean, parents: Array, skipped: number, error?: string}>}
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
        return { success: false, parents: [], skipped: 0, error: errorMsg };
      }
      sportlinkData = JSON.parse(resultsJson);
    } finally {
      db.close();
    }

    const members = Array.isArray(sportlinkData.Members) ? sportlinkData.Members : [];
    logVerbose(`Found ${members.length} Sportlink members in database`);

    // Map to collect parent data: email -> { name, phones: Set, address, childKnvbIds: [] }
    const parentDataMap = new Map();

    members.forEach((member) => {
      [1, 2].forEach((parentIndex) => {
        const emailField = `EmailAddressParent${parentIndex}`;
        const phoneField = `TelephoneParent${parentIndex}`;
        const emailValue = member[emailField];

        // Skip if no email (can't dedupe without email)
        if (!isValidEmail(emailValue)) return;

        const normalized = normalizeEmail(emailValue);
        const phone = member[phoneField];

        // Skip if no email AND no phone
        if (!normalized && !hasValue(phone)) return;

        if (!parentDataMap.has(normalized)) {
          // First time seeing this parent - capture name and address
          const name = buildParentName(member, parentIndex);

          // Skip parents without a name in Sportlink
          if (!name) return;

          parentDataMap.set(normalized, {
            name: name,
            phones: new Set(),
            address: buildParentAddress(member), // Copy from child
            childKnvbIds: []
          });
        }

        const parentData = parentDataMap.get(normalized);

        // Collect phone numbers (may have multiple from different children)
        if (hasValue(phone)) {
          parentData.phones.add(String(phone).trim());
        }

        // Track child KNVB ID for relationship linking (avoid duplicates if same email in both parent fields)
        if (member.PublicPersonId && !parentData.childKnvbIds.includes(member.PublicPersonId)) {
          parentData.childKnvbIds.push(member.PublicPersonId);
        }
      });
    });

    // Convert Map to parent records
    const parents = [];
    parentDataMap.forEach((data, email) => {
      parents.push(prepareParent(email, data));
    });

    logVerbose(`Prepared ${parents.length} parents for Rondo Club sync (deduplicated by email)`);

    if (verbose && parents.length > 0) {
      logVerbose('Sample prepared parent:');
      logVerbose(JSON.stringify(parents[0], null, 2));
    }

    return {
      success: true,
      parents: parents,
      skipped: 0
    };
  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error preparing Rondo Club parents:', errorMsg);
    return { success: false, parents: [], skipped: 0, error: errorMsg };
  }
}

module.exports = { runPrepare };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');

  runPrepare({ verbose })
    .then(result => {
      if (!result.success) {
        process.exitCode = 1;
      } else if (!verbose) {
        // In default mode, print summary
        console.log(`Prepared ${result.parents.length} parents for Rondo Club sync`);
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
