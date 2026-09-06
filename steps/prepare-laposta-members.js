require('dotenv/config');

const fs = require('fs/promises');
const path = require('path');
const {
  openDb,
  upsertMembers,
  deleteMembersNotInList,
  getLatestSportlinkResults,
  getMembersForList,
  computeSourceHash
} = require('../lib/laposta-db');
const { normalizeEmail, isValidEmail, buildChildFullName, hasValue } = require('../lib/parent-dedupe');
const { openDb: openRondoClubDb, getVolunteerStatusMap } = require('../lib/rondo-club-db');
const { readEnv, parseCliArgs } = require('../lib/utils');
const { createLoggerAdapter } = require('../lib/log-adapters');
const {
  fetchVolunteerObligationMaps,
  resolveLapostaObligationValue
} = require('../lib/volunteer-obligation-sync');

const DEFAULT_MAPPING = path.join(process.cwd(), 'config/field-mapping.json');
const MAX_LISTS = 4;
const LIST_ENV_KEYS = ['LAPOSTA_LIST', 'LAPOSTA_LIST2', 'LAPOSTA_LIST3', 'LAPOSTA_LIST4'];

const EMAIL_FIELDS = [
  { key: 'Email', type: 'primary' },
  { key: 'EmailAlternative', type: 'alternative' },
  { key: 'EmailAddressParent1', type: 'parent1' },
  { key: 'EmailAddressParent2', type: 'parent2' }
];

const EXCLUDED_CUSTOM_FIELDS = new Set([
  '{{email}}',
  'emailadres2',
  'emailouder1',
  'emailouder2'
]);

/**
 * Get latest Sportlink results from database.
 * @returns {string|null} Results JSON or null
 */
function getLatestResultsFromDb() {
  const db = openDb();
  try {
    return getLatestSportlinkResults(db);
  } finally {
    db.close();
  }
}

/**
 * Build base custom fields from member data using mapping.
 * @param {Object} member - Sportlink member
 * @param {Object} mapping - Field mapping configuration
 * @returns {Object} Custom fields object
 */
function buildBaseCustomFields(member, mapping) {
  const customFields = {};

  Object.entries(mapping).forEach(([lapostaField, sportlinkField]) => {
    if (EXCLUDED_CUSTOM_FIELDS.has(lapostaField)) return;

    const value = member[sportlinkField];
    if (!hasValue(value)) return;

    // Normalize gender values
    if (lapostaField === 'geslacht') {
      const normalized = String(value).trim();
      if (normalized === 'Male') {
        customFields[lapostaField] = 'M';
        return;
      }
      if (normalized === 'Female') {
        customFields[lapostaField] = 'V';
        return;
      }
    }

    customFields[lapostaField] = value;
  });

  return customFields;
}

/**
 * Build name parts for a member.
 * @param {Object} member - Sportlink member
 * @returns {{voornaam: string, tussenvoegsel: string, achternaam: string}}
 */
function buildMemberNameParts(member) {
  return {
    voornaam: hasValue(member.FirstName) ? String(member.FirstName).trim() : '',
    tussenvoegsel: hasValue(member.Infix) ? String(member.Infix).trim() : '',
    achternaam: hasValue(member.LastName) ? String(member.LastName).trim() : ''
  };
}

/**
 * Build name parts for a parent entry.
 * @param {Object} member - Sportlink member
 * @param {string} parentNameKey - 'NameParent1' or 'NameParent2'
 * @returns {{voornaam: string, tussenvoegsel: string, achternaam: string}}
 */
function buildParentNameParts(member, parentNameKey) {
  const parentName = member[parentNameKey];

  if (hasValue(parentName)) {
    return {
      voornaam: String(parentName).trim(),
      tussenvoegsel: '',
      achternaam: ''
    };
  }

  const firstName = hasValue(member.FirstName) ? String(member.FirstName).trim() : '';
  const infix = hasValue(member.Infix) ? String(member.Infix).trim() : '';
  const lastName = hasValue(member.LastName) ? String(member.LastName).trim() : '';

  return {
    voornaam: `Ouder/verzorger van ${firstName}`.trim(),
    tussenvoegsel: infix,
    achternaam: lastName
  };
}

/**
 * Normalize comma-separated values to array.
 * @param {*} value - Value to normalize
 * @returns {string[]} Array of trimmed values
 */
function normalizeCommaValues(value) {
  if (!hasValue(value)) return [];

  if (Array.isArray(value)) {
    return value
      .flatMap(item => String(item).split(','))
      .map(item => item.trim())
      .filter(Boolean);
  }

  if (value instanceof Set) {
    return Array.from(value)
      .flatMap(item => String(item).split(','))
      .map(item => item.trim())
      .filter(Boolean);
  }

  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Merge comma-separated values into custom field.
 * @param {Object} customFields - Custom fields object
 * @param {string} fieldKey - Field key
 * @param {*} newValue - Value to merge
 */
function mergeCommaField(customFields, fieldKey, newValue) {
  const values = normalizeCommaValues(newValue);
  if (values.length === 0) return;

  const existing = hasValue(customFields[fieldKey])
    ? String(customFields[fieldKey]).split(',').map(item => item.trim()).filter(Boolean)
    : [];

  const merged = Array.from(new Set([...existing, ...values]));
  if (merged.length > 0) {
    customFields[fieldKey] = merged.join(', ');
  }
}

/**
 * Merge child names into oudervan field.
 * @param {Object} customFields - Custom fields object
 * @param {string[]} names - Child names to merge
 */
function mergeOuderVan(customFields, names) {
  if (!names || names.length === 0) return;

  const existing = hasValue(customFields.oudervan)
    ? customFields.oudervan.split(',').map(item => item.trim()).filter(Boolean)
    : [];

  const merged = Array.from(new Set([...existing, ...names]));
  if (merged.length > 0) {
    customFields.oudervan = merged.join(', ');
  }
}

/**
 * Clear personal fields for standalone parent entries.
 * @param {Object} customFields - Custom fields object
 * @returns {Object} Updated custom fields
 */
function clearStandaloneParentFields(customFields) {
  return {
    ...customFields,
    datumpasfoto: '',
    geslacht: '',
    geboortedatum: '',
    lidsinds: '',
    mobielnummer: ''
  };
}

/**
 * Build parent custom fields configuration.
 * @param {Object} params
 * @param {Object} params.member - Sportlink member
 * @param {string} params.email - Parent email
 * @param {string} params.parentNumber - '1' or '2'
 * @param {Object} params.baseCustomFields - Base custom fields
 * @param {Map} params.parentNamesMap - Parent to child names mapping
 * @param {Map} params.parentTeamsMap - Parent to teams mapping
 * @param {Map} params.parentAgeClassMap - Parent to age class mapping
 * @param {Map} params.memberNameMap - Email to member name mapping
 * @param {boolean} params.isStandaloneParent - Whether parent has no member entry
 * @returns {Object} Custom fields for parent entry
 */
function buildParentCustomFields(params) {
  const {
    member,
    email,
    parentNumber,
    baseCustomFields,
    parentNamesMap,
    parentTeamsMap,
    parentAgeClassMap,
    memberNameMap,
    isStandaloneParent
  } = params;

  const normalized = normalizeEmail(email);
  const nameKey = `NameParent${parentNumber}`;
  const phoneKey = `TelephoneParent${parentNumber}`;

  // Get name from member name map or build from parent name field
  const memberName = memberNameMap.get(normalized);
  const parentName = memberName && (hasValue(memberName.voornaam) || hasValue(memberName.achternaam))
    ? memberName
    : buildParentNameParts(member, nameKey);

  let customFields = {
    ...baseCustomFields,
    voornaam: parentName.voornaam,
    tussenvoegsel: parentName.tussenvoegsel,
    achternaam: parentName.achternaam
  };

  // Remove parent-specific fields
  delete customFields.naamouder1;
  delete customFields.telefoonouder1;
  delete customFields.naamouder2;
  delete customFields.telefoonouder2;

  if (isStandaloneParent) {
    customFields = clearStandaloneParentFields(customFields);
    const phone = member[phoneKey];
    customFields.telefoonnummer = hasValue(phone) ? String(phone).trim() : '';
  }

  // Merge aggregated data
  mergeOuderVan(customFields, parentNamesMap.get(normalized));
  mergeCommaField(customFields, 'team', parentTeamsMap.get(normalized));
  mergeCommaField(customFields, 'leeftijdscategorie', parentAgeClassMap.get(normalized));

  return customFields;
}

/**
 * Build Laposta member entry.
 * @param {Object} params
 * @param {Object} params.member - Sportlink member
 * @param {string} params.email - Email address
 * @param {string} params.emailType - 'primary', 'alternative', 'parent1', or 'parent2'
 * @param {Object} params.baseCustomFields - Base custom fields
 * @param {Map} params.parentNamesMap - Parent to child names mapping
 * @param {Map} params.parentTeamsMap - Parent to teams mapping
 * @param {Map} params.parentAgeClassMap - Parent to age class mapping
 * @param {Map} params.memberNameMap - Email to member name mapping
 * @param {boolean} params.isStandaloneParent - Whether parent has no member entry
 * @returns {{email: string, custom_fields: Object}}
 */
function buildMemberEntry(params) {
  const {
    member,
    email,
    emailType,
    baseCustomFields,
    parentNamesMap,
    parentTeamsMap,
    parentAgeClassMap,
    memberNameMap,
    isStandaloneParent
  } = params;

  let customFields = { ...baseCustomFields };

  // Handle parent entries
  if (emailType === 'parent1' || emailType === 'parent2') {
    const parentNumber = emailType === 'parent1' ? '1' : '2';
    customFields = buildParentCustomFields({
      member,
      email,
      parentNumber,
      baseCustomFields,
      parentNamesMap,
      parentTeamsMap,
      parentAgeClassMap,
      memberNameMap,
      isStandaloneParent
    });

    // Parents are never volunteers themselves
    customFields.huidigvrijwilliger = '0';
  }

  // Handle primary/alternative entries that share email with parent
  if (emailType === 'primary' || emailType === 'alternative') {
    const normalized = normalizeEmail(email);
    const parentEmail1 = normalizeEmail(member.EmailAddressParent1);
    const parentEmail2 = normalizeEmail(member.EmailAddressParent2);
    const usesParentEmail = normalized && (normalized === parentEmail1 || normalized === parentEmail2);

    if (usesParentEmail) {
      const parentNumber = normalized === parentEmail1 ? '1' : '2';
      const parentName = memberNameMap.get(normalized)
        || buildParentNameParts(member, `NameParent${parentNumber}`);
      Object.assign(customFields, parentName);
      mergeOuderVan(customFields, parentNamesMap.get(normalized));
    } else {
      mergeOuderVan(customFields, parentNamesMap.get(normalized));
      mergeCommaField(customFields, 'team', parentTeamsMap.get(normalized));
      mergeCommaField(customFields, 'leeftijdscategorie', parentAgeClassMap.get(normalized));
    }
  }

  return {
    email,
    custom_fields: customFields
  };
}

/**
 * Build aggregation maps for parent data.
 * @param {Array} members - Sportlink members
 * @param {Object} mapping - Field mapping
 * @returns {{parentNamesMap: Map, parentTeamsMap: Map, parentAgeClassMap: Map, memberNameMap: Map}}
 */
function buildAggregationMaps(members, mapping) {
  const teamFieldKey = mapping.team;
  const leeftijdFieldKey = mapping.leeftijdscategorie;

  const memberNameMap = new Map();
  const parentNamesMap = new Map();
  const parentTeamsMap = new Map();
  const parentAgeClassMap = new Map();

  // A child's primary address often belongs to their parent. Exclude every
  // known child before resolving an email to a member's personal name.
  const parentRecipients = new Map();
  for (const member of members) {
    for (const number of [1, 2]) {
      const email = normalizeEmail(member[`EmailAddressParent${number}`]);
      if (!isValidEmail(email)) continue;
      if (!parentRecipients.has(email)) {
        parentRecipients.set(email, { children: new Set(), names: new Map() });
      }
      const recipient = parentRecipients.get(email);
      recipient.children.add(member);
      const name = member[`NameParent${number}`];
      if (hasValue(name)) {
        recipient.names.set(String(name).trim().toLowerCase(), buildParentNameParts(member, `NameParent${number}`));
      }
    }
  }

  for (const [email, recipient] of parentRecipients) {
    const memberNames = new Map();
    for (const member of members) {
      if (recipient.children.has(member)) continue;
      if (normalizeEmail(member.Email) !== email) continue;
      const name = buildMemberNameParts(member);
      if (!name.voornaam && !name.achternaam) continue;
      memberNames.set(JSON.stringify(name).toLowerCase(), name);
    }
    if (memberNames.size === 1) {
      memberNameMap.set(email, memberNames.values().next().value);
    } else if (recipient.names.size === 1) {
      memberNameMap.set(email, recipient.names.values().next().value);
    } else if (recipient.names.size > 1 || memberNames.size > 1) {
      // Shared mailboxes with conflicting identities must not pick a person
      // based on Sportlink row order.
      memberNameMap.set(email, { voornaam: 'Ouder/verzorger', tussenvoegsel: '', achternaam: '' });
    }
  }

  // Build parent aggregation maps
  members.forEach(member => {
    const childName = buildChildFullName(member);
    const teamValue = teamFieldKey ? member[teamFieldKey] : '';
    const leeftijdValue = leeftijdFieldKey ? member[leeftijdFieldKey] : '';

    EMAIL_FIELDS
      .filter(field => field.type === 'parent1' || field.type === 'parent2')
      .forEach(({ key }) => {
        const emailValue = member[key];
        if (!isValidEmail(emailValue)) return;

        const normalized = normalizeEmail(emailValue);

        // Aggregate child names
        if (!parentNamesMap.has(normalized)) {
          parentNamesMap.set(normalized, []);
        }
        if (childName) {
          const existing = parentNamesMap.get(normalized);
          if (!existing.includes(childName)) {
            existing.push(childName);
          }
        }

        // Aggregate teams
        if (!parentTeamsMap.has(normalized)) {
          parentTeamsMap.set(normalized, new Set());
        }
        normalizeCommaValues(teamValue).forEach(team => parentTeamsMap.get(normalized).add(team));

        // Aggregate age classes
        if (!parentAgeClassMap.has(normalized)) {
          parentAgeClassMap.set(normalized, new Set());
        }
        normalizeCommaValues(leeftijdValue).forEach(category => parentAgeClassMap.get(normalized).add(category));
      });
  });

  return { parentNamesMap, parentTeamsMap, parentAgeClassMap, memberNameMap };
}

/**
 * Process members into list entries with deduplication.
 * @param {Array} members - Sportlink members
 * @param {Object} mapping - Field mapping
 * @param {Object} aggregationMaps - Maps from buildAggregationMaps
 * @returns {{listMembers: Array[], excludedCount: number}}
 */
function processMembers(members, mapping, aggregationMaps, volunteerStatusMap, volunteerObligationMaps) {
  const { parentNamesMap, parentTeamsMap, parentAgeClassMap, memberNameMap } = aggregationMaps;

  // Build set of primary emails
  const primaryEmails = new Set();
  members.forEach(member => {
    if (isValidEmail(member.Email)) {
      primaryEmails.add(normalizeEmail(member.Email));
    }
  });

  const listMembers = Array.from({ length: MAX_LISTS }, () => []);
  const emailAssignmentCount = new Map();
  const parentEmailAssigned = new Set();
  let excludedCount = 0;

  // Build map of email usage for deduplication
  const emailUsageMap = new Map();
  members.forEach((member, memberIndex) => {
    EMAIL_FIELDS.forEach(({ key }) => {
      const emailValue = member[key];
      if (!isValidEmail(emailValue)) return;
      const normalized = normalizeEmail(emailValue);
      if (!emailUsageMap.has(normalized)) {
        emailUsageMap.set(normalized, new Set());
      }
      emailUsageMap.get(normalized).add(memberIndex);
    });
  });

  members.forEach(member => {
    const baseCustomFields = buildBaseCustomFields(member, mapping);

    // Add volunteer status from Rondo Club (not in field-mapping.json, comes from Rondo Club DB)
    const knvbId = member.PublicPersonId;
    if (knvbId && volunteerStatusMap.has(String(knvbId))) {
      baseCustomFields.huidigvrijwilliger = String(volunteerStatusMap.get(String(knvbId)));
    } else {
      baseCustomFields.huidigvrijwilliger = '0';
    }

    const dedupeLocal = new Set();
    const primaryEmail = member.Email;
    const normalizedPrimary = isValidEmail(primaryEmail) ? normalizeEmail(primaryEmail) : '';

    EMAIL_FIELDS.forEach(({ key, type }) => {
      const emailValue = member[key];
      if (!isValidEmail(emailValue)) return;

      const normalized = normalizeEmail(emailValue);
      if (dedupeLocal.has(normalized)) return;

      // Skip parent1 if same as primary and only used once
      if (type === 'parent1' && normalizedPrimary && normalized === normalizedPrimary) {
        const usage = emailUsageMap.get(normalized);
        if (usage && usage.size === 1) return;
      }

      // Skip parent emails that are already primary emails
      if ((type === 'parent1' || type === 'parent2') && primaryEmails.has(normalized)) return;

      // Skip parent emails already assigned
      if ((type === 'parent1' || type === 'parent2') && parentEmailAssigned.has(normalized)) return;

      const isStandaloneParent = (type === 'parent1' || type === 'parent2') && !primaryEmails.has(normalized);

      const newEntry = buildMemberEntry({
        member,
        email: emailValue.trim(),
        emailType: type,
        baseCustomFields,
        parentNamesMap,
        parentTeamsMap,
        parentAgeClassMap,
        memberNameMap,
        isStandaloneParent
      });

      const obligationValue = resolveLapostaObligationValue(volunteerObligationMaps, {
        knvbId,
        email: emailValue,
        emailType: type
      });
      if (obligationValue !== undefined) {
        newEntry.custom_fields.vrijwilligersplicht = obligationValue;
      }

      const usedCount = emailAssignmentCount.get(normalized) || 0;
      if (usedCount >= MAX_LISTS) {
        excludedCount += 1;
        return;
      }

      emailAssignmentCount.set(normalized, usedCount + 1);
      listMembers[usedCount].push(newEntry);
      dedupeLocal.add(normalized);

      if (type === 'parent1' || type === 'parent2') {
        parentEmailAssigned.add(normalized);
      }
    });
  });

  return { listMembers, excludedCount };
}

/**
 * Prepare Laposta members from Sportlink data.
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {string} [options.inputPath] - Optional input JSON file path
 * @param {string} [options.mappingPath] - Optional field mapping file path
 * @returns {Promise<{success: boolean, lists: Array, excluded: number, error?: string}>}
 */
async function runPrepare(options = {}) {
  const { logger, verbose = false, inputPath, mappingPath } = options;
  const { verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });

  try {
    const resolvedMappingPath = mappingPath || DEFAULT_MAPPING;

    const [inputContent, mappingContent] = await Promise.all([
      inputPath ? fs.readFile(inputPath, 'utf8') : Promise.resolve(getLatestResultsFromDb()),
      fs.readFile(resolvedMappingPath, 'utf8')
    ]);

    if (!inputContent) {
      const errorMsg = 'No Sportlink results found in SQLite. Run the download first.';
      logError(errorMsg);
      return { success: false, lists: [], excluded: 0, error: errorMsg };
    }

    const sportlinkData = JSON.parse(inputContent);
    const mapping = JSON.parse(mappingContent);
    const members = Array.isArray(sportlinkData.Members) ? sportlinkData.Members : [];

    // Build aggregation maps and process members
    const aggregationMaps = buildAggregationMaps(members, mapping);

    // Load volunteer status from Rondo Club DB
    let volunteerStatusMap = new Map();
    try {
      const rondoClubDb = openRondoClubDb();
      try {
        volunteerStatusMap = getVolunteerStatusMap(rondoClubDb);
      } finally {
        rondoClubDb.close();
      }
    } catch (e) {
      logVerbose('Could not load volunteer status from Rondo Club DB, defaulting all to 0');
    }

    // Load the current-season, derived volunteer obligation from Rondo Club.
    // If this read fails, omit the field entirely so Laposta keeps its last known
    // value instead of replacing it with an incorrect blank/default.
    let volunteerObligationMaps = null;
    try {
      volunteerObligationMaps = await fetchVolunteerObligationMaps({ logger, verbose });
      logVerbose(
        `Loaded ${volunteerObligationMaps.unitCount} volunteer obligation units`
        + (volunteerObligationMaps.season ? ` for ${volunteerObligationMaps.season}` : '')
      );
    } catch (e) {
      logVerbose(`Could not load volunteer obligations from Rondo Club: ${e.message}`);
    }

    const { listMembers, excludedCount } = processMembers(
      members,
      mapping,
      aggregationMaps,
      volunteerStatusMap,
      volunteerObligationMaps
    );

    // Persist to database and calculate update counts
    const db = openDb();
    const updateCounts = [];

    try {
      listMembers.forEach((membersForList, index) => {
        const listIndex = index + 1;
        const existingMembers = getMembersForList(db, listIndex);
        const existingByEmail = new Map(
          existingMembers.map(m => [normalizeEmail(m.email), m])
        );

        const updateCount = membersForList.reduce((count, m) => {
          const normalized = normalizeEmail(m.email);
          const existing = existingByEmail.get(normalized);
          const newHash = computeSourceHash(m.email, m.custom_fields || {});

          if (!existing || !existing.last_synced_hash || existing.last_synced_hash !== newHash) {
            return count + 1;
          }
          return count;
        }, 0);

        updateCounts.push(updateCount);

        const listId = readEnv(LIST_ENV_KEYS[index]) || null;
        upsertMembers(db, listIndex, listId, membersForList);
        deleteMembersNotInList(db, listIndex, membersForList.map(m => m.email));
      });
    } finally {
      db.close();
    }

    // Build result stats
    const lists = listMembers.map((membersForList, index) => ({
      index: index + 1,
      total: membersForList.length,
      updates: updateCounts[index]
    }));

    // Log verbose details
    lists.forEach(({ index, total, updates }) => {
      logVerbose(`Prepared ${total} Laposta members for list ${index} (${updates} updates)`);
    });

    if (excludedCount > 0) {
      logError(`Members excluded due to duplicate Email (all lists full): ${excludedCount}`);
    }

    return {
      success: true,
      lists,
      excluded: excludedCount
    };
  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error:', errorMsg);
    return { success: false, lists: [], excluded: 0, error: errorMsg };
  }
}

module.exports = { runPrepare, buildAggregationMaps, processMembers };

// CLI entry point
if (require.main === module) {
  const { verbose } = parseCliArgs();
  const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const inputPath = args[0] || null;
  const mappingPath = args[1] || null;

  runPrepare({ verbose, inputPath, mappingPath })
    .then(result => {
      if (!result.success) {
        process.exitCode = 1;
        return;
      }

      if (!verbose) {
        result.lists.forEach(({ index, total, updates }) => {
          console.log(`Prepared ${total} Laposta members for list ${index} (${updates} updates).`);
        });
        if (result.excluded > 0) {
          console.error(`Members excluded due to duplicate Email (all lists full): ${result.excluded}`);
        }
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
