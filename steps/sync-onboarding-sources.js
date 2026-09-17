const { rondoClubRequest } = require('../lib/rondo-club-client');
const { sourceRecord, checkSource, assertTeamHistoryComplete } = require('../lib/onboarding-source');
const { openDb, upsertMembers, getMemberInvoiceDataByKnvbId, getFreeFieldMappings, upsertMemberFreeFields } = require('../lib/rondo-club-db');
const { preparePerson } = require('./prepare-rondo-club-members');
const { syncPerson, RELATIONSHIP_TYPE, hasRelationshipType } = require('./submit-rondo-club-sync');
const { getParentProfileOwnership } = require('../lib/parent-person-resolution');
const { syncFunctionsForMember, syncParentsForMember } = require('../pipelines/sync-individual');
const { syncSingleMember } = require('./submit-rondo-club-player-history');
const { fetchMemberGeneralData, fetchMemberFunctions, fetchMemberDataFromOtherPage, fetchMemberTeamMemberships, parseFunctionsResponse } = require('./download-functions-from-sportlink');

const normalizeEmail = value => String(value || '').trim().toLowerCase();

/** Verify the saved source identities and links using the same contact ownership as the writer. */
async function verifyParentSources({ personId, general, saved, request }) {
  if (saved.errors.length) throw new Error('Parent records or relationships could not be saved');
  const expected = new Set([general.EmailAddressParent1, general.EmailAddressParent2].map(normalizeEmail).filter(Boolean));
  const person = (await request(`wp/v2/people/${personId}`)).body;
  const parents = new Map();
  for (const relation of person.fields.relationships || []) {
    if (!hasRelationshipType(relation, RELATIONSHIP_TYPE.PARENT)) continue;
    const parent = (await request(`wp/v2/people/${relation.related_person_id}`)).body;
    parents.set(Number(parent.id), parent.fields);
  }
  for (const email of expected) {
    const result = (saved.results || []).find(row => normalizeEmail(row.email) === email);
    const parentId = Number(result?.id);
    const fields = parents.get(parentId);
    if (!['created', 'updated'].includes(result?.action) || !fields || parentId === Number(personId)
      || !(fields.relationships || []).some(relation => Number(relation.related_person_id) === Number(personId)
        && hasRelationshipType(relation, RELATIONSHIP_TYPE.CHILD))) {
      throw new Error('Stored parent relationships do not confirm the complete source');
    }
    // Active members, contacts and sponsors keep their own managed contact details,
    // even when a confirmed source parent alias uses a different email address.
    if (!getParentProfileOwnership(fields).preserveContact
      && ![fields.email_1, fields.email_2].map(normalizeEmail).includes(email)) {
      throw new Error('Stored parent addresses do not confirm the complete source');
    }
  }
  if (!expected.size && [...parents.values()].some(fields => [fields.email_1, fields.email_2].some(normalizeEmail))) {
    throw new Error('Stored parent addresses do not confirm the complete source');
  }
  return { success: true };
}

/** The existing people pipeline owns the browser and serializes these targeted reads. */
async function runSourceChecks({ members, observedAt, sourceComplete, page, logger, inventoryOnly = false, checkIds = [] }) {
  if (!sourceComplete) return {
    checked: 0,
    complete: 0,
    errors: [{ message: 'Onboarding source inventory skipped: incomplete Sportlink search' }],
    deferred: []
  };
  const request = (route, method = 'GET', data = null) => rondoClubRequest(route, method, data, { logger });
  const inventory = (await request('rondo/v1/onboarding/sources', 'POST', {
    observed_at: observedAt, sources: members.map(sourceRecord), check_ids: checkIds
  })).body;
  const result = { checked: 0, complete: 0, pending: inventory.pending_count, errors: [], deferred: [] };
  if (inventoryOnly) return result;
  const byId = new Map(members.map(member => [member.PublicPersonId, member]));
  const db = openDb();
  try {
    for (const candidate of inventory.checks) {
      if (checkIds.length && !checkIds.includes(candidate.knvb_id)) continue;
      const member = byId.get(candidate.knvb_id);
      if (!member) continue;
      const id = candidate.knvb_id;
      const lookup = () => db.prepare('SELECT rondo_club_id, retired_into_knvb_id FROM rondo_club_members WHERE knvb_id = ?').get(id);
      try {
        if (lookup()?.retired_into_knvb_id) throw new Error('Retired source identity requires review');
        const outcome = await checkSource({ candidate, member, request, steps: {
          personId: async () => lookup()?.rondo_club_id || null,
          fetch: key => ({
            person: fetchMemberGeneralData, functions: fetchMemberFunctions,
            vog: fetchMemberDataFromOtherPage, teams: fetchMemberTeamMemberships
          })[key](page, id, logger, { strict: true }),
          person: async (general, freeFields) => {
            if (!lookup()?.rondo_club_id) throw new Error('Regular member import must resolve the identity before source completion');
            // Enrollment proof comes from this run's complete SearchMembers response.
            const fresh = { ...member, ...general, MemberSince: member.MemberSince,
              TypeOfMemberDescription: member.TypeOfMemberDescription, RelationEnd: member.RelationEnd };
            upsertMemberFreeFields(db, [freeFields]);
            const prepared = preparePerson(fresh, freeFields, getMemberInvoiceDataByKnvbId(db, id), getFreeFieldMappings(db), { logger });
            const [tracked] = upsertMembers(db, [prepared]);
            const saved = await syncPerson({ ...tracked, rondo_club_id: lookup()?.rondo_club_id, data: prepared.data }, db, { logger });
            if (!['created', 'updated'].includes(saved.action) || saved.error) throw new Error(saved.error || saved.reason || 'Person save skipped');
            const actual = (await request(`wp/v2/people/${saved.id}`)).body.fields;
            if (normalizeEmail(actual.email_1) !== normalizeEmail(general.Email)
              || normalizeEmail(actual.email_2) !== normalizeEmail(general.Email2)
              || (actual.birthdate || null) !== (general.DateOfBirth || null)
              || (actual.datum_vog || null) !== (freeFields.vog_datum || null)) {
              throw new Error('Stored contact, age or VOG data differs from the checked source');
            }
            for (const field of ['knvb_id', 'lid_sinds', 'lid_tot', 'type_lid', 'former_member', 'wacht_op_overschrijving', 'datum_vog']) {
              if (Object.hasOwn(prepared.data.fields, field) && (actual[field] ?? null) !== (prepared.data.fields[field] ?? null)) throw new Error(`Stored field ${field} differs from checked source`);
            }
            return { success: true, personId: saved.id };
          },
          parents: async (personId, general) => {
            const saved = await syncParentsForMember(id, db, { freshMemberData: { ...member, ...general }, strictParentLinks: true });
            return verifyParentSources({ personId, general, saved, request });
          },
          functions: async (personId, data) => {
            const parsed = parseFunctionsResponse(data, id);
            // The parser uses booleans; the shared individual writer expects SQLite flags.
            const normalized = (rows, raw) => rows.map((row, index) => ({ ...row, is_active: String(raw[index].Status || '').toUpperCase() === 'INACTIVE' ? 0 : 1 }));
            return syncFunctionsForMember(id, personId, db, normalized(parsed.functions, data.MemberFunctions.Function), normalized(parsed.committees, data.MemberCommittees.Committee), { force: true });
          },
          teams: async (personId, rows) => {
            const saved = await syncSingleMember({ db, knvbId: id, rondoClubId: personId, teamRows: rows, logger });
            assertTeamHistoryComplete(saved);
            if (!rows.length) {
              const person = (await request(`wp/v2/people/${personId}`)).body;
              const teams = new Set(require('../lib/rondo-club-db').getAllTeams(db).map(team => Number(team.rondo_club_id)));
              if ((person.fields.work_history || []).some(role => (teams.has(Number(role.team_id)) || role.entity_type === 'external_team') && role.is_current !== false && !role.end_date)) {
                throw new Error('Empty team source conflicts with stored current team assignments');
              }
            }
            return { success: true };
          }
        }});
        result.checked++;
        if (outcome.complete) result.complete++;
        result.errors.push(...outcome.errors.map(error => ({ knvb_id: id, message: `${error.part}: ${error.message}` })));
        result.deferred.push(...outcome.deferred.map(reason => ({ knvb_id: id, message: `${reason.part}: ${reason.message}` })));
      } catch (error) {
        result.errors.push({ knvb_id: id, message: error.message });
        try {
          await request('rondo/v1/onboarding/sources/finish', 'POST', { knvb_id: id, fingerprint: candidate.fingerprint, person_id: 0, observation_id: '' });
        } catch (ackError) {
          result.errors.push({ knvb_id: id, message: `Could not record incomplete check: ${ackError.message}` });
        }
      }
    }
  } finally {
    db.close();
  }
  logger.log(`Onboarding source checks: ${result.complete}/${result.checked} complete, ${result.deferred.length} deferred, ${result.errors.length} failed; automatic sending remains disabled`);
  return result;
}

module.exports = { runSourceChecks, verifyParentSources };
