const { createHash } = require('node:crypto');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function photoWindowOpen(now = new Date()) {
  const month = Number(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Amsterdam', month: 'numeric' }).format(now));
  return month >= 7 && month <= 10;
}

function assertWindow(clock) {
  if (!photoWindowOpen(clock())) throw new Error('Foto’s mogen alleen van 1 juli tot en met 31 oktober naar Sportlink.');
}

/**
 * One explicitly selected person, preview by default. No cron integration.
 * A claim is never retried automatically after an uncertain upload/callback.
 */
async function runPhotoPilot({ personId, knvbId, revision, apply = false, expectedPhotoHash, api, sportlink, clock = () => new Date() }) {
  if (!Number.isSafeInteger(personId) || personId < 1 || !/^[A-Z0-9]{6,10}$/.test(knvbId || '')) {
    throw new Error('Geef één geldig Rondo-persoonsnummer en KNVB-ID op.');
  }
  const endpoint = `rondo/v1/people/${personId}/photo-sync-job`;
  const job = await api(endpoint, 'GET');
  if (job.person_id !== personId || job.knvb_id !== knvbId) throw new Error('Het gekoppelde Sportlink-profiel wijkt af.');
  if (!photoWindowOpen(clock()) || !job.window.open) return { state: 'waiting_window', nextStart: job.window.next_start };
  if (job.state !== 'pending') return { state: job.state };
  const before = await sportlink.read(knvbId);
  if (!apply) {
    return { state: 'preview', personId, knvbId, revision: job.revision, expectedPhotoHash: before.sha256, photoDate: before.photoDate };
  }
  if (!revision || job.revision !== revision) throw new Error('De Rondo-foto is sinds de preview gewijzigd. Maak een nieuwe preview.');
  if (!expectedPhotoHash || before.sha256 !== expectedPhotoHash) throw new Error('De Sportlink-foto wijkt af van de preview. Maak een nieuwe preview.');
  const prepared = await api(`${endpoint}?include_file=true`, 'GET');
  if (prepared.revision !== revision || prepared.knvb_id !== knvbId) throw new Error('De Rondo-foto is intussen gewijzigd.');
  const bytes = Buffer.from(prepared.file?.base64 || '', 'base64');
  if (prepared.file?.mime_type !== 'image/jpeg' || !bytes.length || bytes.length > 5 * 1024 * 1024 || sha256(bytes) !== prepared.file.sha256) {
    throw new Error('De voorbereide foto is ongeldig.');
  }
  const identity = { revision, knvb_id: knvbId };
  assertWindow(clock);
  const claim = await api(endpoint, 'POST', { ...identity, action: 'claim' });
  if (!claim.claim_token) throw new Error('Geen verzendbevestiging ontvangen; controleer de opdracht voor een nieuwe poging.');
  const claimed = { ...identity, claim_token: claim.claim_token };
  try {
    // Recheck immediately before file selection AND before Sportlink's save action.
    // The adapter must also compare the live photo to the reviewed fingerprint.
    assertWindow(clock);
    await sportlink.upload(knvbId, bytes, expectedPhotoHash, () => assertWindow(clock));
    const after = await sportlink.read(knvbId);
    if (!after.photoDate || after.sha256 === 'none' || after.sha256 === before.sha256) {
      throw new Error('De nieuwe Sportlink-foto kon niet worden bevestigd. Controleer de foto voordat je opnieuw probeert.');
    }
    await api(endpoint, 'POST', { ...claimed, action: 'complete', sportlink_photo_date: after.photoDate, verified_sha256: after.sha256 });
    return { state: 'synced' };
  } catch (error) {
    // Never retry an upload after it may have reached Sportlink, including a lost callback.
    try { await api(endpoint, 'POST', { ...claimed, action: 'review' }); } catch { /* A sending job also stays blocked. */ }
    throw error;
  }
}

module.exports = { photoWindowOpen, runPhotoPilot, sha256 };
