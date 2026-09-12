const { photoWindowOpen, runPhotoPilot } = require('./photo-reverse-sync');

/** Read the pending snapshot before mutating it, so pagination cannot skip jobs. */
async function runPhotoQueue({ api, sportlink, knvbId = null, clock = () => new Date(), limit = 25 }) {
  const result = { success: true, synced: 0, failed: 0, actionRequired: 0, results: [] };
  if (!photoWindowOpen(clock())) return result;
  const jobs = [];
  const seen = new Set();
  let page = 1;
  while (page && jobs.length < limit) {
    const response = await api(`rondo/v1/photo-sync-jobs?page=${page}&per_page=50`, 'GET');
    if (!response.window?.open) return result;
    if (!Array.isArray(response.jobs)) throw new Error('Ongeldige fotowachtrij ontvangen.');
    for (const job of response.jobs) {
      if ((knvbId && job.knvb_id !== knvbId) || seen.has(job.person_id)) continue;
      seen.add(job.person_id);
      jobs.push(job);
      if (jobs.length === limit) break;
    }
    if (response.next_page !== null && (!Number.isSafeInteger(response.next_page) || response.next_page <= page)) {
      throw new Error('Ongeldige paginering van de fotowachtrij.');
    }
    page = response.next_page;
  }
  for (const job of jobs) {
    if (!photoWindowOpen(clock())) break;
    const options = { personId: job.person_id, knvbId: job.knvb_id, api, sportlink, clock };
    try {
      const preview = await runPhotoPilot(options);
      if (preview.state !== 'preview') continue;
      // The fresh fingerprint is checked again before claiming and before uploading.
      const outcome = await runPhotoPilot({ ...options, revision: preview.revision, expectedPhotoHash: preview.expectedPhotoHash, apply: true });
      if (outcome.state === 'synced') result.synced++;
      result.results.push({ personId: job.person_id, knvbId: job.knvb_id, ...outcome });
    } catch (error) {
      result.failed++;
      result.success = false;
      // A post-claim failure remains sending/review in WordPress and cannot be retried here.
      result.results.push({ personId: job.person_id, knvbId: job.knvb_id, state: 'error', error: error.message });
    }
  }
  return result;
}

/** Feature flag permits deploying imports first and running the initial canary before cron. */
async function runPhotoSync(options = {}) {
  if (process.env.RONDO_PHOTO_SYNC_ENABLED !== '1') return { success: true, synced: 0, failed: 0, actionRequired: 0, results: [] };
  const { rondoClubRequest } = require('./rondo-club-client');
  const { SportlinkSession } = require('./sportlink-session');
  const { SportlinkPhotoUpload } = require('./sportlink-photo-upload');
  const session = new SportlinkSession(options);
  let adapter;
  const getAdapter = async () => adapter || (adapter = new SportlinkPhotoUpload(await session.getPage()));
  try {
    const result = await runPhotoQueue({
      knvbId: options.knvbId,
      api: async (endpoint, method, data) => (await rondoClubRequest(endpoint, method, data)).body,
      sportlink: {
        read: async (...args) => (await getAdapter()).read(...args),
        upload: async (...args) => (await getAdapter()).upload(...args)
      }
    });
    options.logger?.log(`Photos: ${result.synced} synced, ${result.failed} failed`);
    for (const item of result.results.filter(item => item.state === 'error')) {
      options.logger?.error(`Photo ${item.knvbId}: ${item.error}`);
    }
    return result;
  } finally { await session.close(); }
}

module.exports = { runPhotoQueue, runPhotoSync };
