const fs = require('fs/promises');
const path = require('path');

/**
 * MIME type to file extension mapping
 */
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

/**
 * Extract base MIME type and map to file extension
 */
function mimeToExtension(contentType) {
  const baseType = (contentType || '').split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[baseType] || 'jpg';
}

/**
 * Parse MemberHeader API response
 * Extracts financial block status and photo metadata
 * @param {Object} data - MemberHeader API response
 * @param {string} knvbId - Member KNVB ID
 * @returns {{has_financial_block: number, photo_url: string|null, photo_date: string|null}}
 */
function parseMemberHeaderResponse(data, knvbId) {
  // Handle null/missing Photo object gracefully
  const photoUrl = data?.Photo?.Url || null;
  const photoDate = data?.Photo?.PhotoDate || null;

  // Boolean to integer for SQLite (true -> 1, false/null -> 0)
  const hasFinancialBlock = data?.HasFinancialTransferBlockOwnClub === true ? 1 : 0;

  return {
    has_financial_block: hasFinancialBlock,
    photo_url: photoUrl,
    photo_date: photoDate
  };
}

/**
 * Download photo from URL immediately (while signed URL is fresh)
 * @param {string} photoUrl - Sportlink CDN signed URL
 * @param {string} knvbId - Member KNVB ID
 * @param {string} photosDir - Directory to save photos
 * @param {Object} logger - Logger instance
 * @returns {Promise<{success: boolean, path?: string, bytes?: number}>}
 */
async function downloadPhotoFromUrl(photoUrl, knvbId, photosDir, logger) {
  try {
    const response = await fetch(photoUrl, {
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      // Check for permanent 404 "Not Found" errors
      if (response.status === 404) {
        const body = await response.text();
        if (body === 'Not Found\n' || body === 'Not Found') {
          logger.verbose(`    Photo permanently unavailable (404 Not Found)`);
          return { success: false, permanent_error: true };
        }
      }
      logger.verbose(`    Photo download HTTP ${response.status}`);
      return { success: false, error: `HTTP ${response.status}` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100) {
      logger.verbose(`    Photo too small (${buffer.length} bytes), skipping`);
      return { success: false, error: `photo too small (${buffer.length} bytes)` };
    }

    const contentType = response.headers.get('content-type');
    const ext = mimeToExtension(contentType);
    const filepath = path.join(photosDir, `${knvbId}.${ext}`);
    await fs.writeFile(filepath, buffer);

    return { success: true, path: filepath, bytes: buffer.length };
  } catch (error) {
    // Surface the underlying cause (e.g. EACCES on write, fetch timeout) so it
    // reaches the run summary / dashboard instead of a generic message. Diagnosing
    // a permission error on the photos dir previously required a manual verbose run.
    logger.verbose(`    Photo download error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

module.exports = {
  MIME_TO_EXT,
  mimeToExtension,
  parseMemberHeaderResponse,
  downloadPhotoFromUrl
};
