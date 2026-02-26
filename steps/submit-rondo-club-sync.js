require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const { runPrepare } = require('./prepare-rondo-club-members');
const { runPrepare: runPrepareParents } = require('./prepare-rondo-club-parents');
const {
  openDb,
  upsertMembers,
  getMembersNeedingSync,
  updateSyncState,
  deleteMember,
  getMembersNotInList,
  getAllTrackedMembers,
  upsertParents,
  getParentsNeedingSync,
  updateParentSyncState,
  deleteParent,
  resetParentRondoClubIds,
  getParentsNotInList,
  updateVolunteerStatus
} = require('../lib/rondo-club-db');
const { resolveFieldConflicts, generateConflictSummary } = require('../lib/conflict-resolver');
const { TRACKED_FIELDS } = require('../lib/sync-origin');
const { extractFieldValue } = require('../lib/detect-rondo-club-changes');

/**
 * Build a readable error message with API code/details for logs and summaries.
 * Example: "Rondo Club API error (400) [rest_invalid_type] meta.team is not of type integer."
 * @param {Error & {details?: any}} error
 * @returns {string}
 */
function formatSyncError(error) {
  const base = error?.message || 'Unknown error';
  const details = error?.details;

  if (!details || typeof details !== 'object') {
    return base;
  }

  const code = details.code;
  const detailMessage = typeof details.message === 'string' ? details.message : null;
  const status = details.data?.status || details.status || null;

  const parts = [];
  if (code) parts.push(`[${code}]`);
  if (detailMessage && detailMessage !== base) parts.push(detailMessage);
  if (status && !String(base).includes(`(${status})`)) parts.push(`status=${status}`);

  return parts.length ? `${base} ${parts.join(' ')}` : base;
}

/**
 * Extract tracked field values from member data.
 * Handles both Sportlink format (data object from prepare-rondo-club-members.js)
 * and Rondo Club format (ACF data from WordPress API).
 *
 * @param {Object} data - Member data with ACF fields
 * @returns {Object} Object with field names as keys (using underscores)
 */
function extractTrackedFieldValues(data) {
  const values = {};

  for (const field of TRACKED_FIELDS) {
    values[field] = extractFieldValue(data, field);
  }

  return values;
}

/**
 * Apply conflict resolutions to update payload.
 * Takes the original data object and modifies it with winning values from conflict resolution.
 *
 * @param {Object} originalData - Original update payload
 * @param {Map} resolutions - Map of field -> {value, winner, reason}
 * @returns {Object} Modified data with conflict resolutions applied
 */
function applyResolutions(originalData, resolutions) {
  // Deep clone to avoid modifying original
  const resolvedData = JSON.parse(JSON.stringify(originalData));

  if (!resolvedData.acf) {
    resolvedData.acf = {};
  }

  // Apply each resolution
  for (const [field, resolution] of resolutions.entries()) {
    const value = resolution.value;

    // Convert field names: underscores to hyphens for ACF
    // Contact fields need to be in contact_info array
    if (['email', 'email2', 'mobile', 'phone'].includes(field)) {
      if (!resolvedData.acf.contact_info) {
        resolvedData.acf.contact_info = [];
      }

      const contactInfo = resolvedData.acf.contact_info;

      if (field === 'email') {
        const existing = contactInfo.findIndex(c => c.contact_type === 'email');
        if (existing >= 0) {
          contactInfo[existing].contact_value = value;
        } else if (value !== null) {
          contactInfo.push({ contact_type: 'email', contact_value: value });
        }
      } else if (field === 'email2') {
        const existing = contactInfo.findIndex(c => c.contact_type === 'email2');
        if (existing >= 0) {
          contactInfo[existing].contact_value = value;
        } else if (value !== null) {
          contactInfo.push({ contact_type: 'email2', contact_value: value });
        }
      } else if (field === 'mobile') {
        const existing = contactInfo.findIndex(c => c.contact_type === 'mobile');
        if (existing >= 0) {
          contactInfo[existing].contact_value = value;
        } else if (value !== null) {
          contactInfo.push({ contact_type: 'mobile', contact_value: value });
        }
      } else if (field === 'phone') {
        const existing = contactInfo.findIndex(c => c.contact_type === 'phone');
        if (existing >= 0) {
          contactInfo[existing].contact_value = value;
        } else if (value !== null) {
          contactInfo.push({ contact_type: 'phone', contact_value: value });
        }
      }
    } else {
      // Direct ACF fields - convert underscores to hyphens
      const acfFieldName = field.replace(/_/g, '-');
      resolvedData.acf[acfFieldName] = value;
    }
  }

  return resolvedData;
}

/**
 * Log financial block status change as activity on person
 * Uses Rondo Club's activity endpoint: POST /rondo/v1/people/{id}/activities
 * @param {number} rondoClubId - WordPress person post ID
 * @param {boolean} isBlocked - New financial block status
 * @param {Object} options - Logger and verbose options
 */
async function logFinancialBlockActivity(rondoClubId, isBlocked, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  const activityText = isBlocked
    ? 'Financiele blokkade ingesteld'
    : 'Financiele blokkade opgeheven';

  try {
    await rondoClubRequest(
      `rondo/v1/people/${rondoClubId}/activities`,
      'POST',
      {
        content: activityText,
        activity_type: 'financial_block_change',
        activity_date: new Date().toISOString().split('T')[0]  // YYYY-MM-DD
      },
      options
    );
    logVerbose(`  Logged activity: ${activityText}`);
  } catch (error) {
    // Activity logging is nice-to-have, don't fail sync
    logVerbose(`  Warning: Could not log activity: ${error.message}`);
  }
}

/**
 * Sync a single member to Rondo Club (create or update)
 * Uses local rondo_club_id tracking - no API search needed
 * @param {Object} member - Member record from database
 * @param {Object} db - SQLite database connection
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<{action: string, id: number}>}
 */
async function syncPerson(member, db, options) {
  const { knvb_id, data, source_hash } = member;
  let { rondo_club_id } = member; // Use let so we can clear it on 404
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  if (rondo_club_id) {
    // UPDATE existing person (we know the ID from our database)
    const endpoint = `wp/v2/people/${rondo_club_id}`;
    logVerbose(`Updating existing person: ${rondo_club_id}`);
    logVerbose(`  PUT ${endpoint}`);

    // Get existing person to compare financial block status and resolve conflicts
    let previousBlockStatus = false;
    let existingData = null;
    let conflicts = [];

    try {
      const existing = await rondoClubRequest(`wp/v2/people/${rondo_club_id}`, 'GET', null, options);
      existingData = existing.body;
      previousBlockStatus = existingData.acf?.['financiele-blokkade'] || false;
    } catch (fetchError) {
      // If we can't fetch, continue with update but skip activity comparison
      if (fetchError.message && fetchError.message.includes('404')) {
        // Person was deleted - reset tracking state and create fresh
        logVerbose(`Person ${rondo_club_id} no longer exists (404) - will create fresh`);
        updateSyncState(db, knvb_id, null, null); // Clear rondo_club_id and hash
        rondo_club_id = null; // Clear local variable to trigger CREATE path
      } else {
        logVerbose(`  Could not fetch existing person for activity comparison: ${fetchError.message}`);
      }
    }

    // Only proceed with update if person still exists (not 404 above)
    if (rondo_club_id && existingData) {
      // Resolve conflicts between Sportlink and Rondo Club data
      let updateData = data;
      try {
        const sportlinkData = extractTrackedFieldValues(data);
        const rondoClubData = extractTrackedFieldValues(existingData);

        const resolution = resolveFieldConflicts(member, sportlinkData, rondoClubData, db, options.logger);
        conflicts = resolution.conflicts;

        if (conflicts.length > 0) {
          logVerbose(`  Resolved ${conflicts.length} conflict(s) for ${knvb_id}`);
          updateData = applyResolutions(data, resolution.resolutions);
        }
      } catch (conflictError) {
        // Skip member if conflict resolution fails
        console.error(`ERROR: Conflict resolution failed for ${knvb_id}:`, conflictError.message);
        if (options.logger) {
          options.logger.error(`Skipping ${knvb_id} due to conflict resolution error: ${conflictError.message}`);
        }
        return { action: 'skipped', id: rondo_club_id, conflicts: [], error: conflictError.message };
      }

      try {
        const response = await rondoClubRequest(endpoint, 'PUT', updateData, options);
        updateSyncState(db, knvb_id, source_hash, rondo_club_id);

        // Capture volunteer status from Rondo Club
        const volunteerStatus = existingData.acf?.['huidig-vrijwilliger'] === '1' ? 1 : 0;
        updateVolunteerStatus(db, knvb_id, volunteerStatus);

        // Compare financial block status and log activity if changed
        const newBlockStatus = updateData.acf?.['financiele-blokkade'] || false;
        if (previousBlockStatus !== newBlockStatus) {
          await logFinancialBlockActivity(rondo_club_id, newBlockStatus, options);
        }

        return { action: 'updated', id: rondo_club_id, conflicts };
      } catch (error) {
        // Person was deleted from WordPress - reset tracking state and create fresh
        if (error.message && error.message.includes('404')) {
          logVerbose(`Person ${rondo_club_id} no longer exists (404) - will create fresh`);
          updateSyncState(db, knvb_id, null, null); // Clear rondo_club_id and hash
          rondo_club_id = null; // Clear local variable to trigger CREATE path
        } else {
          console.error(`API Error updating person "${knvb_id}" (ID: ${rondo_club_id}):`);
          console.error(`  Status: ${error.message}`);
          if (error.details) {
            console.error(`  Code: ${error.details.code || 'unknown'}`);
            console.error(`  Message: ${error.details.message || JSON.stringify(error.details)}`);
            if (error.details.data) {
              console.error(`  Data: ${JSON.stringify(error.details.data)}`);
            }
          }
          console.error(`  Payload: ${JSON.stringify(updateData, null, 2)}`);
          throw error;
        }
      }
    }
  }

  // CREATE new person (either never synced or was deleted from WordPress)
  const endpoint = 'wp/v2/people';
  logVerbose(`Creating new person for KNVB ID: ${knvb_id}`);
  logVerbose(`  POST ${endpoint}`);
  try {
    const response = await rondoClubRequest(endpoint, 'POST', data, options);
    const newId = response.body.id;
    updateSyncState(db, knvb_id, source_hash, newId);

    // Capture volunteer status from Rondo Club (newly created person defaults)
    const createVolunteerStatus = response.body.acf?.['huidig-vrijwilliger'] === '1' ? 1 : 0;
    updateVolunteerStatus(db, knvb_id, createVolunteerStatus);

    // Log initial block status for newly created persons
    const newBlockStatus = data.acf?.['financiele-blokkade'] || false;
    if (newBlockStatus) {
      await logFinancialBlockActivity(newId, true, options);
    }

    return { action: 'created', id: newId, conflicts: [] };
  } catch (error) {
    console.error(`API Error creating person "${knvb_id}":`);
    console.error(`  Status: ${error.message}`);
    if (error.details) {
      console.error(`  Code: ${error.details.code || 'unknown'}`);
      console.error(`  Message: ${error.details.message || JSON.stringify(error.details)}`);
      if (error.details.data) {
        console.error(`  Data: ${JSON.stringify(error.details.data)}`);
      }
    }
    console.error(`  Payload: ${JSON.stringify(data, null, 2)}`);
    throw error;
  }
}

/**
 * Relationship type term IDs in the WordPress relationship_type taxonomy.
 * These must match the actual term IDs in the database.
 */
const RELATIONSHIP_TYPE = {
  PARENT: 2,  // "Parent" - the related person is a parent
  CHILD: 3,   // "Child" - the related person is a child
  SIBLING: 4  // "Sibling" - the related person is a sibling
};

/**
 * Check if a relationship has a specific type.
 * Handles both array format (what we write: [3]) and integer format (what API returns: 3).
 * @param {Object} relationship - Relationship object with relationship_type
 * @param {number} typeId - Relationship type ID to check for
 * @returns {boolean}
 */
function hasRelationshipType(relationship, typeId) {
  const type = relationship.relationship_type;
  if (Array.isArray(type)) {
    return type.includes(typeId);
  }
  return type === typeId;
}

/**
 * Update children's parents relationship field (bidirectional linking)
 * Preserves existing parent links, adds new one
 */
async function updateChildrenParentLinks(parentId, childRondoClubIds, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  for (const childId of childRondoClubIds) {
    // Skip if child is the same as parent (prevent self-referential relationships)
    if (childId === parentId) {
      logVerbose(`Skipping self-referential parent link: ${parentId}`);
      continue;
    }

    try {
      // Get existing child record
      const childResponse = await rondoClubRequest(
        `wp/v2/people/${childId}`,
        'GET',
        null,
        options
      );

      const existingRelationships = childResponse.body.acf?.relationships || [];
      const hasParentLink = existingRelationships.some(r =>
        r.related_person === parentId && hasRelationshipType(r, RELATIONSHIP_TYPE.PARENT)
      );

      if (!hasParentLink) {
        const newRelationship = {
          related_person: parentId,
          relationship_type: [RELATIONSHIP_TYPE.PARENT],
          relationship_label: ''
        };
        const mergedRelationships = [...existingRelationships, newRelationship];
        await rondoClubRequest(
          `wp/v2/people/${childId}`,
          'PUT',
          { acf: { relationships: mergedRelationships } },
          options
        );
        logVerbose(`Linked parent ${parentId} to child ${childId}`);
      }
    } catch (error) {
      logVerbose(`Failed to link parent to child ${childId}: ${error.message}`);
      // Continue with other children
    }
  }
}

/**
 * Search for an existing person in Rondo Club by email address
 * @param {string} email - Email to search for
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<number|null>} - Rondo Club person ID if found, null otherwise
 */
async function findPersonByEmail(email, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  try {
    // Use dedicated email lookup endpoint
    const response = await rondoClubRequest(
      `rondo/v1/people/find-by-email?email=${encodeURIComponent(email)}`,
      'GET',
      null,
      options
    );

    const personId = response.body?.id;
    if (personId) {
      logVerbose(`Found existing person ${personId} with email ${email}`);
      return personId;
    }
    return null;
  } catch (error) {
    logVerbose(`Email lookup failed: ${error.message}`);
    return null;
  }
}

/**
 * Sync a single parent to Rondo Club (create or update)
 * Checks for existing person by email before creating new
 * @param {Object} parent - Parent record from preparation
 * @param {Object} db - SQLite database connection
 * @param {Map} knvbIdToRondoClubId - Map of KNVB ID to Rondo Club post ID for children
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<{action: string, id: number}>}
 */
async function syncParent(parent, db, knvbIdToRondoClubId, options) {
  const { email, childKnvbIds, data, source_hash } = parent;
  let { rondo_club_id } = parent;
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  // Resolve child KNVB IDs to Rondo Club post IDs (deduplicate to prevent duplicate relationships)
  const childRondoClubIds = [...new Set(
    childKnvbIds
      .map(knvbId => knvbIdToRondoClubId.get(knvbId))
      .filter(Boolean)
  )];

  // Build relationships array for children
  const childRelationships = childRondoClubIds.map(childId => ({
    related_person: childId,
    relationship_type: [RELATIONSHIP_TYPE.CHILD],
    relationship_label: ''
  }));

  // If no rondo_club_id yet, check if person already exists by email (e.g., they're also a member)
  // Check local database first (reliable and fast), then WordPress API as fallback
  // Important: exclude the parent's own children — in youth clubs, parents often share
  // an email with their children in Sportlink, but they're separate people.
  if (!rondo_club_id) {
    const childKnvbIdSet = new Set(childKnvbIds);
    const memberMatches = db.prepare(
      'SELECT knvb_id, rondo_club_id FROM rondo_club_members WHERE LOWER(email) = LOWER(?) AND rondo_club_id IS NOT NULL'
    ).all(email);
    const nonChildMatch = memberMatches.find(m => !childKnvbIdSet.has(m.knvb_id));
    if (nonChildMatch) {
      logVerbose(`Parent ${email} found as member in local DB (person ${nonChildMatch.rondo_club_id}), will merge`);
      rondo_club_id = nonChildMatch.rondo_club_id;
    } else if (memberMatches.length === 0) {
      // No member match at all — check WordPress API as fallback
      const existingId = await findPersonByEmail(email, options);
      if (existingId) {
        // Verify the API match isn't one of our children either
        const isChild = childRondoClubIds.includes(existingId);
        if (!isChild) {
          logVerbose(`Parent ${email} already exists as person ${existingId}, will merge`);
          rondo_club_id = existingId;
        } else {
          logVerbose(`Parent ${email} found person ${existingId} but it's their own child, will create separate`);
        }
      }
    } else {
      logVerbose(`Parent ${email} only matches own children in local DB, will create separate`);
    }
  }

  if (rondo_club_id) {
    // UPDATE existing person - only add child relationships, don't overwrite other data
    logVerbose(`Updating existing person: ${rondo_club_id}`);

    // Get existing data to merge relationships
    let existingRelationships = [];
    let existingFirstName = '';
    let existingLastName = '';
    let existingKnvbId = null;
    try {
      const existing = await rondoClubRequest(`wp/v2/people/${rondo_club_id}`, 'GET', null, options);
      existingRelationships = existing.body.acf?.relationships || [];
      existingFirstName = existing.body.acf?.first_name || '';
      existingLastName = existing.body.acf?.last_name || '';
      existingKnvbId = existing.body.acf?.['knvb-id'] || null;
    } catch (e) {
      // Person was deleted from WordPress - reset tracking state and create fresh
      if (e.message && e.message.includes('404')) {
        logVerbose(`Person ${rondo_club_id} no longer exists (404) - will create fresh`);
        updateParentSyncState(db, email, null, null); // Clear rondo_club_id and hash
        rondo_club_id = null; // Trigger create path below
      } else {
        logVerbose(`Could not fetch existing person: ${e.message}`);
      }
    }

    // Only proceed with update if person still exists (rondo_club_id not cleared by 404)
    if (rondo_club_id) {
      // Merge: keep all existing non-child relationships, replace child relationships with fresh correct ones.
      // This replaces any old wrong-typed child relations (e.g. old type 9 instead of correct type 3).
      const nonChildRelationships = existingRelationships.filter(r =>
        !hasRelationshipType(r, RELATIONSHIP_TYPE.CHILD) && !hasRelationshipType(r, 9) // 9 = old wrong type
      );
      const newChildRelationships = childRelationships.filter(r =>
        r.related_person !== rondo_club_id // Prevent self-referential relationships
      );
      const mergedRelationships = [...nonChildRelationships, ...newChildRelationships];

      // Determine name to use:
      // - If person has KNVB ID, they're a member - preserve their properly-split name
      // - If no KNVB ID, they're a pure parent - update name from Sportlink
      const isMember = !!existingKnvbId;
      const firstName = isMember ? existingFirstName : (data.acf.first_name || existingFirstName);
      const lastName = isMember ? existingLastName : (data.acf.last_name || existingLastName);

      if (!isMember) {
        logVerbose(`Pure parent - updating name from Sportlink: "${firstName} ${lastName}"`);
      }

      const updateData = {
        acf: {
          first_name: firstName,
          last_name: lastName,
          relationships: mergedRelationships
        }
      };

      await rondoClubRequest(
        `wp/v2/people/${rondo_club_id}`,
        'PUT',
        updateData,
        options
      );
      updateParentSyncState(db, email, source_hash, rondo_club_id);

      // Update children's parent relationship (bidirectional)
      await updateChildrenParentLinks(rondo_club_id, childRondoClubIds, options);

      return { action: 'updated', id: rondo_club_id };
    }
  }

  if (!rondo_club_id) {
    // CREATE new parent (either never synced or was deleted from WordPress)
    logVerbose(`Creating new parent: ${email}`);
    const createData = {
      ...data,
      acf: {
        ...data.acf,
        relationships: childRelationships
      }
    };

    const response = await rondoClubRequest(
      'wp/v2/people',
      'POST',
      createData,
      options
    );
    const newId = response.body.id;
    updateParentSyncState(db, email, source_hash, newId);

    // Update children's parent relationship (bidirectional)
    await updateChildrenParentLinks(newId, childRondoClubIds, options);

    return { action: 'created', id: newId };
  }
}

/**
 * Delete parents that no longer have children in Sportlink
 */
async function deleteOrphanParents(db, currentParentEmails, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});
  const deleted = [];
  const errors = [];

  const toDelete = getParentsNotInList(db, currentParentEmails);

  for (const parent of toDelete) {
    if (!parent.rondo_club_id) {
      deleteParent(db, parent.email);
      continue;
    }

    logVerbose(`Deleting orphan parent: ${parent.email}`);
    try {
      await rondoClubRequest(
        `wp/v2/people/${parent.rondo_club_id}`,
        'DELETE',
        null,
        options
      );
      deleteParent(db, parent.email);
      deleted.push({ email: parent.email, rondo_club_id: parent.rondo_club_id });
    } catch (error) {
      // Ignore 404 errors - person already deleted from WordPress
      if (error.details?.data?.status === 404) {
        logVerbose(`  Already deleted from WordPress (404)`);
        deleteParent(db, parent.email);
        deleted.push({ email: parent.email, rondo_club_id: parent.rondo_club_id });
      } else {
        errors.push({ email: parent.email, message: formatSyncError(error) });
      }
    }
  }

  return { deleted, errors };
}

/**
 * Get hash-unchanged parents that might still need relationship refresh.
 * Returns same shape as getParentsNeedingSync().
 * @param {Object} db - SQLite database connection
 * @returns {Array<{email: string, data: Object, childKnvbIds: string[], source_hash: string, rondo_club_id: number|null}>}
 */
function getUnchangedParents(db) {
  const rows = db.prepare(`
    SELECT email, data_json, source_hash, rondo_club_id
    FROM rondo_club_parents
    WHERE last_synced_hash = source_hash
    ORDER BY email ASC
  `).all();

  return rows.map((row) => {
    const parsed = JSON.parse(row.data_json);
    return {
      email: row.email,
      data: parsed.data || parsed,
      childKnvbIds: parsed.childKnvbIds || [],
      source_hash: row.source_hash,
      rondo_club_id: row.rondo_club_id
    };
  });
}

/**
 * Compare desired child links against current parent relationships in WordPress.
 * Returns true when parent should be re-synced to repair relationships.
 */
async function parentNeedsRelationshipRefresh(parent, knvbIdToRondoClubId, options) {
  if (!parent.rondo_club_id) {
    return true;
  }

  const desiredChildIds = new Set(
    parent.childKnvbIds
      .map(knvbId => knvbIdToRondoClubId.get(knvbId))
      .filter(Boolean)
      .filter(id => id !== parent.rondo_club_id)
  );

  try {
    const existing = await rondoClubRequest(`wp/v2/people/${parent.rondo_club_id}`, 'GET', null, options);
    const existingRelationships = existing.body?.acf?.relationships || [];
    const existingChildIds = new Set(
      existingRelationships
        .filter(r => hasRelationshipType(r, RELATIONSHIP_TYPE.CHILD) || hasRelationshipType(r, 9))
        .map(r => r.related_person)
        .filter(Boolean)
        .filter(id => id !== parent.rondo_club_id)
    );

    if (desiredChildIds.size !== existingChildIds.size) {
      return true;
    }

    for (const childId of desiredChildIds) {
      if (!existingChildIds.has(childId)) {
        return true;
      }
    }

    return false;
  } catch (error) {
    // If parent disappeared from WordPress, force sync to recreate/relink.
    if (error.details?.data?.status === 404) {
      return true;
    }
    const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});
    logVerbose(`Could not verify relationships for ${parent.email}: ${error.message}`);
    return false;
  }
}

/**
 * Find hash-unchanged parents that still need sync because child relationships drifted.
 */
async function getParentsWithStaleRelationships(db, knvbIdToRondoClubId, options) {
  const unchangedParents = getUnchangedParents(db);
  const stale = [];
  for (const parent of unchangedParents) {
    if (await parentNeedsRelationshipRefresh(parent, knvbIdToRondoClubId, options)) {
      stale.push(parent);
    }
  }
  return stale;
}

/**
 * Sync parents to Rondo Club
 * @param {Object} db - SQLite database connection
 * @param {Map} knvbIdToRondoClubId - Map of member KNVB ID to Rondo Club post ID
 * @param {Object} options - Logger, verbose, force options
 * @returns {Promise<Object>} - Parent sync result
 */
async function syncParents(db, knvbIdToRondoClubId, options = {}) {
  const { logger, verbose = false, force = false } = options;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});

  const result = {
    total: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    errors: []
  };

  // Prepare parents from Sportlink
  const prepared = await runPrepareParents({ logger, verbose });
  if (!prepared.success) {
    result.errors.push({ message: prepared.error });
    return result;
  }

  const parents = prepared.parents;
  result.total = parents.length;

  // Upsert to tracking database
  upsertParents(db, parents);

  // Get parents needing sync (includes rondo_club_id from database)
  const needsSync = getParentsNeedingSync(db, force);

  // Guard against stale links when child person IDs changed while parent source data did not.
  if (!force) {
    const staleRelationshipParents = await getParentsWithStaleRelationships(db, knvbIdToRondoClubId, options);
    if (staleRelationshipParents.length > 0) {
      const byEmail = new Map(needsSync.map(parent => [parent.email, parent]));
      for (const parent of staleRelationshipParents) {
        byEmail.set(parent.email, parent);
      }
      needsSync.length = 0;
      needsSync.push(...byEmail.values());
      logVerbose(`Forced ${staleRelationshipParents.length} unchanged parent(s) due to stale relationships`);
    }
  }

  result.skipped = Math.max(0, result.total - needsSync.length);

  logVerbose(`${needsSync.length} parents need sync (${result.skipped} unchanged)`);

  // Sync each parent
  for (let i = 0; i < needsSync.length; i++) {
    const parent = needsSync[i];
    logVerbose(`Syncing parent ${i + 1}/${needsSync.length}: ${parent.email}`);

    try {
      const syncResult = await syncParent(parent, db, knvbIdToRondoClubId, options);
      result.synced++;
      if (syncResult.action === 'created') result.created++;
      if (syncResult.action === 'updated') result.updated++;
    } catch (error) {
      console.error(`ERROR for parent ${parent.email}:`, error.message);
      if (error.details) {
        console.error('Error details:', JSON.stringify(error.details, null, 2));
      }
      result.errors.push({ email: parent.email, message: formatSyncError(error), details: error.details });
    }
  }

  // Delete orphan parents
  const currentEmails = parents.map(p => p.email);
  const deleteResult = await deleteOrphanParents(db, currentEmails, options);
  result.deleted = deleteResult.deleted.length;
  result.errors.push(...deleteResult.errors);

  return result;
}

/**
 * Mark members that were removed from Sportlink as former members
 * @param {Object} db - SQLite database connection
 * @param {Array<string>} currentKnvbIds - Current KNVB IDs from Sportlink
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<{marked: Array, errors: Array}>}
 */
async function markFormerMembers(db, currentKnvbIds, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});
  const marked = [];
  const errors = [];

  // Find members in DB but not in current Sportlink data
  const toMark = getMembersNotInList(db, currentKnvbIds);

  for (const member of toMark) {
    if (!member.rondo_club_id) {
      // Never synced to Rondo Club, just remove from tracking
      deleteMember(db, member.knvb_id);
      continue;
    }

    // Extract first_name and last_name from stored data (required for WordPress PUT)
    let firstName = '';
    let lastName = '';
    try {
      const data = JSON.parse(member.data_json || '{}');
      firstName = data.acf?.first_name || '';
      lastName = data.acf?.last_name || '';
    } catch (e) { /* ignore parse errors */ }

    logVerbose(`Marking as former member: ${member.knvb_id} (${firstName} ${lastName}, Rondo Club ID: ${member.rondo_club_id})`);
    try {
      await rondoClubRequest(
        `wp/v2/people/${member.rondo_club_id}`,
        'PUT',
        { acf: { first_name: firstName, last_name: lastName, former_member: true } },
        options
      );
      // Keep member in tracking DB so we can detect if they rejoin,
      // but clear data_json so they're excluded from active-only queries
      db.prepare('UPDATE rondo_club_members SET data_json = ? WHERE knvb_id = ?').run('{}', member.knvb_id);
      marked.push({ knvb_id: member.knvb_id, rondo_club_id: member.rondo_club_id });
    } catch (error) {
      // Handle 404 - person was deleted from WordPress, remove from tracking
      if (error.details?.data?.status === 404) {
        logVerbose(`  Person no longer exists in WordPress (404) - removing from tracking`);
        deleteMember(db, member.knvb_id);
        marked.push({ knvb_id: member.knvb_id, rondo_club_id: member.rondo_club_id });
      } else {
        errors.push({ knvb_id: member.knvb_id, message: formatSyncError(error) });
      }
    }
  }

  return { marked, errors };
}

/**
 * Main sync orchestration
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force sync all members
 * @param {boolean} [options.includeMembers=true] - Include member sync
 * @param {boolean} [options.includeParents=true] - Include parent sync
 * @returns {Promise<Object>} - Sync result
 */
async function runSync(options = {}) {
  const { logger, verbose = false, force = false, includeMembers = true, includeParents = true } = options;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});
  const logError = logger?.error.bind(logger) || console.error;

  const result = {
    success: true,
    total: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    conflicts: 0,
    errors: []
  };

  try {
    const db = openDb();
    try {
      // Members sync
      if (includeMembers) {
        // Step 1: Prepare members from Sportlink
        const prepared = await runPrepare({ logger, verbose });
        if (!prepared.success) {
          result.success = false;
          result.errors.push({ message: prepared.error || 'Prepare failed' });
          return result;
        }

        const members = prepared.members;
        result.total = members.length;

        // Step 2: Upsert to tracking database
        upsertMembers(db, members);

        // Step 3: Get members needing sync (hash changed or force)
        // This now includes rondo_club_id from database for each member
        const needsSync = getMembersNeedingSync(db, force);
        result.skipped = result.total - needsSync.length;

        logVerbose(`${needsSync.length} members need sync (${result.skipped} unchanged)`);

        // Step 4: Sync each member
        const allConflicts = [];
        for (let i = 0; i < needsSync.length; i++) {
          const member = needsSync[i];
          logVerbose(`Syncing ${i + 1}/${needsSync.length}: ${member.knvb_id}`);

          try {
            const syncResult = await syncPerson(member, db, options);
            result.synced++;
            if (syncResult.action === 'created') result.created++;
            if (syncResult.action === 'updated') result.updated++;
            if (syncResult.action === 'skipped') result.skipped++;

            // Aggregate conflicts from this member
            if (syncResult.conflicts && syncResult.conflicts.length > 0) {
              allConflicts.push(...syncResult.conflicts);
            }
          } catch (error) {
            result.errors.push({
              knvb_id: member.knvb_id,
              email: member.email,
              message: formatSyncError(error)
            });
          }
        }

        // Step 5: Mark former members (removed from Sportlink)
        const currentKnvbIds = members.map(m => m.knvb_id);
        const markResult = await markFormerMembers(db, currentKnvbIds, options);
        result.deleted = markResult.marked.length;
        result.errors.push(...markResult.errors);

        // Generate and log conflict summary for email report
        if (allConflicts.length > 0) {
          const summary = generateConflictSummary(allConflicts);
          if (logger) {
            logger.log(''); // Blank line separator
            logger.log(summary); // "CONFLICTS DETECTED AND RESOLVED" section
          }
          result.conflicts = allConflicts.length;
        }
      }

      // Parents sync
      if (includeParents) {
        // Build KNVB ID to Rondo Club ID mapping from ALL tracked members
        const knvbIdToRondoClubId = new Map();
        const allMembers = getAllTrackedMembers(db);
        allMembers.forEach(m => {
          if (m.knvb_id && m.rondo_club_id) {
            knvbIdToRondoClubId.set(m.knvb_id, m.rondo_club_id);
          }
        });

        logVerbose('Starting parent sync...');
        const parentResult = await syncParents(db, knvbIdToRondoClubId, options);
        result.parents = parentResult;
      }

    } finally {
      db.close();
    }

    result.success = result.errors.length === 0;
    return result;

  } catch (error) {
    result.success = false;
    result.errors.push({ message: formatSyncError(error) });
    logError(`Sync error: ${error.message}`);
    return result;
  }
}

module.exports = { runSync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');
  const parentsOnly = process.argv.includes('--parents-only');
  const skipParents = process.argv.includes('--skip-parents');
  const resetParents = process.argv.includes('--reset-parents');

  // Handle --reset-parents: clear parent tracking so they'll be re-discovered by email
  if (resetParents) {
    const db = openDb();
    const count = resetParentRondoClubIds(db);
    db.close();
    console.log(`Reset ${count} parent tracking record(s). They will be re-discovered by email on next sync.`);
    if (!parentsOnly && !process.argv.includes('--sync')) {
      process.exit(0);
    }
  }

  const options = {
    verbose,
    force,
    includeMembers: !parentsOnly,
    includeParents: !skipParents
  };

  runSync(options)
    .then(result => {
      if (options.includeMembers) {
        console.log(`Rondo Club sync: ${result.synced}/${result.total} synced`);
        console.log(`  Created: ${result.created}`);
        console.log(`  Updated: ${result.updated}`);
        console.log(`  Skipped: ${result.skipped}`);
        console.log(`  Marked as former: ${result.deleted}`);
      }
      if (result.parents) {
        console.log(`Parents: ${result.parents.synced}/${result.parents.total} synced`);
        console.log(`  Created: ${result.parents.created}`);
        console.log(`  Updated: ${result.parents.updated}`);
        console.log(`  Skipped: ${result.parents.skipped}`);
        console.log(`  Deleted: ${result.parents.deleted}`);
      }
      if (result.errors.length > 0) {
        console.error(`  Errors: ${result.errors.length}`);
        result.errors.forEach(e => console.error(`    - ${e.knvb_id || e.email}: ${e.message}`));
        process.exitCode = 1;
      }
      if (result.parents?.errors.length > 0) {
        console.error(`  Parent errors: ${result.parents.errors.length}`);
        result.parents.errors.forEach(e => console.error(`    - ${e.email}: ${e.message}`));
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
