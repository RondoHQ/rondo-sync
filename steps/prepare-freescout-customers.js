require('dotenv/config');

const { openDb: openRondoClubDb, getMemberFreeFieldsByKnvbId, getMemberWorkHistory } = require('../lib/rondo-club-db');
const { openDb: openFreescoutDb, getCustomerByKnvbId } = require('../lib/freescout-db');
const { createLoggerAdapter } = require('../lib/log-adapters');
const { readEnv, normalizeDateToYYYYMMDD } = require('../lib/utils');
const { rondoClubRequest, rondoClubRequestWithRetry } = require('../lib/rondo-club-client');

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
 * Get photo URL for a member (only if photo is synced to Rondo Club)
 * @param {Object} member - Member record from rondo_club_members
 * @param {Object} options - Options with logger and verbose
 * @returns {Promise<string|null>} - Photo URL or null
 */
async function getPhotoUrl(member, options = {}) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  // Only include photo URL if photo_state is 'synced'
  if (member.photo_state !== 'synced') {
    return null;
  }

  // Check if member has a WordPress post
  if (!member.rondo_club_id) {
    return null;
  }

  try {
    // Fetch person post with embedded media
    const response = await rondoClubRequest(
      `wp/v2/people/${member.rondo_club_id}?_embed`,
      'GET',
      null,
      { logger: options.logger, verbose: options.verbose }
    );

    // Extract photo URL from embedded media
    const photoUrl = response.body?._embedded?.['wp:featuredmedia']?.[0]?.source_url;

    // Validate URL starts with https://
    if (photoUrl && photoUrl.startsWith('https://')) {
      logVerbose(`  Photo URL found for ${member.knvb_id}: ${photoUrl}`);
      return photoUrl;
    }

    return null;
  } catch (error) {
    // Graceful degradation - log error but don't fail
    logVerbose(`  Photo URL fetch failed for ${member.knvb_id}: ${error.message}`);
    return null;
  }
}

/**
 * Get union teams (comma-separated) from work history
 * @param {Object} rondoClubDb - Rondo Club database connection
 * @param {string} knvbId - Member KNVB ID
 * @returns {string} - Comma-separated team names or empty string
 */
function getUnionTeams(rondoClubDb, knvbId) {
  const workHistory = getMemberWorkHistory(rondoClubDb, knvbId);
  if (!workHistory || workHistory.length === 0) {
    return '';
  }

  // Get unique team names from work history (including current and past)
  const teamNames = workHistory.map(wh => wh.team_name);
  // Remove duplicates and sort
  const uniqueTeams = [...new Set(teamNames)].sort();
  return uniqueTeams.join(', ');
}

/**
 * Validate and index the current Rondo contribution feed.
 * @param {Object} body - Response body from GET /rondo/v1/fees
 * @returns {{season: string, byPersonId: Map<number, Object>}}
 */
function parseRondoContributionFeed(body) {
  if (!body || !/^\d{4}-\d{4}$/.test(body.season) || !Array.isArray(body.members)) {
    throw new Error('Rondo contribution feed returned an invalid response');
  }

  const byPersonId = new Map();
  for (const member of body.members) {
    const personId = Number(member?.id);
    if (Number.isInteger(personId) && personId > 0) {
      byPersonId.set(personId, member);
    }
  }

  return { season: body.season, byPersonId };
}

/** Fetch current contribution data once for the complete FreeScout run. */
async function fetchRondoContributionFeed(options = {}, request = rondoClubRequestWithRetry) {
  const response = await request('rondo/v1/fees', 'GET', null, options);
  return parseRondoContributionFeed(response.body);
}

/**
 * Format one Rondo fee/invoice row for FreeScout's two contribution fields.
 * @param {Object|null} contribution - Rondo fee-list member row
 * @param {string} season - Current Rondo season
 * @returns {{outstanding: number|null, status: string|null}}
 */
function formatRondoContribution(contribution, season) {
  if (!contribution) {
    return { outstanding: null, status: null };
  }

  const invoiceStatus = contribution.invoice_status;
  const labels = {
    draft: 'Concept',
    sent: 'Openstaand',
    overdue: 'Achterstallig',
    paid: 'Betaald',
    cancelled: 'Vervallen'
  };
  let label = labels[invoiceStatus] || 'Nog niet gefactureerd';
  const installmentCount = Number(contribution.installment_count || 0);
  const paidInstallments = Number(contribution.paid_installments || 0);
  if (['sent', 'overdue'].includes(invoiceStatus) && installmentCount > 1) {
    label += ` (${paidInstallments}/${installmentCount} termijnen betaald)`;
  }

  const rawOutstanding = contribution.invoice_outstanding;
  const outstanding = rawOutstanding === null || rawOutstanding === undefined || rawOutstanding === ''
    ? null
    : Number(rawOutstanding);

  return {
    outstanding: Number.isFinite(outstanding) ? outstanding : null,
    status: `${season} · ${label}`
  };
}

/**
 * Transform a Rondo Club member to FreeScout customer format
 * @param {Object} member - Member record from rondo_club_members
 * @param {Object} freescoutDb - FreeScout database connection
 * @param {Object} rondoClubDb - Rondo Club database connection
 * @param {{season: string, byPersonId: Map<number, Object>}} contributionFeed - Current Rondo contribution data
 * @param {Object} options - Options with logger and verbose
 * @returns {Promise<Object|null>} - FreeScout customer object or null if no email
 */
async function prepareCustomer(member, freescoutDb, rondoClubDb, contributionFeed, options = {}) {
  const data = member.data || {};
  const fields = data.fields || {};

  let email = fields.email_1 || fields.email_2 || null;

  // Get FreeScout ID from tracking databases
  const freescoutId = getExistingFreescoutId(freescoutDb, rondoClubDb, member.knvb_id);

  // For members with empty data_json (former members whose Sportlink data was wiped),
  // fall back to the email from the DB column and existing freescout data for name/phone.
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

  const mobilePhone = fields.mobile_1 || fields.mobile_2 || fields.telephone_1 || null;

  let firstName = fields.first_name || '';
  let lastName = fields.last_name || '';
  let phones = [];
  if (mobilePhone) {
    phones.push({ type: 'mobile', value: mobilePhone });
  }

  // Use existing freescout data as fallback for name/phone
  if (existingFreescoutData) {
    if (!firstName) firstName = existingFreescoutData.firstName || '';
    if (!lastName) lastName = existingFreescoutData.lastName || '';
    if (phones.length === 0 && existingFreescoutData.phones) {
      phones = existingFreescoutData.phones;
    }
  }

  // Get union teams
  const unionTeams = getUnionTeams(rondoClubDb, member.knvb_id);

  // Get the current contribution and invoice status from Rondo Club.
  const contribution = formatRondoContribution(
    contributionFeed.byPersonId.get(Number(member.rondo_club_id)) || null,
    contributionFeed.season
  );

  // Get RelationEnd date
  const relationEndRaw = fields['lid_tot'] || null;
  const relationEnd = normalizeDateToYYYYMMDD(relationEndRaw);

  // Build websites array
  const websites = [];

  // Always include Sportlink URL (every member has a KNVB ID)
  websites.push({
    value: `https://club.sportlink.com/member/member-details/${member.knvb_id}/general`
  });

  // Include Rondo Club URL only if member has a WordPress post
  if (member.rondo_club_id) {
    const rondoUrl = readEnv('RONDO_URL').replace(/\/$/, ''); // Strip trailing slash
    websites.push({
      value: `${rondoUrl}/people/${member.rondo_club_id}`
    });
  }

  // Get photo URL asynchronously
  const photoUrl = await getPhotoUrl(member, options);

  return {
    knvb_id: member.knvb_id,
    email: email.toLowerCase(),
    freescout_id: freescoutId,
    data: {
      firstName,
      lastName,
      phones: phones,
      ...(photoUrl ? { photoUrl } : {}),
      websites: websites
    },
    customFields: {
      union_teams: unionTeams,
      public_person_id: member.knvb_id,
      member_since: fields['lid_sinds'] || null,
      contribution_outstanding: contribution.outstanding,
      contribution_status: contribution.status,
      relation_end: relationEnd
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
  let contributionFeed = null;

  try {
    // Open Rondo Club database
    rondoClubDb = openRondoClubDb();

    // Open FreeScout database
    freescoutDb = openFreescoutDb();

    // A failed Rondo read is fatal: never clear valid FreeScout finance fields
    // merely because the source API was temporarily unavailable.
    contributionFeed = await fetchRondoContributionFeed({ logger, verbose });
    logVerbose(`Loaded ${contributionFeed.byPersonId.size} Rondo contribution records for ${contributionFeed.season}`);

    // Get all tracked members from rondo_club_members
    const stmt = rondoClubDb.prepare(`
      SELECT knvb_id, email, data_json, rondo_club_id, photo_state
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
        photo_state: row.photo_state,
        data: JSON.parse(row.data_json)
      };

      const customer = await prepareCustomer(member, freescoutDb, rondoClubDb, contributionFeed, { logger, verbose });
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
  parseRondoContributionFeed,
  fetchRondoContributionFeed,
  formatRondoContribution
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
