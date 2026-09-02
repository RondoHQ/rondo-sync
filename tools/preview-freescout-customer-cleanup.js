require('dotenv/config');

const { freescoutRequestWithRetry, checkCredentials } = require('../lib/freescout-client');
const { openDb, getAllTrackedCustomers } = require('../lib/freescout-db');

const PROFILE_CATEGORIES = {
  phone: customer => [customer.phone, customer.phones, customer._embedded?.phones],
  photo: customer => [customer.photoUrl, customer.photo_url],
  address: customer => [
    customer.address,
    customer.city,
    customer.state,
    customer.zip,
    customer.country,
    customer._embedded?.address
  ],
  company: customer => [customer.company],
  jobTitle: customer => [customer.jobTitle, customer.job_title],
  notes: customer => [customer.notes],
  socialProfiles: customer => [
    customer.socialProfiles,
    customer.social_profiles,
    customer._embedded?.social_profiles
  ],
  websites: customer => [customer.websites, customer._embedded?.websites],
  customFields: customer => [customer.customerFields, customer.customer_fields],
  properties: customer => [customer.properties]
};

function hasValue(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === 'object') return Object.values(value).some(hasValue);
  return true;
}

function classifyCustomer(customer) {
  const categories = [];
  for (const [category, values] of Object.entries(PROFILE_CATEGORIES)) {
    if (values(customer).some(hasValue)) categories.push(category);
  }
  return categories;
}

function buildCleanupPreview(customers, trackedIds) {
  const categoryCounts = Object.fromEntries(Object.keys(PROFILE_CATEGORIES).map(category => [category, 0]));
  let matchedTrackedCustomers = 0;
  let customersWithExtraProfileData = 0;

  for (const customer of customers) {
    if (!trackedIds.has(Number(customer.id))) continue;
    matchedTrackedCustomers++;
    const categories = classifyCustomer(customer);
    if (categories.length > 0) customersWithExtraProfileData++;
    for (const category of categories) categoryCounts[category]++;
  }

  return {
    trackedCustomers: trackedIds.size,
    matchedTrackedCustomers,
    missingTrackedCustomers: trackedIds.size - matchedTrackedCustomers,
    customersWithExtraProfileData,
    categoryCounts
  };
}

async function fetchAllCustomers(request = freescoutRequestWithRetry) {
  const customers = [];
  let page = 1;

  while (true) {
    const response = await request(`/api/customers?page=${page}&pageSize=100`, 'GET', null, {});
    const batch = response.body?._embedded?.customers;
    if (!Array.isArray(batch)) {
      throw new Error('FreeScout customer list returned an invalid response');
    }
    customers.push(...batch);

    const totalPages = Number(response.body?.page?.totalPages || 1);
    if (page >= totalPages) break;
    page++;
  }

  return customers;
}

async function runPreview(options = {}) {
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
    const customers = await fetchAllCustomers(options.request);
    return buildCleanupPreview(customers, trackedIds);
  } finally {
    db.close();
  }
}

function printPreview(preview) {
  console.log('FreeScout customer cleanup preview');
  console.log(`Tracked customer profiles: ${preview.trackedCustomers}`);
  console.log(`Matched in FreeScout: ${preview.matchedTrackedCustomers}`);
  console.log(`Missing in FreeScout: ${preview.missingTrackedCustomers}`);
  console.log(`Profiles with data beyond name/email: ${preview.customersWithExtraProfileData}`);
  for (const [category, count] of Object.entries(preview.categoryCounts)) {
    console.log(`  ${category}: ${count}`);
  }
  console.log('No data was changed. No names, email addresses, customer IDs or field values were printed.');
}

module.exports = { hasValue, classifyCustomer, buildCleanupPreview, fetchAllCustomers, runPreview };

if (require.main === module) {
  runPreview()
    .then(printPreview)
    .catch(error => {
      console.error(`FreeScout cleanup preview failed: ${error.message}`);
      process.exitCode = 1;
    });
}
