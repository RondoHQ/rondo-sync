require('dotenv/config');

const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const FormData = require('form-data');
const { openDb, getMembersByPhotoState, updatePhotoState, clearPhotoState } = require('../lib/rondo-club-db');
const { createSyncLogger } = require('../lib/logger');
const { readEnv } = require('../lib/utils');
const { createLoggerAdapter } = require('../lib/log-adapters');

/**
 * Validate Rondo Club credentials exist
 * @throws {Error} If credentials are missing or invalid
 */
function validateCredentials() {
  const url = readEnv('RONDO_URL');
  const username = readEnv('RONDO_USERNAME');
  const password = readEnv('RONDO_APP_PASSWORD');

  if (!url || !username || !password) {
    throw new Error('RONDO_URL, RONDO_USERNAME, and RONDO_APP_PASSWORD required in .env');
  }

  if (!url.startsWith('https://')) {
    throw new Error('RONDO_URL must start with https://');
  }
}

/**
 * Helper for rate limiting between API requests
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find photo file for member by checking supported extensions
 * @param {string} knvbId - Member KNVB ID
 * @param {string} photosDir - Photos directory path
 * @returns {Promise<{found: boolean, path: string|null, ext: string|null}>}
 */
async function findPhotoFile(knvbId, photosDir) {
  const extensions = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

  for (const ext of extensions) {
    const filepath = path.join(photosDir, `${knvbId}.${ext}`);
    try {
      await fs.access(filepath);
      return { found: true, path: filepath, ext };
    } catch {
      // File doesn't exist with this extension, continue
    }
  }

  return { found: false, path: null, ext: null };
}

/**
 * Upload photo to Rondo Club WordPress via multipart/form-data
 * @param {number} rondoClubId - WordPress person post ID
 * @param {string} photoPath - Local path to photo file
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<void>}
 */
function uploadPhotoToRondoClub(rondoClubId, photoPath, options = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      validateCredentials();
    } catch (error) {
      reject(error);
      return;
    }

    const { logger, verbose = false } = options;
    const { verbose: logVerbose } = createLoggerAdapter({ logger, verbose });

    const baseUrl = readEnv('RONDO_URL');
    const username = readEnv('RONDO_USERNAME');
    const password = readEnv('RONDO_APP_PASSWORD');

    // Build Basic Auth header
    const authString = `${username}:${password}`;
    const authHeader = `Basic ${Buffer.from(authString).toString('base64')}`;

    // Parse base URL and build full path
    const parsedUrl = new URL(baseUrl);
    const fullPath = `/wp-json/rondo/v1/people/${rondoClubId}/photo`;

    logVerbose(`POST ${fullPath}`);

    // Create form data with photo file
    const form = new FormData();
    form.append('file', require('fs').createReadStream(photoPath));

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: fullPath,
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        ...form.getHeaders()
      },
      timeout: 30000 // 30 second timeout
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        logVerbose(`Response status: ${res.statusCode}`);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          const error = new Error(`Rondo Club API error (${res.statusCode})`);
          error.details = data;
          reject(error);
        }
      });
    });

    req.on('error', (err) => {
      if (err.code === 'ETIMEDOUT') {
        const timeoutError = new Error('Request timeout: Rondo Club API did not respond within 30 seconds');
        timeoutError.code = 'ETIMEDOUT';
        reject(timeoutError);
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      const timeoutError = new Error('Request timeout: Rondo Club API did not respond within 30 seconds');
      timeoutError.code = 'ETIMEDOUT';
      reject(timeoutError);
    });

    form.pipe(req);
  });
}

/**
 * Delete photo from Rondo Club WordPress
 * @param {number} rondoClubId - WordPress person post ID
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<void>}
 */
function deletePhotoFromRondoClub(rondoClubId, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      validateCredentials();
    } catch (error) {
      reject(error);
      return;
    }

    const { logger, verbose = false } = options;
    const { verbose: logVerbose } = createLoggerAdapter({ logger, verbose });

    const baseUrl = readEnv('RONDO_URL');
    const username = readEnv('RONDO_USERNAME');
    const password = readEnv('RONDO_APP_PASSWORD');

    // Build Basic Auth header
    const authString = `${username}:${password}`;
    const authHeader = `Basic ${Buffer.from(authString).toString('base64')}`;

    // Parse base URL and build full path
    const parsedUrl = new URL(baseUrl);
    const fullPath = `/wp-json/rondo/v1/people/${rondoClubId}/photo`;

    logVerbose(`DELETE ${fullPath}`);

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: fullPath,
      method: 'DELETE',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        logVerbose(`Response status: ${res.statusCode}`);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          const error = new Error(`Rondo Club API error (${res.statusCode})`);
          error.details = data;
          reject(error);
        }
      });
    });

    req.on('error', (err) => {
      if (err.code === 'ETIMEDOUT') {
        const timeoutError = new Error('Request timeout: Rondo Club API did not respond within 30 seconds');
        timeoutError.code = 'ETIMEDOUT';
        reject(timeoutError);
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      const timeoutError = new Error('Request timeout: Rondo Club API did not respond within 30 seconds');
      timeoutError.code = 'ETIMEDOUT';
      reject(timeoutError);
    });

    req.end();
  });
}

/**
 * Delete local photo file if it exists
 * @param {string} knvbId - Member KNVB ID
 * @param {string} photosDir - Photos directory path
 * @returns {Promise<boolean>} - True if file was deleted, false if not found
 */
async function deleteLocalPhoto(knvbId, photosDir) {
  const photoFile = await findPhotoFile(knvbId, photosDir);

  if (photoFile.found) {
    await fs.unlink(photoFile.path);
    return true;
  }

  return false;
}

/**
 * Main photo sync orchestration
 * Handles both upload (downloaded -> synced) and delete (pending_delete -> cleared)
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @returns {Promise<Object>} - Sync result
 */
async function runPhotoSync(options = {}) {
  const { logger: providedLogger, verbose = false } = options;
  const logger = providedLogger || createSyncLogger({ verbose });

  const result = {
    success: true,
    upload: {
      total: 0,
      synced: 0,
      skipped: 0,
      errors: []
    },
    delete: {
      total: 0,
      deleted: 0,
      errors: []
    }
  };

  const db = openDb();
  try {
    const photosDir = path.join(process.cwd(), 'photos');

    // ============ UPLOAD PHASE ============
    logger.section('Photo Upload Phase');

    const membersToUpload = getMembersByPhotoState(db, 'downloaded');
    result.upload.total = membersToUpload.length;

    if (membersToUpload.length === 0) {
      logger.log('No photos pending upload');
    } else {
      logger.log(`${membersToUpload.length} photos pending upload`);

      for (let i = 0; i < membersToUpload.length; i++) {
        const member = membersToUpload[i];
        logger.verbose(`Uploading photo ${i + 1}/${membersToUpload.length}: ${member.knvb_id}`);

        // Check if member has rondo_club_id
        if (!member.rondo_club_id) {
          const errorMsg = 'Member has no rondo_club_id - cannot upload photo';
          result.upload.errors.push({ knvb_id: member.knvb_id, message: errorMsg });
          result.upload.skipped++;
          logger.verbose(`  Skipped: ${errorMsg}`);
          continue;
        }

        // Find photo file
        const photoFile = await findPhotoFile(member.knvb_id, photosDir);
        if (!photoFile.found) {
          const errorMsg = 'Photo file not found in photos/ directory';
          result.upload.errors.push({ knvb_id: member.knvb_id, message: errorMsg });
          result.upload.skipped++;
          logger.verbose(`  Skipped: ${errorMsg}`);
          continue;
        }

        // Upload to Rondo Club
        try {
          await uploadPhotoToRondoClub(member.rondo_club_id, photoFile.path, options);
          updatePhotoState(db, member.knvb_id, 'synced');
          result.upload.synced++;
          logger.verbose(`  Uploaded successfully`);
        } catch (error) {
          result.upload.errors.push({
            knvb_id: member.knvb_id,
            rondo_club_id: member.rondo_club_id,
            message: error.message
          });
          logger.verbose(`  Upload failed: ${error.message}`);
          // Continue to next member
        }

        // Rate limit: 2 seconds between API calls
        if (i < membersToUpload.length - 1) {
          await sleep(2000);
        }
      }

      logger.log(`Uploaded ${result.upload.synced}/${result.upload.total} photos`);
      if (result.upload.skipped > 0) {
        logger.log(`  Skipped: ${result.upload.skipped}`);
      }
      if (result.upload.errors.length > 0) {
        logger.log(`  Errors: ${result.upload.errors.length}`);
      }
    }

    // ============ DELETE PHASE ============
    logger.section('Photo Delete Phase');

    const membersToDelete = getMembersByPhotoState(db, 'pending_delete');
    result.delete.total = membersToDelete.length;

    if (membersToDelete.length === 0) {
      logger.log('No photos pending deletion');
    } else {
      logger.log(`${membersToDelete.length} photos pending deletion`);

      for (let i = 0; i < membersToDelete.length; i++) {
        const member = membersToDelete[i];
        logger.verbose(`Deleting photo ${i + 1}/${membersToDelete.length}: ${member.knvb_id}`);

        let localDeleted = false;
        let rondoClubDeleted = false;
        let deleteError = null;

        // Delete from local storage
        try {
          localDeleted = await deleteLocalPhoto(member.knvb_id, photosDir);
          if (localDeleted) {
            logger.verbose(`  Deleted local file`);
          } else {
            logger.verbose(`  No local file found`);
          }
        } catch (error) {
          logger.verbose(`  Local delete failed: ${error.message}`);
          // Continue - try Rondo Club deletion anyway
        }

        // Delete from Rondo Club if member has rondo_club_id
        if (member.rondo_club_id) {
          try {
            await deletePhotoFromRondoClub(member.rondo_club_id, options);
            rondoClubDeleted = true;
            logger.verbose(`  Deleted from Rondo Club`);
          } catch (error) {
            // 404 means no photo exists on Rondo Club - that's the desired state
            if (error.message.includes('404')) {
              rondoClubDeleted = true;
              logger.verbose(`  No photo on Rondo Club (404) - already clean`);
            } else {
              deleteError = error.message;
              logger.verbose(`  Rondo Club delete failed: ${error.message}`);
            }
            // Continue - clear state anyway
          }
        } else {
          logger.verbose(`  No rondo_club_id - skipping Rondo Club deletion`);
        }

        // Clear photo state (marks as no_photo and clears person_image_date)
        clearPhotoState(db, member.knvb_id);
        result.delete.deleted++;

        // Track errors if any occurred
        if (deleteError) {
          result.delete.errors.push({
            knvb_id: member.knvb_id,
            rondo_club_id: member.rondo_club_id,
            message: deleteError
          });
        }

        // Rate limit: 2 seconds between API calls
        if (i < membersToDelete.length - 1) {
          await sleep(2000);
        }
      }

      logger.log(`Deleted ${result.delete.deleted}/${result.delete.total} photos`);
      if (result.delete.errors.length > 0) {
        logger.log(`  Errors: ${result.delete.errors.length}`);
      }
    }

    // Determine overall success
    result.success = result.upload.errors.length === 0 && result.delete.errors.length === 0;
    return result;

  } finally {
    db.close();
  }
}

module.exports = { runPhotoSync, uploadPhotoToRondoClub, findPhotoFile };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');

  runPhotoSync({ verbose })
    .then(result => {
      if (!result.success) {
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
