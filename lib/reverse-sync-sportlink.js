require('dotenv/config');

const { chromium } = require('playwright');
const { openDb, getUnsyncedContactChanges, markChangesSynced, updateSportlinkTimestamps, getUnsyncedChanges } = require('./rondo-club-db');
const { loginToSportlink } = require('./sportlink-login');
const { e164ToLocal } = require('./phone-normalizer');
const { rondoClubRequest } = require('./rondo-club-client');

/**
 * Mapping of Rondo Club field names to Sportlink form selectors with page context.
 * These selectors need verification against actual Sportlink UI.
 */
const SPORTLINK_FIELD_MAP = {
  // /general page (contact fields — renamed to match fixed ACF fields)
  // Keep old selectors as fallback for older UI variants.
  'email_1': { page: 'general', selector: 'input[name="Email1"], input[name="Email"]', type: 'text' },
  'email_2': { page: 'general', selector: 'input[name="Email2"]', type: 'text' },
  'mobile_1': { page: 'general', selector: 'input[name="Mobile1"], input[name="Mobile"]', type: 'text' },
  'mobile_2': { page: 'general', selector: 'input[name="Mobile2"]', type: 'text' },
  'telephone_1': { page: 'general', selector: 'input[name="Telephone1"], input[name="Phone"]', type: 'text' },
  'telephone_2': { page: 'general', selector: 'input[name="Telephone2"]', type: 'text' },

  // /other page (free fields from Phase 24)
  'freescout_id': { page: 'other', selector: 'input[name="Remarks3"]', type: 'text' },
  'datum_vog': { page: 'other', selector: 'input[name="inputRemarks8"], input[name="Remarks8"]', type: 'text' },

  // /financial page (financial block from Phase 24)
  'financiele_blokkade': { page: 'financial', selector: 'input[name="HasFinancialTransferBlockOwnClub"]', type: 'checkbox' },

  // /general page — address section (Wijzig button index 3)
  'street_name': { page: 'address', selector: 'input[name="StreetName"]', type: 'text' },
  'house_number': { page: 'address', selector: 'input[name="AddressNumber"]', type: 'text' },
  'house_number_addition': { page: 'address', selector: 'input[name="AddressNumberAppendix"]', type: 'text' },
  'postal_code': { page: 'address', selector: 'input[name="ZipCode"]', type: 'text' },
  'city': { page: 'address', selector: 'input[name="City"]', type: 'text' },
  'country_code': { page: 'address', selector: 'select[name="CountryCode"]', type: 'select' }
};

/**
 * Page URL suffixes for Sportlink member pages.
 */
const PAGE_URLS = {
  'general': '/general',
  'address': '/general',  // address section is on the /general page, different Wijzig button
  'other': '/other',
  'financial': '/financial'
};

const EDIT_BUTTON_SELECTORS_FALLBACK = [
  'button:has-text("Wijzig")',
  'button[data-action="edit"]',
  '.edit-button',
  '#btnEdit',
  'button:has-text("Bewerken")',
  'button:has-text("Edit")',
  'a:has-text("Bewerken")',
  '[aria-label*="Bewerk"]',
  '[aria-label*="Edit"]'
];

const SAVE_BUTTON_SELECTORS = [
  'button:has-text("Sla op")',
  'button:has-text("Opslaan")',
  'button[type="submit"]',
  'button[data-action="save"]',
  '.save-button',
  '#btnSave'
];

function getMemberPageUrl(knvbId, pageType) {
  return `https://club.sportlink.com/member/member-details/${knvbId}${PAGE_URLS[pageType]}`;
}

async function enterEditMode(page, pageType = 'general', expectedSelector = null) {
  const attempts = [];

  // Sportlink UI has multiple "Wijzig" buttons per page. Index 0 is always
  // "Wijzig lidsoort" in the header (added ~2026-03-09).
  // /general indices: 0=lidsoort, 1=personal, 2=communication, 3=address, 4=parental, 5=nationality
  // /other indices:   0=lidsoort, 1=vrije invoervelden, 2=vrije invoervelden bij aanmelding, 3=notities
  // /financial:       0=lidsoort, 1=first section, 2+...
  if (pageType === 'general') {
    attempts.push({ type: 'wijzig-index', index: 2, label: 'button:has-text("Wijzig")[2]' });
  }

  if (pageType === 'address') {
    attempts.push({ type: 'wijzig-index', index: 3, label: 'button:has-text("Wijzig")[3]' });
  }

  if (pageType === 'other') {
    attempts.push({ type: 'wijzig-index', index: 1, label: 'button:has-text("Wijzig")[1]' });
  }

  if (pageType === 'financial') {
    attempts.push({ type: 'wijzig-index', index: 1, label: 'button:has-text("Wijzig")[1]' });
  }

  for (const selector of EDIT_BUTTON_SELECTORS_FALLBACK) {
    attempts.push({ type: 'selector', selector, label: selector });
  }

  for (const attempt of attempts) {
    let clickLabel = attempt.label;

    if (attempt.type === 'wijzig-index') {
      const buttons = page.locator('button:has-text("Wijzig")');
      const count = await buttons.count();
      if (count <= attempt.index) {
        continue;
      }
      try {
        const button = buttons.nth(attempt.index);
        await button.waitFor({ state: 'visible', timeout: 3000 });
        await button.click();
      } catch (error) {
        continue;
      }
    } else {
      const selector = attempt.selector;
      const button = page.locator(selector).first();
      if (await button.count() === 0) {
        continue;
      }
      try {
        await button.waitFor({ state: 'visible', timeout: 3000 });
        await button.click();
      } catch (error) {
        continue;
      }
    }

    await page.waitForLoadState('networkidle');
    if (!expectedSelector) {
      return clickLabel;
    }

    try {
      await page.waitForSelector(expectedSelector, { timeout: 2000 });
      return clickLabel;
    } catch (error) {
      // Clicked the wrong editable section; keep trying.
    }
  }

  throw new Error(`Could not find edit button for ${pageType} page`);
}

async function clickSaveButton(page) {
  for (const selector of SAVE_BUTTON_SELECTORS) {
    try {
      const button = page.locator(selector).first();
      if (await button.count() === 0) {
        continue;
      }
      await button.waitFor({ state: 'visible', timeout: 3000 });
      await button.click();
      return selector;
    } catch (error) {
      // Try next selector.
    }
  }

  throw new Error(`Could not find save button with selectors: ${SAVE_BUTTON_SELECTORS.join(', ')}`);
}

/**
 * Sync a single member's contact fields to Sportlink (single page - /general).
 * Backwards compatible with Phase 23 - only handles contact fields on general page.
 * @param {Object} page - Playwright page instance
 * @param {string} knvbId - Member KNVB ID
 * @param {Array<Object>} fieldChanges - Array of field change objects
 * @param {Object} [options] - Options
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<void>}
 */
async function syncMemberToSportlink(page, knvbId, fieldChanges, options = {}) {
  const { logger } = options;

  // Navigate to member's general page
  const memberUrl = getMemberPageUrl(knvbId, 'general');
  logger?.verbose(`Navigating to member page: ${memberUrl}`);
  await page.goto(memberUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  // Enter edit mode (TODO: verify actual selector)
  logger?.verbose('Entering edit mode...');
  try {
    const expectedSelector = SPORTLINK_FIELD_MAP[fieldChanges[0]?.field_name]?.selector || null;
    await enterEditMode(page, 'general', expectedSelector);
  } catch (error) {
    throw new Error(`Could not enter edit mode: ${error.message}`);
  }

  // Wait for form to be editable
  await page.waitForLoadState('networkidle');

  // Fill each changed field
  for (const change of fieldChanges) {
    const fieldMapping = SPORTLINK_FIELD_MAP[change.field_name];
    if (!fieldMapping) {
      logger?.error(`No selector mapping for field: ${change.field_name}`);
      continue;
    }

    const selector = fieldMapping.selector;
    logger?.verbose(`Filling ${change.field_name}: ${change.new_value}`);
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.fill(selector, change.new_value || '');
    } catch (error) {
      throw new Error(`Could not find or fill field ${change.field_name} with selector: ${selector}`);
    }
  }

  // Save the form (TODO: verify actual selector)
  logger?.verbose('Saving changes...');
  try {
    await clickSaveButton(page);
  } catch (error) {
    throw new Error(`Could not save changes: ${error.message}`);
  }

  await page.waitForLoadState('networkidle');

  // Verify saved values by reading them back
  logger?.verbose('Verifying saved values...');
  for (const change of fieldChanges) {
    const fieldMapping = SPORTLINK_FIELD_MAP[change.field_name];
    if (!fieldMapping) continue;

    const selector = fieldMapping.selector;
    try {
      const savedValue = await page.inputValue(selector);
      if (savedValue !== (change.new_value || '')) {
        throw new Error(
          `Verification failed for ${change.field_name}: ` +
          `expected "${change.new_value}", got "${savedValue}"`
        );
      }
      logger?.verbose(`Verified ${change.field_name}: ${savedValue}`);
    } catch (error) {
      throw new Error(`Verification failed for ${change.field_name}: ${error.message}`);
    }
  }

  logger?.verbose(`Successfully synced ${fieldChanges.length} field(s) for member ${knvbId}`);
}

/**
 * Sync a member with retry logic and exponential backoff.
 * @param {Object} page - Playwright page instance
 * @param {string} knvbId - Member KNVB ID
 * @param {Array<Object>} fieldChanges - Array of field change objects
 * @param {Object} [options] - Options
 * @param {Object} [options.logger] - Logger instance
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @returns {Promise<{success: boolean, attempts: number, error?: string}>}
 */
async function syncMemberWithRetry(page, knvbId, fieldChanges, options = {}) {
  const { logger, maxRetries = 3 } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await syncMemberToSportlink(page, knvbId, fieldChanges, options);
      return { success: true, attempts: attempt + 1 };
    } catch (error) {
      if (attempt === maxRetries - 1) {
        return { success: false, attempts: attempt + 1, error: error.message };
      }
      const delay = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      logger?.verbose(`Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${error.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Run reverse sync from Rondo Club to Sportlink for contact fields.
 * @param {Object} [options] - Options
 * @param {boolean} [options.verbose=false] - Verbose logging
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<{success: boolean, synced: number, failed: number, results: Array}>}
 */
async function runReverseSync(options = {}) {
  const { logger, knvbId } = options;

  // Get credentials from environment
  const username = process.env.SPORTLINK_USERNAME;
  const password = process.env.SPORTLINK_PASSWORD;
  const otpSecret = process.env.SPORTLINK_OTP_SECRET;

  if (!username || !password) {
    throw new Error('Missing SPORTLINK_USERNAME or SPORTLINK_PASSWORD');
  }

  // Open database and get unsynced changes
  const db = openDb();
  const changes = getUnsyncedContactChanges(db);
  const filteredChanges = knvbId
    ? changes.filter(change => change.knvb_id === knvbId)
    : changes;

  if (filteredChanges.length === 0) {
    logger?.log('No unsynced contact field changes found');
    db.close();
    return { success: true, synced: 0, failed: 0, results: [] };
  }

  // Group changes by knvb_id
  const changesByMember = new Map();
  for (const change of filteredChanges) {
    if (!changesByMember.has(change.knvb_id)) {
      changesByMember.set(change.knvb_id, []);
    }
    changesByMember.get(change.knvb_id).push(change);
  }

  logger?.log(`Found ${filteredChanges.length} unsynced change(s) for ${changesByMember.size} member(s)`);

  // Launch browser and login
  let browser;
  const results = [];
  let synced = 0;
  let failed = 0;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // Login once at the start
    await loginToSportlink(page, { logger, credentials: { username, password, otpSecret } });

    // Process each member sequentially
    for (const [knvbId, memberChanges] of changesByMember) {
      logger?.verbose(`Processing member ${knvbId} with ${memberChanges.length} change(s)...`);

      const result = await syncMemberWithRetry(page, knvbId, memberChanges, { logger, maxRetries: 3 });

      if (result.success) {
        // Mark changes as synced in database
        const fieldNames = memberChanges.map(c => c.field_name);
        markChangesSynced(db, knvbId, fieldNames);

        // Update Sportlink modification timestamps
        updateSportlinkTimestamps(db, knvbId, fieldNames);
        logger?.verbose(`Updated Sportlink timestamps for ${knvbId}: ${fieldNames.join(', ')}`);

        synced++;
        logger?.log(`✓ Synced ${memberChanges.length} field(s) for member ${knvbId}`);
      } else {
        failed++;
        logger?.error(`✗ Failed to sync member ${knvbId}: ${result.error}`);
      }

      results.push({
        knvbId,
        success: result.success,
        attempts: result.attempts,
        fieldCount: memberChanges.length,
        error: result.error
      });

      // Add delay between members to avoid rate limiting
      const delay = 1000 + Math.random() * 1000; // 1-2 seconds
      await new Promise(r => setTimeout(r, delay));
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    db.close();
  }

  const success = failed === 0;
  logger?.log(`Reverse sync complete: ${synced} synced, ${failed} failed`);

  return { success, synced, failed, results };
}

/**
 * Group changes by member and by page.
 * @param {Array<Object>} changes - Array of change records
 * @returns {Map<string, Object>} - Map of knvb_id to { general: [], other: [], financial: [] }
 */
function groupChangesByMemberAndPage(changes) {
  const grouped = new Map();

  for (const change of changes) {
    const knvbId = change.knvb_id;
    const fieldMapping = SPORTLINK_FIELD_MAP[change.field_name];

    if (!fieldMapping) {
      // Unknown field, skip
      continue;
    }

    if (!grouped.has(knvbId)) {
      grouped.set(knvbId, { general: [], address: [], other: [], financial: [] });
    }

    const memberPages = grouped.get(knvbId);
    memberPages[fieldMapping.page].push(change);
  }

  return grouped;
}

/**
 * Navigate to a URL with session timeout detection.
 * If session has expired (redirected to login), re-authenticate and retry.
 * @param {Object} page - Playwright page instance
 * @param {string} url - Target URL
 * @param {Object} credentials - Login credentials
 * @param {Object} [options] - Options
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<void>}
 */
async function navigateWithTimeoutCheck(page, url, credentials, options = {}) {
  const { logger } = options;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  // Check if we were redirected to login page
  const currentUrl = page.url();
  if (currentUrl.includes('/auth/realms/')) {
    logger?.verbose('Session expired, re-authenticating...');
    await loginToSportlink(page, { logger, credentials });

    // Navigate again after re-auth
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');

    // Verify we're not still on login page
    const newUrl = page.url();
    if (newUrl.includes('/auth/realms/')) {
      throw new Error('Re-authentication failed: still on login page');
    }
  }
}

/**
 * Fill a field based on its type (text or checkbox).
 * @param {Object} page - Playwright page instance
 * @param {Object} fieldMapping - Field mapping with selector and type
 * @param {string} value - Value to set
 * @param {Object} [options] - Options
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<void>}
 */
async function fillFieldByType(page, fieldMapping, value, options = {}) {
  const { logger } = options;
  const { selector, type } = fieldMapping;

  await page.waitForSelector(selector, { timeout: 5000 });

  if (type === 'checkbox') {
    // For checkbox: interpret truthy values as checked
    const shouldBeChecked = value === true || value === 'true' || value === '1' || value === 1;
    const isCurrentlyChecked = await page.isChecked(selector);

    if (shouldBeChecked !== isCurrentlyChecked) {
      if (shouldBeChecked) {
        await page.check(selector);
      } else {
        await page.uncheck(selector);
      }
    }

    logger?.verbose(`Set checkbox ${selector} to ${shouldBeChecked}`);
  } else if (type === 'select') {
    // For select dropdowns (e.g. country code)
    await page.selectOption(selector, value || '');
    logger?.verbose(`Set select ${selector} to "${value || ''}"`);
  } else {
    // For text fields
    await page.fill(selector, value || '');
    logger?.verbose(`Set text field ${selector} to "${value || ''}"`);
  }
}

/**
 * Verify a field value after save based on its type.
 * @param {Object} page - Playwright page instance
 * @param {Object} fieldMapping - Field mapping with selector and type
 * @param {string} expectedValue - Expected value
 * @param {string} fieldName - Field name for error messages
 * @returns {Promise<void>}
 */
async function verifyFieldByType(page, fieldMapping, expectedValue, fieldName) {
  const { selector, type } = fieldMapping;

  if (type === 'checkbox') {
    const expectedChecked = expectedValue === true || expectedValue === 'true' || expectedValue === '1' || expectedValue === 1;
    const actualChecked = await page.isChecked(selector);
    if (actualChecked !== expectedChecked) {
      throw new Error(
        `Verification failed for ${fieldName}: expected ${expectedChecked}, got ${actualChecked}`
      );
    }
  } else if (type === 'select') {
    const actualValue = await page.locator(selector).inputValue();
    if (actualValue !== (expectedValue || '')) {
      throw new Error(
        `Verification failed for ${fieldName}: expected "${expectedValue}", got "${actualValue}"`
      );
    }
  } else {
    const actualValue = await page.inputValue(selector);
    if (actualValue !== (expectedValue || '')) {
      throw new Error(
        `Verification failed for ${fieldName}: expected "${expectedValue}", got "${actualValue}"`
      );
    }
  }
}

/**
 * Sync all field changes for a single page type.
 * @param {Object} page - Playwright page instance
 * @param {string} knvbId - Member KNVB ID
 * @param {string} pageType - Page type (general, other, financial)
 * @param {Array<Object>} pageChanges - Array of changes for this page
 * @param {Object} credentials - Login credentials
 * @param {Object} [options] - Options
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<void>}
 */
async function syncSinglePage(page, knvbId, pageType, pageChanges, credentials, options = {}) {
  const { logger } = options;

  if (pageChanges.length === 0) {
    return;
  }

  // Navigate to the specific page with timeout check
  const memberUrl = getMemberPageUrl(knvbId, pageType);
  logger?.verbose(`Navigating to ${pageType} page: ${memberUrl}`);
  await navigateWithTimeoutCheck(page, memberUrl, credentials, options);

  // Enter edit mode
  logger?.verbose(`Entering edit mode on ${pageType} page...`);
  try {
    const expectedSelector = SPORTLINK_FIELD_MAP[pageChanges[0]?.field_name]?.selector || null;
    await enterEditMode(page, pageType, expectedSelector);
  } catch (error) {
    throw new Error(`Could not find edit button on ${pageType} page: ${error.message}`);
  }

  await page.waitForLoadState('networkidle');

  // Convert E.164 phone numbers to local format before writing to Sportlink
  const phoneFields = ['mobile_1', 'mobile_2', 'telephone_1', 'telephone_2'];
  for (const change of pageChanges) {
    if (phoneFields.includes(change.field_name) && change.new_value) {
      change.new_value = e164ToLocal(change.new_value);
    }
  }

  // Fill each changed field using type-aware function
  for (const change of pageChanges) {
    const fieldMapping = SPORTLINK_FIELD_MAP[change.field_name];
    if (!fieldMapping) {
      logger?.error(`No selector mapping for field: ${change.field_name}`);
      continue;
    }

    logger?.verbose(`Filling ${change.field_name}: ${change.new_value}`);
    try {
      await fillFieldByType(page, fieldMapping, change.new_value, options);
    } catch (error) {
      throw new Error(`Could not fill field ${change.field_name} on ${pageType} page: ${error.message}`);
    }
  }

  // Save the form
  logger?.verbose(`Saving changes on ${pageType} page...`);
  try {
    await clickSaveButton(page);
  } catch (error) {
    throw new Error(`Could not save on ${pageType} page: ${error.message}`);
  }

  await page.waitForLoadState('networkidle');

  // Verify saved values
  logger?.verbose(`Verifying saved values on ${pageType} page...`);
  for (const change of pageChanges) {
    const fieldMapping = SPORTLINK_FIELD_MAP[change.field_name];
    if (!fieldMapping) continue;

    try {
      await verifyFieldByType(page, fieldMapping, change.new_value, change.field_name);
      logger?.verbose(`Verified ${change.field_name}`);
    } catch (error) {
      throw new Error(`Verification failed on ${pageType} page: ${error.message}`);
    }
  }

  logger?.verbose(`Successfully synced ${pageChanges.length} field(s) on ${pageType} page for member ${knvbId}`);
}

/**
 * Sync a member across all needed pages.
 * Implements fail-fast: if any page fails, throws immediately without updating other pages.
 * @param {Object} page - Playwright page instance
 * @param {string} knvbId - Member KNVB ID
 * @param {Object} pageChanges - Object with { general: [], other: [], financial: [] }
 * @param {Object} credentials - Login credentials
 * @param {Object} [options] - Options
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<Array<string>>} - List of page types that were synced
 */
async function syncMemberMultiPage(page, knvbId, pageChanges, credentials, options = {}) {
  const { logger } = options;
  const syncedPages = [];

  // Process pages in order: general -> address -> other -> financial
  const pageOrder = ['general', 'address', 'other', 'financial'];

  for (const pageType of pageOrder) {
    const changes = pageChanges[pageType];
    if (changes.length === 0) {
      continue;
    }

    // Fail-fast: any page failure throws immediately
    await syncSinglePage(page, knvbId, pageType, changes, credentials, options);
    syncedPages.push(pageType);
  }

  logger?.verbose(`Synced ${syncedPages.length} page(s) for member ${knvbId}: ${syncedPages.join(', ')}`);
  return syncedPages;
}

/**
 * Sync a member with retry logic for multi-page sync.
 * @param {Object} page - Playwright page instance
 * @param {string} knvbId - Member KNVB ID
 * @param {Object} pageChanges - Object with { general: [], other: [], financial: [] }
 * @param {Object} credentials - Login credentials
 * @param {Object} [options] - Options
 * @param {Object} [options.logger] - Logger instance
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @returns {Promise<{success: boolean, attempts: number, syncedPages?: Array<string>, error?: string}>}
 */
async function syncMemberMultiPageWithRetry(page, knvbId, pageChanges, credentials, options = {}) {
  const { logger, maxRetries = 3 } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const syncedPages = await syncMemberMultiPage(page, knvbId, pageChanges, credentials, options);
      return { success: true, attempts: attempt + 1, syncedPages };
    } catch (error) {
      if (attempt === maxRetries - 1) {
        return { success: false, attempts: attempt + 1, error: error.message };
      }
      const delay = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      logger?.verbose(`Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${error.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Run reverse sync from Rondo Club to Sportlink for ALL tracked fields (multi-page).
 * Handles fields across /general, /other, and /financial pages.
 * @param {Object} [options] - Options
 * @param {boolean} [options.verbose=false] - Verbose logging
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<{success: boolean, synced: number, failed: number, results: Array}>}
 */
async function runReverseSyncMultiPage(options = {}) {
  const { logger, knvbId } = options;

  // Get credentials from environment
  const username = process.env.SPORTLINK_USERNAME;
  const password = process.env.SPORTLINK_PASSWORD;
  const otpSecret = process.env.SPORTLINK_OTP_SECRET;
  const credentials = { username, password, otpSecret };

  if (!username || !password) {
    throw new Error('Missing SPORTLINK_USERNAME or SPORTLINK_PASSWORD');
  }

  // Open database and get ALL unsynced changes (not just contact fields)
  const db = openDb();
  const changes = getUnsyncedChanges(db);
  const filteredChanges = knvbId
    ? changes.filter(change => change.knvb_id === knvbId)
    : changes;

  if (filteredChanges.length === 0) {
    logger?.log('No unsynced field changes found');
    db.close();
    return { success: true, synced: 0, failed: 0, results: [] };
  }

  // Group changes by member and page
  const changesByMemberAndPage = groupChangesByMemberAndPage(filteredChanges);

  // Filter out deceased members before launching browser
  for (const [knvbId, pageChanges] of changesByMemberAndPage) {
    const rondoClubRecord = db.prepare('SELECT rondo_club_id FROM rondo_club_members WHERE knvb_id = ?').get(knvbId);
    if (!rondoClubRecord?.rondo_club_id) continue;

    try {
      const response = await rondoClubRequest(`wp/v2/people/${rondoClubRecord.rondo_club_id}?_fields=acf.datum-overlijden`, 'GET');
      const datumOverlijden = response.body?.acf?.['datum-overlijden'];
      if (datumOverlijden && new Date(datumOverlijden) <= new Date()) {
        const allFieldNames = [
          ...pageChanges.general.map(c => c.field_name),
          ...pageChanges.address.map(c => c.field_name),
          ...pageChanges.other.map(c => c.field_name),
          ...pageChanges.financial.map(c => c.field_name)
        ];
        markChangesSynced(db, knvbId, allFieldNames);
        const fieldCount = allFieldNames.length;
        logger?.log(`Skipping ${knvbId}: deceased (${datumOverlijden}), marked ${fieldCount} change(s) as synced`);
        changesByMemberAndPage.delete(knvbId);
      }
    } catch (err) {
      logger?.verbose(`Could not check deceased status for ${knvbId}: ${err.message}`);
    }
  }

  if (changesByMemberAndPage.size === 0) {
    logger?.log('No unsynced field changes remaining after filtering');
    db.close();
    return { success: true, synced: 0, failed: 0, results: [] };
  }

  // Count total fields to sync
  let totalFields = 0;
  for (const [, pages] of changesByMemberAndPage) {
    totalFields += pages.general.length + pages.address.length + pages.other.length + pages.financial.length;
  }

  logger?.log(`Found ${totalFields} unsynced change(s) across ${changesByMemberAndPage.size} member(s)`);

  // Launch browser and login
  let browser;
  const results = [];
  let synced = 0;
  let failed = 0;
  let consecutiveEditFailures = 0;
  const MAX_CONSECUTIVE_EDIT_FAILURES = 20;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // Login once at the start
    await loginToSportlink(page, { logger, credentials });

    // Process each member sequentially
    for (const [knvbId, pageChanges] of changesByMemberAndPage) {
      const fieldCount = pageChanges.general.length + pageChanges.address.length + pageChanges.other.length + pageChanges.financial.length;
      logger?.verbose(`Processing member ${knvbId} with ${fieldCount} change(s)...`);

      const result = await syncMemberMultiPageWithRetry(page, knvbId, pageChanges, credentials, { logger, maxRetries: 3 });

      if (result.success) {
        consecutiveEditFailures = 0;

        // Mark ALL changes for this member as synced (fail-fast means all or nothing)
        const allFieldNames = [
          ...pageChanges.general.map(c => c.field_name),
          ...pageChanges.address.map(c => c.field_name),
          ...pageChanges.other.map(c => c.field_name),
          ...pageChanges.financial.map(c => c.field_name)
        ];
        markChangesSynced(db, knvbId, allFieldNames);

        // Update Sportlink modification timestamps for all fields
        updateSportlinkTimestamps(db, knvbId, allFieldNames);
        logger?.verbose(`Updated Sportlink timestamps for ${knvbId}: ${allFieldNames.join(', ')}`);

        synced++;
        logger?.log(`Synced ${fieldCount} field(s) for member ${knvbId}`);
      } else {
        // Fail-fast: don't update any timestamps if any page failed
        failed++;
        logger?.error(`Failed to sync member ${knvbId}: ${result.error}`);

        if (/edit button/i.test(result.error || '')) {
          consecutiveEditFailures++;
          if (consecutiveEditFailures >= MAX_CONSECUTIVE_EDIT_FAILURES) {
            logger?.error(
              `Aborting reverse sync after ${consecutiveEditFailures} consecutive edit-button failures; likely Sportlink UI selector drift`
            );
            break;
          }
        } else {
          consecutiveEditFailures = 0;
        }
      }

      results.push({
        knvbId,
        success: result.success,
        attempts: result.attempts,
        fieldCount,
        syncedPages: result.syncedPages,
        error: result.error
      });

      // Add delay between members to avoid rate limiting
      const delay = 1000 + Math.random() * 1000; // 1-2 seconds
      await new Promise(r => setTimeout(r, delay));
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    db.close();
  }

  const success = failed === 0;
  logger?.log(`Multi-page reverse sync complete: ${synced} synced, ${failed} failed`);

  return { success, synced, failed, results };
}

module.exports = {
  SPORTLINK_FIELD_MAP,
  syncMemberToSportlink,
  runReverseSync,
  // Multi-page sync (Phase 24)
  groupChangesByMemberAndPage,
  navigateWithTimeoutCheck,
  fillFieldByType,
  verifyFieldByType,
  syncSinglePage,
  syncMemberMultiPage,
  runReverseSyncMultiPage
};
