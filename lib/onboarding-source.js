const { createHash, randomUUID } = require('node:crypto');
const { stableStringify } = require('./utils');

const COVERAGE = ['person', 'parents', 'teams', 'functions', 'vog'];
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;

/** Named historical teams are valid history; current assignments need a mapped team. */
function assertTeamHistoryComplete(saved) {
  if (saved?.success !== true || !Array.isArray(saved.errors) || saved.errors.length) {
    throw new Error('Team assignments could not be saved');
  }
  if (saved.currentTextFallback !== 0) {
    throw new Error('Current team mappings are not fully confirmed');
  }
}

/** Only source statuses observed in Sportlink are accepted as definitive proof. */
function membershipState(member, now = new Date()) {
  const type = String(member.TypeOfMember || '');
  const ended = date(member.RelationEnd);
  if (ended && ended < now.toISOString().slice(0, 10) && ['Oud bondslid', 'Oud verenigingslid'].includes(member.TypeOfMemberDescription)) return 'ended';
  if (['CLUBMEMBER', 'KERNELMEMBER'].includes(type) && member.Status === 'insync'
    && member.StatusDescription === 'Definitief' && member.MemberStatus === 'ACTIVE'
    && date(member.MemberSince) && (!ended || ended > now.toISOString().slice(0, 10))) return 'definitive';
  // A transfer request, unknown label or partial response cannot prove registration.
  return 'unknown';
}

function sourceRecord(member) {
  return {
    knvb_id: member.PublicPersonId,
    fingerprint: createHash('sha256').update(stableStringify(member)).digest('hex'),
    membership_state: membershipState(member)
  };
}

/** Steps report explicit success; neither exceptions nor missing results count as empty. */
async function checkSource({ candidate, member, steps, request, now = () => new Date() }) {
  const coverage = Object.fromEntries(COVERAGE.map(key => [key, false]));
  const errors = [];
  const observationId = randomUUID();
  const state = membershipState(member, now());
  const fetched = {};
  for (const key of ['person', 'functions', 'vog', 'teams']) {
    try {
      fetched[key] = await steps.fetch(key);
      if (fetched[key] === null || fetched[key] === undefined) throw new Error('No confirmed source response');
    } catch (error) {
      delete fetched[key];
      errors.push({ part: key, message: error.message });
    }
  }
  let personId = await steps.personId();
  if (fetched.person && fetched.vog && state !== 'unknown') {
    try {
      const saved = await steps.person(fetched.person, fetched.vog);
      if (!saved?.success || !saved.personId) throw new Error('Person save not confirmed');
      personId = saved.personId;
      coverage.person = true;
      coverage.vog = true;
    } catch (error) {
      errors.push({ part: 'person', message: error.message });
    }
  }
  if (personId && coverage.person) {
    for (const key of ['parents', 'functions', 'teams']) {
      if (key !== 'parents' && fetched[key] === undefined) continue;
      try {
        const saved = await steps[key](personId, key === 'parents' ? fetched.person : fetched[key]);
        if (saved?.success !== true) throw new Error(saved?.error || 'Source save not confirmed');
        coverage[key] = true;
      } catch (error) {
        errors.push({ part: key, message: error.message });
      }
    }
  }
  if (state === 'unknown') errors.push({ part: 'person', message: 'Sportlink registration status not confirmed' });
  if (personId) {
    // Read after every write: the observation covers the actual stored snapshot.
    const snapshot = (await request(`rondo/v1/onboarding/simulation/${personId}`, 'GET')).body;
    await request(`rondo/v1/onboarding/observations/${personId}`, 'POST', {
      observation_id: observationId,
      knvb_id: candidate.knvb_id,
      observed_at: now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      membership_state: state,
      snapshot_hash: snapshot.snapshot_hash,
      coverage
    });
  }
  const result = (await request('rondo/v1/onboarding/sources/finish', 'POST', {
    knvb_id: candidate.knvb_id, fingerprint: candidate.fingerprint,
    person_id: personId || 0, observation_id: observationId
  })).body;
  return { complete: result.complete === true, coverage, errors };
}

module.exports = { COVERAGE, membershipState, sourceRecord, checkSource, assertTeamHistoryComplete };
