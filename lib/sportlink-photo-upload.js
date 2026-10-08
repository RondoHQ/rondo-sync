const { sha256 } = require('./photo-reverse-sync');
const { navigateWithTimeoutCheck } = require('./reverse-sync-sportlink');

/** Selectors inspected in Sportlink Club on 2026-09-12, without uploading. */
class SportlinkPhotoUpload {
  constructor(page) { this.page = page; }

  async readHeader(knvbId) {
    const target = `https://club.sportlink.com/member/member-details/${knvbId}/general`;
    for (let attempt = 0; attempt < 2; attempt++) {
      // A failed request before reauthentication or a redirect must not win
      // over the successful response from the requested member page.
      const responsePromise = this.page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/member/MemberHeader')
          && url.searchParams.get('PublicPersonId') === knvbId
          && response.request().method() === 'GET'
          && response.ok();
      }, { timeout: 30000 }).catch(() => null);
      try {
        await navigateWithTimeoutCheck(this.page, target, {});
        const response = await responsePromise;
        if (this.page.url() !== target || !response) throw new Error('Het gevraagde Sportlink-profiel is niet geladen.');
        // Check the visibly displayed relation code as well as the exact route.
        await this.page.getByText(knvbId, { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
        return await response.json();
      } catch (error) {
        // Retry only this read. Uploads and uncertain post-upload jobs are
        // still never retried automatically.
        if (attempt === 1) throw error;
      }
    }
  }

  async read(knvbId) {
    const data = await this.readHeader(knvbId);
    if (!data.Photo?.Url) {
      if (data.Photo?.PhotoDate) throw new Error('Sportlink geeft een fotodatum zonder foto terug.');
      return { sha256: 'none', photoDate: null };
    }
    const url = new URL(data.Photo.Url);
    if (url.protocol !== 'https:') throw new Error('Sportlink gaf een ongeldige foto-URL terug.');
    // Public signed CDN URL from this member's authenticated response; no Rondo credentials.
    const result = await this.page.request.get(url.href, { timeout: 30000 });
    try {
      if (!result.ok() || !/^image\/(jpeg|png|gif|webp)/i.test(result.headers()['content-type'] || '')) {
        throw new Error('De opgeslagen Sportlink-foto kon niet worden gelezen.');
      }
      const bytes = await result.body();
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('Onverwacht Sportlink-fotobestand.');
      return { sha256: sha256(bytes), photoDate: data.Photo.PhotoDate || null };
    } finally { await result.dispose(); }
  }

  async upload(knvbId, bytes, expectedPhotoHash, assertWindow) {
    const current = await this.read(knvbId);
    if (current.sha256 !== expectedPhotoHash) throw new Error('De Sportlink-foto is intussen gewijzigd.');
    await this.page.locator('#photoUploadDetailPageHeader').click();
    // Existing photos expose "Voeg bestand toe"; profiles without a photo may open the chooser directly.
    const add = this.page.locator('#btnFileUploadAdd');
    const input = this.page.locator('#inputChooseFileHidden');
    await add.or(input).first().waitFor({ state: 'attached', timeout: 15000 });
    if (await add.isVisible()) await add.click();
    await input.waitFor({ state: 'attached', timeout: 15000 });
    assertWindow();
    await input.setInputFiles({ name: 'pasfoto.jpg', mimeType: 'image/jpeg', buffer: bytes });
    const upload = this.page.locator('#btnUploadFile');
    await upload.waitFor({ state: 'visible', timeout: 15000 });
    assertWindow();
    await upload.click({ timeout: 15000 });
    // A crop/error screen or unknown response deliberately stops the pilot for review.
    await upload.waitFor({ state: 'hidden', timeout: 30000 });
  }
}

module.exports = { SportlinkPhotoUpload };
