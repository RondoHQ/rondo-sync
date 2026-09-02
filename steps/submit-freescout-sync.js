require('dotenv/config');

const { freescoutRequestWithRetry: freescoutRequest, checkCredentials } = require('../lib/freescout-client');
const { runPrepare } = require('./prepare-freescout-customers');
const {
  openDb,
  upsertCustomers,
  getCustomersNeedingSync,
  updateSyncState,
  deleteCustomer,
  getCustomersNotInList
} = require('../lib/freescout-db');

function buildCreatePayload(customer) {
  return {
    firstName: customer.data.firstName,
    lastName: customer.data.lastName,
    emails: [{ value: customer.email, type: 'home' }]
  };
}

function buildUpdatePayload(customer) {
  return {
    firstName: customer.data.firstName,
    lastName: customer.data.lastName,
    emails_add: [customer.email]
  };
}

/**
 * Search for an existing customer in FreeScout by email
 * @param {string} email - Email to search for
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<number|null>} - FreeScout customer ID if found, null otherwise
 */
async function findCustomerByEmail(email, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  try {
    const response = await freescoutRequest(
      `/api/customers?email=${encodeURIComponent(email)}`,
      'GET',
      null,
      options
    );

    // FreeScout returns _embedded.customers array
    const customers = response.body?._embedded?.customers || [];
    if (customers.length > 0) {
      const customerId = customers[0].id;
      logVerbose(`Found existing customer ${customerId} with email ${email}`);
      return customerId;
    }
    return null;
  } catch (error) {
    logVerbose(`Email search failed: ${error.message}`);
    return null;
  }
}

/**
 * Search for customer ID via conversations (when email exists in conversations but not as customer)
 * @param {string} email - Email to search for
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<number|null>} - FreeScout customer ID if found, null otherwise
 */
async function findCustomerByConversationEmail(email, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  try {
    const response = await freescoutRequest(
      `/api/conversations?customerEmail=${encodeURIComponent(email)}`,
      'GET',
      null,
      options
    );

    // FreeScout returns _embedded.conversations array, each with a customer object
    const conversations = response.body?._embedded?.conversations || [];
    if (conversations.length > 0 && conversations[0].customer?.id) {
      const customerId = conversations[0].customer.id;
      logVerbose(`Found customer ${customerId} via conversation search for ${email}`);
      return customerId;
    }
    return null;
  } catch (error) {
    logVerbose(`Conversation email search failed: ${error.message}`);
    return null;
  }
}

/**
 * Create a new customer in FreeScout
 * @param {Object} customer - Customer data
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<number>} - New FreeScout customer ID
 */
async function createCustomer(customer, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  const payload = buildCreatePayload(customer);

  logVerbose(`Creating new customer: ${customer.email}`);
  const response = await freescoutRequest('/api/customers', 'POST', payload, options);
  return response.body.id;
}

/**
 * Update an existing customer in FreeScout
 * @param {number} freescoutId - FreeScout customer ID
 * @param {Object} customer - Customer data
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<void>}
 */
async function updateCustomer(freescoutId, customer, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  const payload = buildUpdatePayload(customer);

  logVerbose(`Updating customer ${freescoutId}: ${customer.email}`);
  await freescoutRequest(`/api/customers/${freescoutId}`, 'PUT', payload, options);
}

/**
 * Sync a single customer to FreeScout
 * @param {Object} customer - Customer record from database
 * @param {Object} db - SQLite database connection
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<{action: string, id: number}>}
 */
async function syncCustomer(customer, db, options) {
  const { knvb_id, email, source_hash } = customer;
  let { freescout_id } = customer;
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  try {
    if (freescout_id) {
      // UPDATE existing customer
      try {
        await updateCustomer(freescout_id, customer, options);
        updateSyncState(db, knvb_id, source_hash, freescout_id);
        return { action: 'updated', id: freescout_id };
      } catch (error) {
        // Customer was deleted from FreeScout - clear tracking and create new
        if (error.status === 404) {
          logVerbose(`Customer ${freescout_id} no longer exists (404) - will create fresh`);
          updateSyncState(db, knvb_id, null, null); // Clear freescout_id and hash
          freescout_id = null;
          // Fall through to create path below
        } else {
          throw error;
        }
      }
    }

    if (!freescout_id) {
      // Check if customer exists by email (avoid duplicates)
      const existingId = await findCustomerByEmail(email, options);
      if (existingId) {
        logVerbose(`Found existing customer ${existingId} by email, linking`);
        freescout_id = existingId;
        // Update the existing customer with our data
        await updateCustomer(freescout_id, customer, options);
        updateSyncState(db, knvb_id, source_hash, freescout_id);
        return { action: 'updated', id: freescout_id };
      }

      // CREATE new customer
      freescout_id = await createCustomer(customer, options);
      updateSyncState(db, knvb_id, source_hash, freescout_id);
      return { action: 'created', id: freescout_id };
    }
  } catch (error) {
    // Handle 409 conflict (email already exists)
    if (error.status === 409) {
      logVerbose(`Conflict for ${email} - searching by email`);
      const existingId = await findCustomerByEmail(email, options);
      if (existingId) {
        await updateCustomer(existingId, customer, options);
        updateSyncState(db, knvb_id, source_hash, existingId);
        return { action: 'updated', id: existingId };
      }
    }

    // Handle 400 "email already exists" - FreeScout thinks email exists but API can't find it
    // This happens when email exists in conversations but not as a customer email
    if (error.status === 400 && error.details?._embedded?.errors?.some(e => e.message?.includes('already exist'))) {
      // First try regular customer search
      let existingId = await findCustomerByEmail(email, options);

      // If not found, try searching via conversations
      if (!existingId) {
        logVerbose(`Customer not found via direct search, trying conversation search for ${email}`);
        existingId = await findCustomerByConversationEmail(email, options);
      }

      if (existingId) {
        logVerbose(`Found customer ${existingId} after 400 error, linking`);
        await updateCustomer(existingId, customer, options);
        updateSyncState(db, knvb_id, source_hash, existingId);
        return { action: 'updated', id: existingId };
      }
      // Can't find customer - email exists in FreeScout system but not as searchable customer
      throw new Error(`Email exists in FreeScout but customer not found via API or conversations`);
    }

    throw error;
  }
}

/**
 * Delete orphan customers (no longer in Sportlink)
 * @param {Object} db - SQLite database connection
 * @param {Array<string>} currentKnvbIds - Current KNVB IDs from preparation
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<{deleted: number, errors: Array}>}
 */
async function deleteOrphanCustomers(db, currentKnvbIds, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});
  const deleted = [];
  const errors = [];

  const toDelete = getCustomersNotInList(db, currentKnvbIds);

  for (const customer of toDelete) {
    if (!customer.freescout_id) {
      // Never synced to FreeScout, just remove from tracking
      deleteCustomer(db, customer.knvb_id);
      continue;
    }

    logVerbose(`Deleting orphan customer: ${customer.knvb_id}`);
    try {
      await freescoutRequest(
        `/api/customers/${customer.freescout_id}`,
        'DELETE',
        null,
        options
      );
      deleteCustomer(db, customer.knvb_id);
      deleted.push({ knvb_id: customer.knvb_id, freescout_id: customer.freescout_id });
    } catch (error) {
      // Ignore 404 errors - customer already deleted from FreeScout
      if (error.status === 404) {
        logVerbose(`  Already deleted from FreeScout (404)`);
        deleteCustomer(db, customer.knvb_id);
        deleted.push({ knvb_id: customer.knvb_id, freescout_id: customer.freescout_id });
      } else {
        errors.push({ knvb_id: customer.knvb_id, message: error.message });
      }
    }
  }

  return { deleted: deleted.length, errors };
}

/**
 * Main sync orchestration
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force sync all customers
 * @param {boolean} [options.dryRun=false] - Show what would be synced without making API calls
 * @returns {Promise<Object>} - Sync result
 */
async function runSubmit(options = {}) {
  const { logger, verbose = false, force = false, dryRun = false } = options;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});
  const logError = logger?.error.bind(logger) || console.error;
  const log = logger?.log.bind(logger) || console.log;

  const result = {
    success: true,
    total: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    errors: []
  };

  // Check credentials first
  const creds = checkCredentials();
  if (!creds.configured) {
    result.success = false;
    result.errors.push({ message: `Missing ${creds.missing.join(' and ')}` });
    return result;
  }

  let db = null;

  try {
    db = openDb();

    // Step 1: Prepare customers from Rondo Club data
    const prepared = await runPrepare({ logger, verbose });
    if (!prepared.success) {
      result.success = false;
      result.errors.push({ message: prepared.error || 'Prepare failed' });
      return result;
    }

    const customers = prepared.customers;
    result.total = customers.length;

    if (dryRun) {
      log(`[DRY RUN] Would process ${customers.length} customers`);
    }

    // Step 2: Upsert to tracking database
    const customersForDb = customers.map(c => ({
      knvb_id: c.knvb_id,
      email: c.email,
      data: c.data
    }));
    upsertCustomers(db, customersForDb);

    // Step 3: Get customers needing sync (hash changed or force)
    const needsSync = getCustomersNeedingSync(db, force);
    result.skipped = result.total - needsSync.length;

    logVerbose(`${needsSync.length} customers need sync (${result.skipped} unchanged)`);

    if (dryRun) {
      log(`[DRY RUN] ${needsSync.length} customers would be synced`);
      needsSync.forEach(c => {
        const action = c.freescout_id ? 'UPDATE' : 'CREATE';
        log(`  ${action}: ${c.knvb_id} (${c.email})`);
      });
      return result;
    }

    // Step 4: Sync each customer
    for (let i = 0; i < needsSync.length; i++) {
      const customer = needsSync[i];

      logVerbose(`Syncing ${i + 1}/${needsSync.length}: ${customer.knvb_id} (${customer.email})`);

      try {
        const syncResult = await syncCustomer(customer, db, options);
        result.synced++;
        if (syncResult.action === 'created') result.created++;
        if (syncResult.action === 'updated') result.updated++;
      } catch (error) {
        logError(`ERROR for ${customer.knvb_id}: ${error.message}`);
        result.errors.push({
          knvb_id: customer.knvb_id,
          email: customer.email,
          message: error.message
        });
      }
    }

    // Step 5: Delete orphan customers (not in current data)
    const currentKnvbIds = customers.map(c => c.knvb_id);
    const deleteResult = await deleteOrphanCustomers(db, currentKnvbIds, options);
    result.deleted = deleteResult.deleted;
    result.errors.push(...deleteResult.errors);

    result.success = result.errors.length === 0;
    return result;

  } catch (error) {
    result.success = false;
    result.errors.push({ message: error.message });
    logError(`Sync error: ${error.message}`);
    return result;
  } finally {
    if (db) db.close();
  }
}

module.exports = { runSubmit, createCustomer, updateCustomer, buildCreatePayload, buildUpdatePayload };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');

  runSubmit({ verbose, force, dryRun })
    .then(result => {
      console.log(`FreeScout sync: ${result.synced}/${result.total} synced`);
      console.log(`  Created: ${result.created}`);
      console.log(`  Updated: ${result.updated}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log(`  Deleted: ${result.deleted}`);
      if (result.errors.length > 0) {
        console.error(`  Errors: ${result.errors.length}`);
        result.errors.forEach(e => console.error(`    - ${e.knvb_id || 'system'}: ${e.message}`));
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
