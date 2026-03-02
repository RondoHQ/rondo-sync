require('dotenv/config');

const { chromium } = require('playwright');
const {
  openDb,
  getActiveTrackedMembers,
  upsertMemberFunctions,
  upsertMemberCommittees,
  upsertCommissies,
  clearMemberFunctions,
  clearMemberCommittees,
  upsertMemberFreeFields,
  clearMemberFreeFields,
  upsertMemberInvoiceData,
  clearMemberInvoiceData
} = require('../lib/rondo-club-db');
const { createSyncLogger } = require('../lib/logger');
const { loginToSportlink } = require('../lib/sportlink-login');
const { createLoggerAdapter, createDebugLogger } = require('../lib/log-adapters');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { parseMemberHeaderResponse } = require('../lib/photo-utils');

/**
 * Parse functions API response
 * Expected structure (may vary - needs validation against real response):
 * {
 *   MemberFunctions: {
 *     Function: [{ FunctionDescription, RelationStart, RelationEnd, Status }]
 *   },
 *   MemberCommittees: {
 *     Committee: [{ CommitteeId, CommitteeName, CommitteeFunctionName, RelationStart, RelationEnd, Status }]
 *   }
 * }
 */
function parseFunctionsResponse(data, knvbId) {
  const functions = [];
  const committees = [];

  // Parse member functions
  const memberFunctions = data?.MemberFunctions?.Function || data?.Function || [];
  const funcArray = Array.isArray(memberFunctions) ? memberFunctions : [memberFunctions].filter(Boolean);

  for (const func of funcArray) {
    if (func.FunctionDescription) {
      functions.push({
        knvb_id: knvbId,
        function_description: func.FunctionDescription,
        relation_start: func.RelationStart || null,
        relation_end: func.RelationEnd || null,
        is_active: func.Status === 'ACTIVE' || func.Status === 'Actief' || !func.RelationEnd
      });
    }
  }

  // Parse member committees
  const memberCommittees = data?.MemberCommittees?.Committee || data?.Committee || [];
  const commArray = Array.isArray(memberCommittees) ? memberCommittees : [memberCommittees].filter(Boolean);

  for (const comm of commArray) {
    if (comm.CommitteeName) {
      committees.push({
        knvb_id: knvbId,
        committee_name: comm.CommitteeName,
        sportlink_committee_id: comm.PublicCommitteeId || comm.CommitteeId || null,
        role_name: comm.CommitteeFunctionName || comm.FunctionDescription || null,
        relation_start: comm.RelationStart || null,
        relation_end: comm.RelationEnd || null,
        is_active: comm.Status === 'ACTIVE' || comm.Status === 'Actief' || !comm.RelationEnd
      });
    }
  }

  return { functions, committees };
}

/**
 * Parse MemberFreeFields API response
 * Extracts Remarks1..Remarks8 plus legacy typed fields:
 * - Remarks3 -> freescout_id
 * - Remarks8 -> vog_datum
 * @param {Object} data - MemberFreeFields API response
 * @param {string} knvbId - Member KNVB ID
 * @returns {{freescout_id: number|null, vog_datum: string|null, remark1: string|null, remark2: string|null, remark3: string|null, remark4: string|null, remark5: string|null, remark6: string|null, remark7: string|null, remark8: string|null}}
 */
function parseFreeFieldsResponse(data, knvbId) {
  const freeFields = data?.FreeFields || {};

  const getRemarkValue = (key) => {
    const value = freeFields?.[key]?.Value;
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed || null;
  };

  const remarkValues = {
    remark1: getRemarkValue('Remarks1'),
    remark2: getRemarkValue('Remarks2'),
    remark3: getRemarkValue('Remarks3'),
    remark4: getRemarkValue('Remarks4'),
    remark5: getRemarkValue('Remarks5'),
    remark6: getRemarkValue('Remarks6'),
    remark7: getRemarkValue('Remarks7'),
    remark8: getRemarkValue('Remarks8')
  };

  // Remarks3 = FreeScout ID (number)
  const remarks3 = remarkValues.remark3;
  const freescoutId = remarks3 ? parseInt(remarks3, 10) : null;

  // Remarks8 = VOG datum (date string, format may vary)
  const remarks8 = remarkValues.remark8;
  // Normalize date to YYYY-MM-DD if present
  let vogDatum = null;
  if (remarks8) {
    // Try to parse date - Sportlink may use various formats
    // Common formats: YYYY-MM-DD, DD-MM-YYYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(remarks8)) {
      vogDatum = remarks8;
    } else if (/^\d{2}-\d{2}-\d{4}$/.test(remarks8)) {
      // Convert DD-MM-YYYY to YYYY-MM-DD
      const [day, month, year] = remarks8.split('-');
      vogDatum = `${year}-${month}-${day}`;
    } else {
      // Store as-is if unknown format
      vogDatum = remarks8;
    }
  }

  return {
    knvb_id: knvbId,
    freescout_id: isNaN(freescoutId) ? null : freescoutId,
    vog_datum: vogDatum,
    ...remarkValues
  };
}

/**
 * Fetch member data from the /other tab (both FreeFields and MemberHeader APIs)
 * @param {Object} page - Playwright page object
 * @param {string} knvbId - Member KNVB ID
 * @param {Object} logger - Logger instance
 * @returns {Promise<{knvb_id: string, freescout_id: number|null, vog_datum: string|null, has_financial_block: number, photo_url: string|null, photo_date: string|null}|null>}
 */
async function fetchMemberDataFromOtherPage(page, knvbId, logger) {
  const otherUrl = `https://club.sportlink.com/member/member-details/${knvbId}/other`;

  // Set up promises BEFORE navigation (existing pattern)
  const freeFieldsPromise = page.waitForResponse(
    resp => resp.url().includes('/remarks/MemberFreeFields?'),
    { timeout: 15000 }
  ).catch(() => null);

  // NEW: Add MemberHeader promise in parallel
  const memberHeaderPromise = page.waitForResponse(
    resp => resp.url().includes('/member/MemberHeader?'),
    { timeout: 15000 }
  ).catch(() => null);

  logger.verbose(`  Navigating to ${otherUrl}...`);
  await page.goto(otherUrl, { waitUntil: 'networkidle' });

  // Await both responses
  const [freeFieldsResponse, memberHeaderResponse] = await Promise.all([
    freeFieldsPromise,
    memberHeaderPromise
  ]);

  // Parse FreeFields response
  let freeFieldsData = null;
  if (freeFieldsResponse && freeFieldsResponse.ok()) {
    try {
      freeFieldsData = await freeFieldsResponse.json();
    } catch (err) {
      logger.verbose(`  Error parsing MemberFreeFields: ${err.message}`);
    }
  }

  // Parse MemberHeader response
  let memberHeaderData = null;
  if (memberHeaderResponse && memberHeaderResponse.ok()) {
    try {
      memberHeaderData = await memberHeaderResponse.json();
    } catch (err) {
      logger.verbose(`  Error parsing MemberHeader: ${err.message}`);
    }
  }

  // Merge both data sources
  if (!freeFieldsData && !memberHeaderData) {
    logger.verbose(`  No API responses captured`);
    return null;
  }

  const freeFieldsResult = freeFieldsData ? parseFreeFieldsResponse(freeFieldsData, knvbId) : {
    knvb_id: knvbId,
    freescout_id: null,
    vog_datum: null,
    remark1: null,
    remark2: null,
    remark3: null,
    remark4: null,
    remark5: null,
    remark6: null,
    remark7: null,
    remark8: null
  };
  const memberHeaderResult = memberHeaderData ? parseMemberHeaderResponse(memberHeaderData, knvbId) : { has_financial_block: 0, photo_url: null, photo_date: null };

  logger.verbose(`  Financial block: ${memberHeaderResult.has_financial_block}, Photo: ${memberHeaderResult.photo_url ? 'yes' : 'no'}`);

  return {
    knvb_id: knvbId,
    freescout_id: freeFieldsResult.freescout_id,
    vog_datum: freeFieldsResult.vog_datum,
    remark1: freeFieldsResult.remark1,
    remark2: freeFieldsResult.remark2,
    remark3: freeFieldsResult.remark3,
    remark4: freeFieldsResult.remark4,
    remark5: freeFieldsResult.remark5,
    remark6: freeFieldsResult.remark6,
    remark7: freeFieldsResult.remark7,
    remark8: freeFieldsResult.remark8,
    has_financial_block: memberHeaderResult.has_financial_block,
    photo_url: memberHeaderResult.photo_url,
    photo_date: memberHeaderResult.photo_date
  };
}

/**
 * Parse MemberPaymentInvoiceAddress API response
 * @param {Object} data - API response
 * @returns {Object} - Parsed address fields
 */
function parseInvoiceAddressResponse(data) {
  const address = data?.Address || {};
  return {
    invoice_street: address.StreetName || null,
    invoice_house_number: address.AddressNumber ? String(address.AddressNumber) : null,
    invoice_house_number_addition: address.AddressNumberAppendix || null,
    invoice_postal_code: address.ZipCode || null,
    invoice_city: address.City || null,
    invoice_country: address.CountryName || null,
    invoice_address_is_default: address.IsDefault === true ? 1 : 0
  };
}

/**
 * Parse MemberPaymentInvoiceInformation API response
 * @param {Object} data - API response
 * @returns {Object} - Parsed invoice contact fields
 */
function parseInvoiceInfoResponse(data) {
  const info = data?.PaymentInvoiceInformation || {};
  return {
    invoice_last_name: info.LastName || null,
    invoice_infix: info.Infix || null,
    invoice_initials: info.Initials || null,
    invoice_email: info.EmailAddress || null,
    invoice_external_code: info.ExternalInvoiceCode || null
  };
}

/**
 * Fetch member financial/invoice data from the /financial tab
 * Captures MemberPaymentInvoiceAddress and MemberPaymentInvoiceInformation API responses
 * @param {Object} page - Playwright page object
 * @param {string} knvbId - Member KNVB ID
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object|null>} - Combined invoice data or null
 */
async function fetchMemberFinancialData(page, knvbId, logger) {
  const financialUrl = `https://club.sportlink.com/member/member-details/${knvbId}/financial`;

  // Set up promises BEFORE navigation to capture API responses
  const invoiceAddressPromise = page.waitForResponse(
    resp => resp.url().includes('/MemberPaymentInvoiceAddress'),
    { timeout: 15000 }
  ).catch(() => null);

  const invoiceInfoPromise = page.waitForResponse(
    resp => resp.url().includes('/MemberPaymentInvoiceInformation'),
    { timeout: 15000 }
  ).catch(() => null);

  logger.verbose(`  Navigating to ${financialUrl}...`);
  await page.goto(financialUrl, { waitUntil: 'networkidle' });

  // Await both responses
  const [addressResponse, infoResponse] = await Promise.all([
    invoiceAddressPromise,
    invoiceInfoPromise
  ]);

  // Parse invoice address response
  let addressData = null;
  if (addressResponse && addressResponse.ok()) {
    try {
      addressData = await addressResponse.json();
    } catch (err) {
      logger.verbose(`  Error parsing MemberPaymentInvoiceAddress: ${err.message}`);
    }
  }

  // Parse invoice info response
  let infoData = null;
  if (infoResponse && infoResponse.ok()) {
    try {
      infoData = await infoResponse.json();
    } catch (err) {
      logger.verbose(`  Error parsing MemberPaymentInvoiceInformation: ${err.message}`);
    }
  }

  // If no data captured, return null
  if (!addressData && !infoData) {
    logger.verbose(`  No financial API responses captured`);
    return null;
  }

  // Combine parsed data
  const addressParsed = addressData ? parseInvoiceAddressResponse(addressData) : {};
  const infoParsed = infoData ? parseInvoiceInfoResponse(infoData) : {};

  const result = {
    knvb_id: knvbId,
    ...addressParsed,
    ...infoParsed
  };

  // Log what we found
  const hasCustomAddress = result.invoice_address_is_default === 0;
  const hasEmail = !!result.invoice_email;
  const hasExternalCode = !!result.invoice_external_code;

  if (hasCustomAddress || hasEmail || hasExternalCode) {
    logger.verbose(`  Invoice data: custom address=${hasCustomAddress}, email=${hasEmail}, external code=${hasExternalCode}`);
  }

  return result;
}

/**
 * Fetch member general data (person, communication, address, parental info) from /general tab
 * @param {Object} page - Playwright page object
 * @param {string} knvbId - Member KNVB ID
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object|null>} - Flat member object in SearchMembers-style format, or null
 */
async function fetchMemberGeneralData(page, knvbId, logger) {
  const generalUrl = `https://club.sportlink.com/member/member-details/${knvbId}/general`;

  // Set up promises BEFORE navigation to capture API responses
  const personDataPromise = page.waitForResponse(
    resp => resp.url().includes('/member/persondata/MemberPersonData?'),
    { timeout: 15000 }
  ).catch(() => null);

  const communicationPromise = page.waitForResponse(
    resp => resp.url().includes('/member/persondata/MemberCommunication?'),
    { timeout: 15000 }
  ).catch(() => null);

  const addressesPromise = page.waitForResponse(
    resp => resp.url().includes('/member/persondata/MemberAddresses?'),
    { timeout: 15000 }
  ).catch(() => null);

  const parentalInfoPromise = page.waitForResponse(
    resp => resp.url().includes('/member/MemberParentalInfo?'),
    { timeout: 15000 }
  ).catch(() => null);

  logger.verbose(`  Navigating to ${generalUrl}...`);
  await page.goto(generalUrl, { waitUntil: 'networkidle' });

  const [personDataResponse, communicationResponse, addressesResponse, parentalInfoResponse] = await Promise.all([
    personDataPromise,
    communicationPromise,
    addressesPromise,
    parentalInfoPromise
  ]);

  // Parse responses
  let personData = null;
  if (personDataResponse && personDataResponse.ok()) {
    try { personData = await personDataResponse.json(); } catch (err) {
      logger.verbose(`  Error parsing MemberPersonData: ${err.message}`);
    }
  }

  let communicationData = null;
  if (communicationResponse && communicationResponse.ok()) {
    try { communicationData = await communicationResponse.json(); } catch (err) {
      logger.verbose(`  Error parsing MemberCommunication: ${err.message}`);
    }
  }

  let addressesData = null;
  if (addressesResponse && addressesResponse.ok()) {
    try { addressesData = await addressesResponse.json(); } catch (err) {
      logger.verbose(`  Error parsing MemberAddresses: ${err.message}`);
    }
  }

  let parentalInfoData = null;
  if (parentalInfoResponse && parentalInfoResponse.ok()) {
    try { parentalInfoData = await parentalInfoResponse.json(); } catch (err) {
      logger.verbose(`  Error parsing MemberParentalInfo: ${err.message}`);
    }
  }

  if (!personData && !communicationData && !addressesData && !parentalInfoData) {
    logger.verbose(`  No general API responses captured`);
    return null;
  }

  // Map to flat SearchMembers-style object
  const person = personData?.Person || {};
  const comm = communicationData?.Communication || {};
  const addr = Array.isArray(addressesData?.Address) ? addressesData.Address[0] || {} : addressesData?.Address || {};
  const parent = parentalInfoData || {};

  return {
    PublicPersonId: person.PublicPersonId || knvbId,
    FirstName: person.FirstName || null,
    Infix: person.Infix || null,
    LastName: person.LastName || null,
    GenderCode: person.GenderCode || null,
    DateOfBirth: person.DateOfBirth || null,
    MemberSince: person.MemberSince || null,
    DateOfPassing: person.DateOfPassing || null,
    TypeOfMemberDescription: person.TypeOfMemberDescription || null,
    Email: comm.Email1 || null,
    Email2: comm.Email2 || null,
    Mobile: comm.Mobile1 || null,
    Mobile2: comm.Mobile2 || null,
    Telephone: comm.Telephone1 || null,
    Telephone2: comm.Telephone2 || null,
    StreetName: addr.StreetName || null,
    AddressNumber: addr.AddressNumber || null,
    AddressNumberAppendix: addr.AddressNumberAppendix || null,
    ZipCode: addr.ZipCode || null,
    City: addr.City || null,
    CountryName: addr.CountryName || null,
    NameParent1: parent.NameParent1 || null,
    TelephoneParent1: parent.TelephoneParent1 || null,
    EmailAddressParent1: parent.EmailAddressParent1 || null,
    NameParent2: parent.NameParent2 || null,
    TelephoneParent2: parent.TelephoneParent2 || null,
    EmailAddressParent2: parent.EmailAddressParent2 || null
  };
}

/**
 * Fetch functions for a single member
 * Captures both MemberFunctions and MemberCommittees API responses
 */
async function fetchMemberFunctions(page, knvbId, logger) {
  const functionsUrl = `https://club.sportlink.com/member/member-details/${knvbId}/functions`;

  // Set up promises to wait for both responses
  // Use precise URL matching to avoid capturing UnionMemberFunctions instead of MemberFunctions
  const functionsPromise = page.waitForResponse(
    resp => resp.url().includes('/function/MemberFunctions?'),
    { timeout: 15000 }
  ).catch(() => null);

  const committeesPromise = page.waitForResponse(
    resp => resp.url().includes('/function/MemberCommittees?'),
    { timeout: 15000 }
  ).catch(() => null);

  logger.verbose(`  Navigating to ${functionsUrl}...`);
  await page.goto(functionsUrl, { waitUntil: 'networkidle' });

  // Wait for both responses (or timeout)
  const [functionsResponse, committeesResponse] = await Promise.all([
    functionsPromise,
    committeesPromise
  ]);

  // Parse the responses
  let functionsData = null;
  let committeesData = null;

  if (functionsResponse && functionsResponse.ok()) {
    try {
      functionsData = await functionsResponse.json();
    } catch (err) {
      logger.verbose(`  Error parsing MemberFunctions: ${err.message}`);
    }
  }

  if (committeesResponse && committeesResponse.ok()) {
    try {
      committeesData = await committeesResponse.json();
    } catch (err) {
      logger.verbose(`  Error parsing MemberCommittees: ${err.message}`);
    }
  }

  // Combine the responses
  if (functionsData || committeesData) {
    return {
      MemberFunctions: functionsData,
      MemberCommittees: committeesData
    };
  }

  logger.verbose(`  No API responses captured`);
  return null;
}

/**
 * Fetch team memberships for a single member from /memberships tab.
 * Ensures inactive memberships are included by toggling all showInactive checkboxes
 * and explicitly requesting MemberTeams with ShowInactive=true.
 * @param {Object} page - Playwright page object
 * @param {string} knvbId - Member KNVB ID
 * @param {Object} logger - Logger instance
 * @returns {Promise<Array>} Array of Team entries
 */
async function fetchMemberTeamMemberships(page, knvbId, logger) {
  const membershipsUrl = `https://club.sportlink.com/member/member-details/${knvbId}/memberships`;
  const memberTeamsUrl = `https://club.sportlink.com/member/team/MemberTeams?PublicPersonId=${encodeURIComponent(knvbId)}&ShowInactive=true`;

  logger.verbose(`  Navigating to ${membershipsUrl}...`);
  await page.goto(membershipsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Sportlink pages often keep background requests open; avoid strict networkidle waits.
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});

  // Click all "showInactive" toggles if present (some layouts render two toggles).
  const inactiveToggles = await page.$$('input[name="showInactive"]');
  for (const toggle of inactiveToggles) {
    try {
      const checked = await toggle.isChecked();
      if (!checked) {
        await toggle.click({ force: true });
      }
    } catch (err) {
      logger.verbose(`  Could not toggle showInactive checkbox: ${err.message}`);
    }
  }

  // Explicitly request the same endpoint the UI calls, with ShowInactive=true.
  const response = await page.request.get(memberTeamsUrl, {
    headers: { Accept: 'application/json' },
    timeout: 45000
  });
  if (!response.ok()) {
    throw new Error(`MemberTeams request failed (${response.status()} ${response.statusText()})`);
  }

  const contentType = (response.headers()['content-type'] || '').toLowerCase();
  const rawBody = await response.text();
  if (!contentType.includes('application/json')) {
    throw new Error(`MemberTeams returned non-JSON content-type (${contentType || 'unknown'})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    throw new Error(`MemberTeams JSON parse error: ${err.message}`);
  }

  const teams = Array.isArray(parsed?.Team) ? parsed.Team : [];
  logger.verbose(`  Found ${teams.length} team membership row(s)`);
  return teams;
}

/**
 * Fetch KNVB IDs of volunteers needing VOG from Rondo Club API.
 * These are people we're actively waiting on a change for, so we want to
 * check their Sportlink data daily regardless of LastUpdate.
 * @param {Object} logger - Logger instance
 * @returns {Promise<Set<string>>} Set of KNVB IDs
 */
async function fetchVogFilteredKnvbIds(logger) {
  const knvbIds = new Set();
  let page = 1;

  try {
    while (true) {
      const response = await rondoClubRequest(
        `rondo/v1/people/filtered?huidig_vrijwilliger=1&vog_missing=1&vog_older_than_years=3&per_page=100&page=${page}`,
        'GET',
        null,
        { logger }
      );

      const data = response.body;
      if (!data.people || data.people.length === 0) break;

      for (const person of data.people) {
        const knvbId = person.acf?.['knvb-id'];
        if (knvbId) knvbIds.add(String(knvbId));
      }

      if (page >= (data.total_pages || 1)) break;
      page++;
    }
  } catch (err) {
    logger.verbose(`Could not fetch VOG-filtered people from Rondo Club: ${err.message}`);
  }

  return knvbIds;
}

/**
 * Filter members to only those updated recently (by LastUpdate or PersonImageDate)
 * @param {Array} members - Array of tracked members [{knvb_id, rondo_club_id}]
 * @param {Map} memberDataMap - Map of knvb_id -> member data (includes LastUpdate, PersonImageDate)
 * @returns {Array} Filtered members
 */
function filterRecentlyUpdated(members, memberDataMap, days = 2) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return members.filter(member => {
    const memberData = memberDataMap.get(member.knvb_id);
    if (!memberData || !memberData.LastUpdate) {
      // If no LastUpdate data, include the member (safe fallback)
      return true;
    }

    // Parse LastUpdate field (format: "YYYY-MM-DD" or similar)
    const lastUpdate = new Date(memberData.LastUpdate);
    if (lastUpdate >= cutoff) return true;

    // Also include members with recent PersonImageDate (photo changed)
    if (memberData.PersonImageDate) {
      const imageDate = new Date(memberData.PersonImageDate);
      if (imageDate >= cutoff) return true;
    }

    return false;
  });
}

/**
 * Main download orchestration
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.withInvoice=false] - Also fetch invoice data from /financial tab (slow, run monthly)
 * @param {boolean} [options.recentOnly=true] - Only process members with recent updates
 * @param {number} [options.days=2] - Number of days back to consider for recent updates
 * @returns {Promise<{success: boolean, total: number, downloaded: number, functionsCount: number, committeesCount: number, errors: Array}>}
 */
async function runFunctionsDownload(options = {}) {
  const { logger: providedLogger, verbose = false, withInvoice = false, recentOnly = true, days = 2 } = options;
  const logger = providedLogger || createSyncLogger({ verbose });

  const result = {
    success: true,
    total: 0,
    downloaded: 0,
    functionsCount: 0,
    committeesCount: 0,
    freeFieldsCount: 0,
    invoiceDataCount: 0,
    skipped: 0,
    errors: []
  };

  const db = openDb();
  try {
    // Get all tracked members (those already synced to Rondo Club)
    let members = getActiveTrackedMembers(db);
    const allMembersCount = members.length;

    if (members.length === 0) {
      logger.log('No tracked members found. Run Rondo Club sync first.');
      return result;
    }

    // Filter members by LastUpdate if recentOnly is true
    if (recentOnly) {
      const { openDb: openLapostaDb, getLatestSportlinkResults } = require('../lib/laposta-db');
      const lapostaDb = openLapostaDb();
      let resultsJson;
      try {
        resultsJson = getLatestSportlinkResults(lapostaDb);
      } finally {
        lapostaDb.close();
      }

      if (resultsJson) {
        try {
          const resultsData = JSON.parse(resultsJson);
          const membersArray = resultsData.Members || [];

          // Build map of PublicPersonId -> member data (includes LastUpdate)
          const memberDataMap = new Map();
          membersArray.forEach(m => {
            if (m.PublicPersonId) {
              memberDataMap.set(String(m.PublicPersonId), m);
            }
          });

          const recentMembers = filterRecentlyUpdated(members, memberDataMap, days);
          const recentKnvbIds = new Set(recentMembers.map(m => m.knvb_id));

          // Also fetch VOG-filtered people from Rondo Club (volunteers we're waiting on)
          const vogKnvbIds = await fetchVogFilteredKnvbIds(logger);
          let vogAddedCount = 0;
          if (vogKnvbIds.size > 0) {
            // Add VOG members not already in the recent set
            for (const member of members) {
              if (!recentKnvbIds.has(member.knvb_id) && vogKnvbIds.has(member.knvb_id)) {
                recentMembers.push(member);
                recentKnvbIds.add(member.knvb_id);
                vogAddedCount++;
              }
            }
          }

          members = recentMembers;
          logger.log(`Processing ${members.length} of ${allMembersCount} members (${members.length - vogAddedCount} recent + ${vogAddedCount} VOG-filtered)`);
        } catch (err) {
          logger.verbose(`Error filtering members, processing all: ${err.message}`);
          logger.log(`Processing ${members.length} members (full sync)`);
        }
      } else {
        logger.verbose('No cached Sportlink results found, processing all members');
        logger.log(`Processing ${members.length} members (full sync)`);
      }
    } else {
      logger.log(`Processing ${members.length} members (full sync)`);
    }

    result.total = members.length;

    // NOTE: We no longer clear tables here at the start.
    // Tables are cleared atomically with upserts at the END of the download,
    // preventing race conditions where other syncs see empty tables mid-process.

    const logDebug = createDebugLogger();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    page.on('request', r => logDebug('>>', r.method(), r.url()));
    page.on('response', r => logDebug('<<', r.status(), r.url()));

    const allFunctions = [];
    const allCommittees = [];
    const allFreeFields = [];
    const allInvoiceData = [];
    const uniqueCommitteeNames = new Set();

    try {
      await loginToSportlink(page, { logger });

      // Process each member
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        logger.verbose(`Processing ${i + 1}/${members.length}: ${member.knvb_id}`);

        try {
          const data = await fetchMemberFunctions(page, member.knvb_id, logger);

          if (data) {
            const parsed = parseFunctionsResponse(data, member.knvb_id);

            if (parsed.functions.length > 0 || parsed.committees.length > 0) {
              allFunctions.push(...parsed.functions);
              allCommittees.push(...parsed.committees);

              // Collect unique committee names
              parsed.committees.forEach(c => uniqueCommitteeNames.add(c.committee_name));

              result.downloaded++;
              logger.verbose(`  Found ${parsed.functions.length} functions, ${parsed.committees.length} committees`);
            } else {
              result.skipped++;
              logger.verbose(`  No functions or committees found`);
            }
          } else {
            result.skipped++;
            logger.verbose(`  No data returned`);
          }

          // Fetch free fields and MemberHeader data from /other tab for ALL members
          // This captures VOG certificates, FreeScout IDs, and financial blocks
          // regardless of whether the member has functions/committees
          logger.verbose(`  Fetching member data from /other page...`);
          const memberData = await fetchMemberDataFromOtherPage(page, member.knvb_id, logger);
          const hasAnyRemark = memberData && [
            memberData.remark1, memberData.remark2, memberData.remark3, memberData.remark4,
            memberData.remark5, memberData.remark6, memberData.remark7, memberData.remark8
          ].some(Boolean);
          if (memberData && (memberData.freescout_id || memberData.vog_datum || memberData.has_financial_block || memberData.photo_url || hasAnyRemark)) {
            allFreeFields.push(memberData);
            logger.verbose(`  Found FreeScout ID: ${memberData.freescout_id || 'none'}, VOG datum: ${memberData.vog_datum || 'none'}, Financial block: ${memberData.has_financial_block}`);
          }

          // Fetch invoice data from /financial tab (only when --with-invoice flag is set)
          // This is slow (adds ~1-2s per member) so we run it monthly
          if (withInvoice) {
            logger.verbose(`  Fetching invoice data from /financial page...`);
            const invoiceData = await fetchMemberFinancialData(page, member.knvb_id, logger);
            if (invoiceData) {
              // Always store invoice data - we track is_default to know if custom address is set
              allInvoiceData.push(invoiceData);
            }
          }
        } catch (error) {
          result.errors.push({ knvb_id: member.knvb_id, message: error.message });
          logger.verbose(`  Error: ${error.message}`);
        }

        // Random delay between members to avoid rate limiting
        if (i < members.length - 1) {
          const delay = 500 + Math.random() * 1000;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    } finally {
      await browser.close();
    }

    // Store to database
    // Full sync: atomic clear + replace (ensures stale data is removed)
    // Recent-only: upsert only (preserve existing data for members not in this run)
    const storeResults = db.transaction(() => {
      if (!recentOnly) {
        // Full sync: clear all tables first
        clearMemberFunctions(db);
        clearMemberCommittees(db);
        clearMemberFreeFields(db);
        if (withInvoice) {
          clearMemberInvoiceData(db);
        }
      }

      if (allFunctions.length > 0) {
        upsertMemberFunctions(db, allFunctions);
      }
      result.functionsCount = allFunctions.length;

      if (allCommittees.length > 0) {
        upsertMemberCommittees(db, allCommittees);
      }
      result.committeesCount = allCommittees.length;

      if (allFreeFields.length > 0) {
        upsertMemberFreeFields(db, allFreeFields);
      }
      result.freeFieldsCount = allFreeFields.length;

      if (withInvoice && allInvoiceData.length > 0) {
        upsertMemberInvoiceData(db, allInvoiceData);
      }
      if (withInvoice) {
        result.invoiceDataCount = allInvoiceData.length;
      }
    });

    storeResults();

    // Create commissie records from unique committee names
    // Plus add "Verenigingsbreed" for club-level functions
    const commissies = [
      { commissie_name: 'Verenigingsbreed', sportlink_id: null }
    ];
    for (const name of uniqueCommitteeNames) {
      commissies.push({ commissie_name: name, sportlink_id: null });
    }

    if (commissies.length > 0) {
      upsertCommissies(db, commissies);
      logger.verbose(`Created/updated ${commissies.length} commissies`);
    }

    // Summary
    logger.log(`Downloaded functions for ${result.downloaded}/${result.total} members`);
    logger.log(`  Functions found: ${result.functionsCount}`);
    logger.log(`  Committee memberships found: ${result.committeesCount}`);
    logger.log(`  Unique commissies: ${commissies.length}`);
    logger.log(`  Free fields (VOG/FreeScout): ${result.freeFieldsCount}`);
    if (withInvoice) {
      logger.log(`  Invoice data records: ${result.invoiceDataCount}`);
    }

    if (result.errors.length > 0) {
      logger.log(`  Errors: ${result.errors.length}`);
      result.success = false;
    }

    return result;

  } finally {
    db.close();
  }
}

module.exports = {
  runFunctionsDownload,
  loginToSportlink,
  fetchMemberGeneralData,
  fetchMemberFunctions,
  fetchMemberTeamMemberships,
  fetchMemberDataFromOtherPage,
  fetchMemberFinancialData,
  parseFunctionsResponse,
  parseFreeFieldsResponse,
  parseInvoiceAddressResponse,
  parseInvoiceInfoResponse,
  filterRecentlyUpdated
};

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const withInvoice = process.argv.includes('--with-invoice');
  const all = process.argv.includes('--all');
  const daysIdx = process.argv.indexOf('--days');
  const days = daysIdx !== -1 ? parseInt(process.argv[daysIdx + 1], 10) || 2 : 2;
  runFunctionsDownload({ verbose, withInvoice, recentOnly: !all, days })
    .then(result => {
      if (!result.success) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
