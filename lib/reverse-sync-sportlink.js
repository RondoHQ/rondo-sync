require('dotenv/config');

const { SportlinkSession } = require('./sportlink-session');
const { openDb, getUnsyncedContactChanges, markChangesSynced, updateSportlinkTimestamps, getUnsyncedChanges } = require('./rondo-club-db');
const { loginToSportlink } = require('./sportlink-login');
const { e164ToLocal } = require('./phone-normalizer');
const { rondoClubRequest } = require('./rondo-club-client');

/**
 * Mapping of Rondo Club field names to Sportlink form selectors with page context.
 * These selectors need verification against actual Sportlink UI.
 */
const SPORTLINK_FIELD_MAP = {
  // /general page (contact fields — renamed to match fixed canonical fields)
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
  // Wait for the SPA to render its Wijzig buttons. networkidle fires
  // ~3s after navigation; the section-level buttons appear within ~20ms
  // after that. Earlier code only waited 500ms-ish and could see a
  // pre-hydration snapshot with 1-2 buttons instead of 3-5.
  await page.waitForSelector('button:has-text("Wijzig")', { timeout: 8000, state: 'visible' }).catch(() => {});
  await page.waitForTimeout(500);

  const buttonLocator = () => page.locator('button:has-text("Wijzig")');
  const initialCount = await buttonLocator().count();
  if (initialCount === 0) {
    throw new Error(`No Wijzig buttons found on ${pageType} page after wait`);
  }

  // Build candidate index order. Hardcoded "preferred" indices reflect the
  // common layout (lidsoort header + N section buttons), but member-specific
  // variations exist (some members lack "Wijzig lidsoort" entirely, some
  // sections collapse, etc.), so we ALWAYS fall back to trying every
  // remaining index.
  const preferred = {
    general:   [2, 1, 3, 4, 5],
    address:   [3, 2, 4],
    other:     [1, 2, 0, 3],
    financial: [1, 2, 0]
  }[pageType] || [];

  const order = [];
  const seen = new Set();
  for (const i of preferred) {
    if (i < initialCount && !seen.has(i)) {
      order.push(i);
      seen.add(i);
    }
  }
  for (let i = 0; i < initialCount; i++) {
    if (!seen.has(i)) {
      order.push(i);
      seen.add(i);
    }
  }

  const originalUrl = page.url();
  const triedLabels = [];

  for (const idx of order) {
    const label = (await buttonLocator().nth(idx).textContent().catch(() => '')).trim();

    // "Wijzig lidsoort" opens a different form and never has the contact
    // / free-fields inputs we'd be after. Skip it explicitly so an exhaustive
    // search doesn't waste a navigation cycle on it.
    if (/lidsoort/i.test(label)) {
      triedLabels.push(`[${idx}] "${label}" (skipped: lidsoort)`);
      continue;
    }

    let clicked = false;
    try {
      const button = buttonLocator().nth(idx);
      await button.waitFor({ state: 'visible', timeout: 3000 });
      await button.click();
      clicked = true;
    } catch {
      triedLabels.push(`[${idx}] "${label}" (click failed)`);
      continue;
    }

    await page.waitForLoadState('networkidle').catch(() => {});

    if (!expectedSelector) {
      return label || `Wijzig[${idx}]`;
    }

    try {
      await page.waitForSelector(expectedSelector, { timeout: 2500 });
      return label || `Wijzig[${idx}]`;
    } catch {
      triedLabels.push(`[${idx}] "${label}" (clicked but ${expectedSelector} not visible)`);
      // Reset page state before trying the next button — Sportlink keeps
      // the wrong section's edit form open otherwise, and the next click
      // might land on a now-relocated button.
      if (clicked) {
        try {
          await page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle').catch(() => {});
          await page.waitForSelector('button:has-text("Wijzig")', { timeout: 5000, state: 'visible' }).catch(() => {});
          await page.waitForTimeout(300);
        } catch {
          // If re-navigation fails, fall through and let the next attempt
          // see whatever the page currently looks like.
        }
      }
    }
  }

  throw new Error(
    `Could not find edit button for ${pageType} page (expectedSelector=${expectedSelector || 'none'}; tried: ${triedLabels.join(' | ') || 'nothing'})`
  );
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

  // Acquire shared Sportlink session — reuses a cached login from disk
  // when possible (across processes) so the every-5-minutes cron tick
  // doesn't burn a TOTP code each run.
  const session = new SportlinkSession({ logger });
  const results = [];
  let synced = 0;
  let failed = 0;

  try {
    const page = await session.getPage();

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
    await session.close();
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

  // `changes` is ordered by detected_at ASC, so for any (knvb_id, field_name)
  // tuple with multiple unsynced rows the LAST one wins. Older rows for the
  // same field are intentionally discarded here — writing them in sequence
  // would set Sportlink to the intermediate value, then the final value,
  // and verification would then fail comparing the field against the older
  // expected value. markChangesSynced(knvb_id, field_name) marks every
  // unsynced row for that field as synced, so the dropped rows still get
  // resolved in the database when the chosen one succeeds.
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
    const pageList = memberPages[fieldMapping.page];
    const existingIdx = pageList.findIndex(c => c.field_name === change.field_name);
    if (existingIdx >= 0) {
      pageList[existingIdx] = change;
    } else {
      pageList.push(change);
    }
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
/**
 * Dutch month abbreviations for date normalization.
 * Sportlink displays dates as "30 okt 2023" instead of "2023-10-30".
 */
const DUTCH_MONTHS = {
  'jan': '01', 'feb': '02', 'mrt': '03', 'apr': '04',
  'mei': '05', 'jun': '06', 'jul': '07', 'aug': '08',
  'sep': '09', 'okt': '10', 'nov': '11', 'dec': '12'
};

/**
 * Try to parse a Dutch-formatted date string to ISO format (YYYY-MM-DD).
 * Returns the original string if it doesn't match the expected pattern.
 */
function dutchDateToISO(dateStr) {
  if (!dateStr) return dateStr;
  const match = dateStr.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})$/);
  if (!match) return dateStr;
  const month = DUTCH_MONTHS[match[2].toLowerCase()];
  if (!month) return dateStr;
  return `${match[3]}-${month}-${match[1].padStart(2, '0')}`;
}

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
    // Normalize Dutch date formats (e.g. "30 okt 2023" -> "2023-10-30")
    const normalizedActual = dutchDateToISO(actualValue);
    if (normalizedActual !== (expectedValue || '') && actualValue !== (expectedValue || '')) {
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

  // Detect "non-editable" lidsoorten — Sportlink rendert dan een read-only
  // pagina zonder Wijzig-knoppen voor de contactgegevens. We checken op
  // EXPLICIETE lidsoort-tekst (geen UI-heuristiek) zodat een toekomstige
  // Sportlink-UI-wijziging niet per ongeluk alles als "ex-lid" markeert.
  const NON_EDITABLE_LIDSOORTEN = [
    'Oud bondslid',
    'Oud verenigingslid',
  ];
  const bodyText = await page.locator('body').textContent().catch(() => '');
  for (const lidsoort of NON_EDITABLE_LIDSOORTEN) {
    if (bodyText.includes(lidsoort)) {
      throw new Error(`Member ${knvbId} is "${lidsoort}" — not editable in Sportlink`);
    }
  }

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

  // Re-enter edit mode for verification — after save, inputs become read-only
  logger?.verbose(`Re-entering edit mode on ${pageType} page for verification...`);
  try {
    const expectedSelector = SPORTLINK_FIELD_MAP[pageChanges[0]?.field_name]?.selector || null;
    await enterEditMode(page, pageType, expectedSelector);
    await page.waitForLoadState('networkidle');
  } catch (error) {
    // If we can't re-enter edit mode, skip verification but log a warning
    logger?.verbose(`Could not re-enter edit mode for verification on ${pageType} page: ${error.message} — skipping verification`);
    logger?.verbose(`Synced ${pageChanges.length} field(s) on ${pageType} page for member ${knvbId} (unverified)`);
    return;
  }

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
      // Non-retryable: een definitieve lidsoort die niet bewerkbaar is in
      // Sportlink. Een retry verandert dat niet en kost wel ~25s per attempt.
      if (/Oud bondslid|Oud verenigingslid/i.test(error.message)) {
        return { success: false, attempts: attempt + 1, error: error.message };
      }
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
      const response = await rondoClubRequest(`wp/v2/people/${rondoClubRecord.rondo_club_id}?_fields=fields.datum_overlijden`, 'GET');
      const datumOverlijden = response.body?.fields?.['datum_overlijden'];
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

  // Acquire shared Sportlink session — reuses a cached login from disk
  // when possible (across processes) so the every-5-minutes cron tick
  // doesn't burn a TOTP code each run.
  const session = new SportlinkSession({ logger });
  const results = [];
  let synced = 0;
  let failed = 0;
  let consecutiveEditFailures = 0;
  const MAX_CONSECUTIVE_EDIT_FAILURES = 20;

  try {
    const page = await session.getPage();

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
      } else if (/Oud bondslid|Oud verenigingslid/i.test(result.error || '')) {
        // Member heeft een lidsoort waarvoor Sportlink geen contact-edits
        // toelaat. Markeer de changes als synced zodat we niet elke 5 min
        // opnieuw proberen — zodra de lidsoort terug naar 'actief' wijzigt
        // en Rondo Club een nieuwe wijziging detecteert, wordt 'm vanzelf
        // weer opgepakt.
        const allFieldNames = [
          ...pageChanges.general.map(c => c.field_name),
          ...pageChanges.address.map(c => c.field_name),
          ...pageChanges.other.map(c => c.field_name),
          ...pageChanges.financial.map(c => c.field_name)
        ];
        markChangesSynced(db, knvbId, allFieldNames);
        const lidsoortMatch = (result.error || '').match(/(Oud (?:bondslid|verenigingslid))/i);
        const reason = lidsoortMatch ? lidsoortMatch[1] : 'non-editable lidsoort';
        logger?.log(`Skipping ${knvbId}: lidsoort "${reason}" — niet bewerkbaar in Sportlink, ${fieldCount} change(s) gemarkeerd als synced`);
        synced++;
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
    await session.close();
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
