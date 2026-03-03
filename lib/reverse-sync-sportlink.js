require('dotenv/config');

const { chromium } = require('playwright');
const { openDb, getUnsyncedContactChanges, markChangesSynced, updateSportlinkTimestamps, getUnsyncedChanges } = require('./rondo-club-db');
const { loginToSportlink } = require('./sportlink-login');
const { SYNC_ORIGIN, createTimestamp, getTimestampColumnNames } = require('./sync-origin');

/**
 * Mapping of Rondo Club field names to Sportlink form selectors with page context.
 * These selectors need verification against actual Sportlink UI.
 */
const SPORTLINK_FIELD_MAP = {
  // /general page (contact fields from Phase 23)
  'email': { page: 'general', selector: 'input[name="Email"]', type: 'text' },      // TODO: Verify actual selector
  'email2': { page: 'general', selector: 'input[name="Email2"]', type: 'text' },    // TODO: Verify actual selector
  'mobile': { page: 'general', selector: 'input[name="Mobile"]', type: 'text' },    // TODO: Verify actual selector
  'phone': { page: 'general', selector: 'input[name="Phone"]', type: 'text' },      // TODO: Verify actual selector

  // /other page (free fields from Phase 24)
  'freescout-id': { page: 'other', selector: 'input[name="Remarks3"]', type: 'text' },
  'datum-vog': { page: 'other', selector: 'input[name="Remarks8"]', type: 'text' },

  // /financial page (financial block from Phase 24)
  'financiele-blokkade': { page: 'financial', selector: 'input[name="HasFinancialTransferBlockOwnClub"]', type: 'checkbox' }
};

/**
 * Page URL suffixes for Sportlink member pages.
 */
const PAGE_URLS = {
  'general': '/general',
  'other': '/other',
  'financial': '/financial'
};

const EDIT_BUTTON_SELECTORS = [
  'button[data-action="edit"]',
  '.edit-button',
  '#btnEdit',
  'button:has-text("Bewerken")',
  'button:has-text("Edit")',
  'a:has-text("Bewerken")',
  '[aria-label*="Bewerk"]',
  '[aria-label*="Edit"]'
];

async function enterEditMode(page) {
  for (const selector of EDIT_BUTTON_SELECTORS) {
    const button = page.locator(selector).first();
    if (await button.count() === 0) {
      continue;
    }
    try {
      await button.waitFor({ state: 'visible', timeout: 3000 });
      await button.click();
      return selector;
    } catch (error) {
      // Try next selector.
    }
  }

  throw new Error(`Could not find edit button with selectors: ${EDIT_BUTTON_SELECTORS.join(', ')}`);
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
  const memberUrl = `https://club.sportlink.com/member/${knvbId}/general`;
  logger?.verbose(`Navigating to member page: ${memberUrl}`);
  await page.goto(memberUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  // Enter edit mode (TODO: verify actual selector)
  logger?.verbose('Entering edit mode...');
  try {
    await enterEditMode(page);
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
  const saveButtonSelector = 'button[type="submit"], button[data-action="save"], .save-button, #btnSave';
  try {
    await page.waitForSelector(saveButtonSelector, { timeout: 10000 });
    await page.click(saveButtonSelector);
  } catch (error) {
    throw new Error(`Could not find save button with selector: ${saveButtonSelector}`);
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
  const { logger } = options;

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

  if (changes.length === 0) {
    logger?.log('No unsynced contact field changes found');
    db.close();
    return { success: true, synced: 0, failed: 0, results: [] };
  }

  // Group changes by knvb_id
  const changesByMember = new Map();
  for (const change of changes) {
    if (!changesByMember.has(change.knvb_id)) {
      changesByMember.set(change.knvb_id, []);
    }
    changesByMember.get(change.knvb_id).push(change);
  }

  logger?.log(`Found ${changes.length} unsynced change(s) for ${changesByMember.size} member(s)`);

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
      grouped.set(knvbId, { general: [], other: [], financial: [] });
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
  const memberUrl = `https://club.sportlink.com/member/${knvbId}${PAGE_URLS[pageType]}`;
  logger?.verbose(`Navigating to ${pageType} page: ${memberUrl}`);
  await navigateWithTimeoutCheck(page, memberUrl, credentials, options);

  // Enter edit mode
  logger?.verbose(`Entering edit mode on ${pageType} page...`);
  try {
    await enterEditMode(page);
  } catch (error) {
    throw new Error(`Could not find edit button on ${pageType} page: ${error.message}`);
  }

  await page.waitForLoadState('networkidle');

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
  const saveButtonSelector = 'button[type="submit"], button[data-action="save"], .save-button, #btnSave';
  try {
    await page.waitForSelector(saveButtonSelector, { timeout: 10000 });
    await page.click(saveButtonSelector);
  } catch (error) {
    throw new Error(`Could not find save button on ${pageType} page: ${error.message}`);
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

  // Process pages in order: general -> other -> financial
  const pageOrder = ['general', 'other', 'financial'];

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
  const { logger } = options;

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

  if (changes.length === 0) {
    logger?.log('No unsynced field changes found');
    db.close();
    return { success: true, synced: 0, failed: 0, results: [] };
  }

  // Group changes by member and page
  const changesByMemberAndPage = groupChangesByMemberAndPage(changes);

  // Count total fields to sync
  let totalFields = 0;
  for (const [, pages] of changesByMemberAndPage) {
    totalFields += pages.general.length + pages.other.length + pages.financial.length;
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
      const fieldCount = pageChanges.general.length + pageChanges.other.length + pageChanges.financial.length;
      logger?.verbose(`Processing member ${knvbId} with ${fieldCount} change(s)...`);

      const result = await syncMemberMultiPageWithRetry(page, knvbId, pageChanges, credentials, { logger, maxRetries: 3 });

      if (result.success) {
        consecutiveEditFailures = 0;

        // Mark ALL changes for this member as synced (fail-fast means all or nothing)
        const allFieldNames = [
          ...pageChanges.general.map(c => c.field_name),
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
