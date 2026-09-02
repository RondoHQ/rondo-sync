require('dotenv/config');

const { freescoutRequestWithRetry, checkCredentials } = require('../lib/freescout-client');
const { openDb, getAllTrackedCustomers } = require('../lib/freescout-db');
const {
  getCustomerFields,
  hasValue,
  classifyCustomer,
  buildCleanupPreview,
  fetchAllCustomers
} = require('./preview-freescout-customer-cleanup');

const CONFIRMATION = 'remove-extra-profile-data';

function buildStandardCleanupPayload(customer) {
  const categories = new Set(classifyCustomer(customer));
  const payload = {};

  if (categories.has('phone')) {
    payload.phone = '';
    payload.phones = [];
  }
  if (categories.has('photo')) {
    payload.photoUrl = '';
    payload.photoType = 'unknown';
  }
  if (categories.has('address')) {
    payload.address = { city: '', state: '', zip: '', country: '', address: '' };
  }
  if (categories.has('company')) payload.company = '';
  if (categories.has('jobTitle')) payload.jobTitle = '';
  if (categories.has('notes')) payload.notes = '';
  if (categories.has('socialProfiles')) payload.socialProfiles = [];
  if (categories.has('websites')) payload.websites = [];

  return payload;
}

function buildCustomerFieldsCleanupPayload(customer) {
  const customerFields = getCustomerFields(customer)
    .filter(field => Number.isInteger(Number(field.id)) && [field.value, field.text].some(hasValue))
    .map(field => ({ id: Number(field.id), value: '' }));

  return customerFields.length > 0 ? { customerFields } : null;
}

async function cleanupCustomers(customers, trackedIds, request = freescoutRequestWithRetry, options = {}) {
  const limit = options.limit || Number.POSITIVE_INFINITY;
  const candidates = customers.filter(customer => (
    trackedIds.has(Number(customer.id)) && classifyCustomer(customer).length > 0
  ));
  const selected = candidates.slice(0, limit);
  let standardProfilesUpdated = 0;
  let customFieldSetsCleared = 0;

  for (let index = 0; index < selected.length; index++) {
    const customer = selected[index];
    const categories = classifyCustomer(customer);
    if (categories.includes('properties')) {
      throw new Error(`Cleanup stopped after ${index} profiles: unsupported customer properties are present`);
    }

    try {
      const standardPayload = buildStandardCleanupPayload(customer);
      if (Object.keys(standardPayload).length > 0) {
        await request(`/api/customers/${customer.id}`, 'PUT', standardPayload, {});
        standardProfilesUpdated++;
      }

      const customerFieldsPayload = buildCustomerFieldsCleanupPayload(customer);
      if (customerFieldsPayload) {
        await request(`/api/customers/${customer.id}/customer_fields`, 'PUT', customerFieldsPayload, {});
        customFieldSetsCleared++;
      }
    } catch (error) {
      const reason = error.status ? `HTTP ${error.status}` : 'request failed';
      throw new Error(`Cleanup stopped after ${index} profiles: ${reason}`);
    }

    if (options.onProgress) options.onProgress(index + 1, selected.length);
  }

  return {
    candidates: candidates.length,
    processed: selected.length,
    standardProfilesUpdated,
    customFieldSetsCleared
  };
}

async function runCleanup(options = {}) {
  if (!options.apply || options.confirm !== CONFIRMATION) {
    throw new Error(`Refusing to change FreeScout; use --apply --confirm=${CONFIRMATION}`);
  }

  const credentials = checkCredentials();
  if (!credentials.configured) {
    throw new Error(`Missing ${credentials.missing.join(' and ')}`);
  }

  const db = openDb(options.dbPath);
  try {
    const trackedIds = new Set(
      getAllTrackedCustomers(db)
        .map(customer => Number(customer.freescout_id))
        .filter(id => Number.isInteger(id) && id > 0)
    );
    const beforeCustomers = await fetchAllCustomers(options.request);
    const before = buildCleanupPreview(beforeCustomers, trackedIds);
    const result = await cleanupCustomers(beforeCustomers, trackedIds, options.request, options);
    const afterCustomers = await fetchAllCustomers(options.request);
    const after = buildCleanupPreview(afterCustomers, trackedIds);
    return { before, result, after };
  } finally {
    db.close();
  }
}

function parseLimit(args) {
  const value = args.find(arg => arg.startsWith('--limit='));
  if (!value) return Number.POSITIVE_INFINITY;
  const limit = Number(value.split('=')[1]);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  return limit;
}

function printSummary(summary) {
  console.log('FreeScout customer profile cleanup');
  console.log(`Profiles with extra data before: ${summary.before.customersWithExtraProfileData}`);
  console.log(`Profiles selected in this run: ${summary.result.processed}`);
  console.log(`Standard profiles updated: ${summary.result.standardProfilesUpdated}`);
  console.log(`Custom-field sets cleared: ${summary.result.customFieldSetsCleared}`);
  console.log(`Profiles with extra data after: ${summary.after.customersWithExtraProfileData}`);
  console.log('Names and email addresses were preserved. No values or customer IDs were printed.');
}

module.exports = {
  CONFIRMATION,
  buildStandardCleanupPayload,
  buildCustomerFieldsCleanupPayload,
  cleanupCustomers,
  runCleanup,
  parseLimit
};

if (require.main === module) {
  const args = process.argv.slice(2);
  let limit;
  try {
    limit = parseLimit(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  runCleanup({
    apply: args.includes('--apply'),
    confirm: args.find(arg => arg.startsWith('--confirm='))?.split('=')[1],
    limit,
    onProgress: (completed, total) => {
      if (completed === total || completed % 100 === 0) {
        console.log(`Processed ${completed}/${total} profiles`);
      }
    }
  })
    .then(printSummary)
    .catch(error => {
      console.error(`FreeScout cleanup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
