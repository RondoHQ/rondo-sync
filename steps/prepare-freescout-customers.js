require('dotenv/config');

const { openDb: openRondoClubDb, getMemberFreeFieldsByKnvbId } = require('../lib/rondo-club-db');
const { openDb: openFreescoutDb, getCustomerByKnvbId } = require('../lib/freescout-db');
const { createLoggerAdapter } = require('../lib/log-adapters');

/**
 * Get existing FreeScout ID for a member
 * First checks freescout_customers table (authoritative), then sportlink_member_free_fields (secondary)
 * @param {Object} freescoutDb - FreeScout database connection
 * @param {Object} rondoClubDb - Rondo Club database connection
 * @param {string} knvbId - Member KNVB ID
 * @returns {number|null} - FreeScout customer ID or null
 */
function getExistingFreescoutId(freescoutDb, rondoClubDb, knvbId) {
  // First check our authoritative tracking database
  const trackedCustomer = getCustomerByKnvbId(freescoutDb, knvbId);
  if (trackedCustomer && trackedCustomer.freescout_id) {
    return trackedCustomer.freescout_id;
  }

  // Fall back to Sportlink free fields (for initial seeding)
  const freeFields = getMemberFreeFieldsByKnvbId(rondoClubDb, knvbId);
  if (freeFields && freeFields.freescout_id) {
    return freeFields.freescout_id;
  }

  return null;
}

/**
 * Transform a Rondo Club member to FreeScout customer format
 * @param {Object} member - Member record from rondo_club_members
 * @param {Object} freescoutDb - FreeScout database connection
 * @param {Object} rondoClubDb - Rondo Club database connection
 * @returns {Promise<Object|null>} - FreeScout customer object or null if no email
 */
async function prepareCustomer(member, freescoutDb, rondoClubDb) {
  const data = member.data || {};
  const fields = data.fields || {};

  let email = fields.email_1 || fields.email_2 || null;

  // Get FreeScout ID from tracking databases
  const freescoutId = getExistingFreescoutId(freescoutDb, rondoClubDb, member.knvb_id);

  // For former members whose source data was wiped, preserve the tracked name and email.
  // Only do this when we already have a freescout record to preserve.
  let existingFreescoutData = null;
  if (!email && member.email && freescoutId) {
    email = member.email;
    const existing = getCustomerByKnvbId(freescoutDb, member.knvb_id);
    if (existing && existing.data) {
      existingFreescoutData = existing.data;
    }
  }

  // Skip members without email
  if (!email) {
    return null;
  }

  let firstName = fields.first_name || '';
  let lastName = fields.last_name || '';

  // Use existing FreeScout sync data only as a fallback for the name.
  if (existingFreescoutData) {
    if (!firstName) firstName = existingFreescoutData.firstName || '';
    if (!lastName) lastName = existingFreescoutData.lastName || '';
  }

  return {
    knvb_id: member.knvb_id,
    email: email.toLowerCase(),
    freescout_id: freescoutId,
    data: {
      firstName,
      lastName
    }
  };
}

/**
 * Prepare FreeScout customers from Sportlink/Rondo Club data
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @returns {Promise<{success: boolean, customers: Array, error?: string}>}
 */
async function runPrepare(options = {}) {
  const { logger, verbose = false } = options;

  const { verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });

  let rondoClubDb = null;
  let freescoutDb = null;
  try {
    // Open Rondo Club database
    rondoClubDb = openRondoClubDb();

    // Open FreeScout database
    freescoutDb = openFreescoutDb();

    // Get all tracked members from rondo_club_members
    const stmt = rondoClubDb.prepare(`
      SELECT knvb_id, email, data_json, rondo_club_id
      FROM rondo_club_members
      ORDER BY knvb_id ASC
    `);
    const memberRows = stmt.all();

    logVerbose(`Found ${memberRows.length} members in Rondo Club database`);

    // Transform each member
    const customers = [];
    let skippedNoEmail = 0;

    for (const row of memberRows) {
      const member = {
        knvb_id: row.knvb_id,
        email: row.email,
        rondo_club_id: row.rondo_club_id,
        data: JSON.parse(row.data_json)
      };

      const customer = await prepareCustomer(member, freescoutDb, rondoClubDb);
      if (customer) {
        customers.push(customer);
      } else {
        skippedNoEmail++;
      }
    }

    logVerbose(`Prepared ${customers.length} customers for FreeScout (${skippedNoEmail} skipped - no email)`);

    if (verbose && customers.length > 0) {
      logVerbose('Sample prepared customer:');
      logVerbose(JSON.stringify(customers[0], null, 2));
    }

    return {
      success: true,
      customers: customers
    };

  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error preparing FreeScout customers:', errorMsg);
    return { success: false, customers: [], error: errorMsg };
  } finally {
    // Close all database connections
    if (rondoClubDb) rondoClubDb.close();
    if (freescoutDb) freescoutDb.close();
  }
}

module.exports = {
  runPrepare,
  prepareCustomer
};

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const jsonOutput = process.argv.includes('--json');

  runPrepare({ verbose })
    .then(result => {
      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exitCode = 1;
      } else if (jsonOutput) {
        console.log(JSON.stringify(result.customers, null, 2));
      } else if (!verbose) {
        // In default mode, print summary
        console.log(`Prepared ${result.customers.length} customers for FreeScout`);
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
