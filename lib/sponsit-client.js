const DEFAULT_DETAIL_CONCURRENCY = 3;
const DEFAULT_RETRIES = 3;

/**
 * Fetch the complete Sponsit contact snapshot through authenticated Inertia
 * reads. Index pages provide stable contact IDs; detail pages add stable person
 * IDs, addresses, tags, billing data and dossier metadata.
 */
async function fetchSponsitContacts(options = {}) {
  const {
    session,
    logger = null,
    statusId = null,
    detailConcurrency = DEFAULT_DETAIL_CONCURRENCY,
    retries = DEFAULT_RETRIES,
    onProgress = null
  } = options;

  if (!session || typeof session.requestInertia !== 'function') {
    throw new TypeError('fetchSponsitContacts requires a Sponsit session');
  }
  if (!Number.isInteger(detailConcurrency) || detailConcurrency < 1 || detailConcurrency > 10) {
    throw new RangeError('detailConcurrency must be between 1 and 10');
  }

  const contacts = [];
  let pageNumber = 1;
  let lastPage = 1;

  do {
    const query = new URLSearchParams({ page: String(pageNumber) });
    if (statusId !== null && statusId !== undefined && statusId !== '') {
      query.set('status', String(statusId));
    }

    const payload = await requestWithRetry(
      session,
      `/contacts?${query.toString()}`,
      { retries, logger }
    );
    const paginator = payload?.props?.contacts;
    if (!paginator || !Array.isArray(paginator.data)) {
      throw new Error(`Sponsit contacts page ${pageNumber} has an unexpected payload`);
    }

    lastPage = Number(paginator.last_page || 1);
    contacts.push(...paginator.data);
    logger?.verbose(`Read Sponsit contact index page ${pageNumber}/${lastPage}`);
    pageNumber++;
  } while (pageNumber <= lastPage);

  const uniqueIds = new Set(contacts.map((contact) => contact.id));
  if (uniqueIds.size !== contacts.length || uniqueIds.has(undefined) || uniqueIds.has(null)) {
    throw new Error('Sponsit contact index returned missing or duplicate contact IDs');
  }

  const detailed = new Array(contacts.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= contacts.length) return;
      const indexContact = contacts[index];
      const payload = await requestWithRetry(
        session,
        `/contacts/${indexContact.id}`,
        { retries, logger }
      );
      detailed[index] = normalizeContactDetail(payload, indexContact);
      completed++;
      if (typeof onProgress === 'function') onProgress(completed, contacts.length);
      if (completed === contacts.length || completed % 25 === 0) {
        logger?.verbose(`Read Sponsit contact details ${completed}/${contacts.length}`);
      }
    }
  }

  const workerCount = Math.min(detailConcurrency, Math.max(contacts.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return detailed;
}

async function requestWithRetry(session, relativeUrl, options = {}) {
  const { retries = DEFAULT_RETRIES, logger = null } = options;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await session.requestInertia(relativeUrl);
    } catch (error) {
      lastError = error;
      const retryable = error.retryable === true
        || error.status === 429
        || error.status >= 500;
      if (!retryable || attempt === retries) throw error;
      const delayMs = 500 * (2 ** (attempt - 1));
      logger?.verbose(
        `Retrying Sponsit request ${relativeUrl} after ${delayMs}ms `
        + `(attempt ${attempt + 1}/${retries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function normalizeContactDetail(payload, indexContact = {}) {
  const props = payload?.props;
  if (!props || !props.contact || !props.contact.id) {
    throw new Error('Sponsit contact detail has an unexpected payload');
  }
  if (indexContact.id && Number(indexContact.id) !== Number(props.contact.id)) {
    throw new Error(
      `Sponsit detail ID ${props.contact.id} does not match index ID ${indexContact.id}`
    );
  }

  const people = Array.isArray(props.people) ? props.people : [];
  const personIds = new Set(people.map((person) => person.id));
  if (personIds.size !== people.length || personIds.has(undefined) || personIds.has(null)) {
    throw new Error(`Sponsit contact ${props.contact.id} has missing or duplicate person IDs`);
  }

  return {
    contact: { ...indexContact, ...props.contact },
    people,
    addresses: Array.isArray(props.addresses) ? props.addresses : [],
    billingAddress: props.billingAddress || null,
    dossier: props.dossier || null,
    customfieldDefinitions: Array.isArray(props.customfields) ? props.customfields : []
  };
}

function isActiveSponsor(record) {
  const contact = record?.contact || record || {};
  const status = contact.status || {};
  const code = typeof status === 'object' ? status.code : '';
  const name = typeof status === 'object' ? status.name : status;
  return String(code || '').toLowerCase() === 'sponsor'
    || String(name || '').toLowerCase() === 'sponsor';
}

module.exports = {
  DEFAULT_DETAIL_CONCURRENCY,
  fetchSponsitContacts,
  normalizeContactDetail,
  isActiveSponsor,
  requestWithRetry
};
