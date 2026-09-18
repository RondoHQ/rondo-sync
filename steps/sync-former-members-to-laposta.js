require('dotenv/config');

const client = require('../lib/laposta-client');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb, recordAutomaticUnsubscription } = require('../lib/laposta-db');

const EMAIL_FIELDS = ['Email', 'EmailAlternative', 'EmailAddressParent1', 'EmailAddressParent2'];
const FORMER_TYPES = new Set(['Oud bondslid', 'Oud verenigingslid']);
const MAX_SOURCE_AGE_MS = 60 * 60 * 1000;
const normalizeEmail = value => String(value || '').trim().toLowerCase();

function collectEmails(members, fields) {
  return new Set(members.flatMap(member => fields.map(field => normalizeEmail(member[field])))
    .filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)));
}

function validateSources(activeResult, inactiveResult, now = Date.now()) {
  const observed = Date.parse(activeResult?.observedAt);
  if (!activeResult?.success || activeResult.sourceComplete !== true
      || !Array.isArray(activeResult.members) || !activeResult.members.length
      || activeResult.members.some(member => !member?.PublicPersonId)
      || !Number.isFinite(observed) || now - observed > MAX_SOURCE_AGE_MS || observed > now + 60000) {
    throw new Error('Former-member cleanup requires a complete active Sportlink snapshot less than one hour old');
  }
  if (!inactiveResult?.success || !Array.isArray(inactiveResult.members)
      || inactiveResult.members.some(member => !member?.PublicPersonId)) {
    throw new Error('Former-member cleanup requires a successful inactive Sportlink download');
  }
}

function buildFormerMemberPlan(activeMembers, inactiveMembers, formerPeople, lists) {
  const protectedEmails = collectEmails(activeMembers, EMAIL_FIELDS);
  const formerEmails = collectEmails(
    inactiveMembers.filter(member => FORMER_TYPES.has(member.TypeOfMemberDescription)), EMAIL_FIELDS
  );
  for (const email of collectEmails(
    formerPeople.filter(person => person.fields?.former_member === true).map(person => person.fields),
    ['email_1', 'email_2']
  )) formerEmails.add(email);

  const candidates = [];
  const protectedRows = [];
  for (const list of lists) {
    for (const member of list.members) {
      if (member.state && member.state !== 'active') continue;
      const email = normalizeEmail(member.email || member.EmailAddress);
      if (!formerEmails.has(email)) continue;
      const row = { listIndex: list.index, listId: list.listId, email, member };
      (protectedEmails.has(email) ? protectedRows : candidates).push(row);
    }
  }
  return { candidates, protectedRows };
}

async function fetchFormerPeople(request = rondoClubRequest) {
  const people = [];
  let totalPages = 1;
  let expectedTotal;
  for (let page = 1; page <= totalPages; page++) {
    const response = await request(
      `wp/v2/people?former_member=1&per_page=100&page=${page}&orderby=id&order=asc`
      + '&_fields=id,fields.former_member,fields.email_1,fields.email_2', 'GET'
    );
    const pages = Number(response.headers?.['x-wp-totalpages']);
    const total = Number(response.headers?.['x-wp-total']);
    if (!Array.isArray(response.body) || !Number.isInteger(pages) || pages < 0
        || !Number.isInteger(total) || total < 0
        || response.body.some(person => !person.id || person.fields?.former_member !== true)
        || (expectedTotal !== undefined && expectedTotal !== total)) {
      throw new Error('Incomplete or changing Rondo former-member response; cleanup skipped');
    }
    expectedTotal = total;
    totalPages = pages;
    people.push(...response.body);
  }
  if (people.length !== expectedTotal || new Set(people.map(person => person.id)).size !== expectedTotal) {
    throw new Error('Incomplete Rondo former-member pagination; cleanup skipped');
  }
  return people;
}

/** Shared dry-run/apply path for the scheduled pipeline and one-time cleanup. */
async function syncFormerMembersToLaposta(activeResult, inactiveResult, options = {}) {
  const { apply = false, logger, dependencies = {} } = options;
  const api = { ...client, ...dependencies };
  const stats = { candidates: 0, uniqueEmails: 0, unsubscribed: 0, keptShared: 0, results: [], errors: [] };
  let db;
  try {
    validateSources(activeResult, inactiveResult);
    const people = await (dependencies.fetchFormerPeople || fetchFormerPeople)();
    const lists = [];
    for (let index = 1; index <= 4; index++) {
      const { listId } = api.getListConfig(index);
      if (!listId) continue;
      lists.push({ index, listId, members: await api.fetchMembers(listId, 'active') });
      await api.waitForRateLimit();
    }
    const plan = buildFormerMemberPlan(activeResult.members, inactiveResult.members, people, lists);
    stats.candidates = plan.candidates.length;
    stats.uniqueEmails = new Set(plan.candidates.map(row => row.email)).size;
    stats.keptShared = plan.protectedRows.length;
    // Recheck after the paginated reads; never apply a plan based on an expired source.
    validateSources(activeResult, inactiveResult);
    if (!apply) {
      stats.results = plan.candidates.map(row => ({ listIndex: row.listIndex, email: row.email, state: 'proposed' }));
      return stats;
    }
    if (!plan.candidates.length) return stats;
    db = (dependencies.openDb || openDb)();
    for (const list of lists) {
      const candidates = plan.candidates.filter(row => row.listId === list.listId);
      if (!candidates.length) continue;
      const attempted = [];
      for (const row of candidates) {
        try {
          validateSources(activeResult, inactiveResult);
          (dependencies.recordAutomaticUnsubscription || recordAutomaticUnsubscription)(
            db, row.listIndex, row.listId, row.member, 'former-member-cleanup'
          );
          attempted.push(row);
          await api.updateMember(row.listId, row.member.member_id || row.email, { state: 'unsubscribed' });
        } catch (error) {
          stats.errors.push({ email: row.email, message: error.message, system: 'former-members-laposta' });
        }
        await api.waitForRateLimit();
        logger?.verbose?.(`Former-member cleanup: ${attempted.length}/${candidates.length} processed on list ${list.index}`);
      }
      // Confirm the actual state separately, including requests with an uncertain result.
      const unsubscribed = await api.fetchMembers(list.listId, 'unsubscribed');
      const confirmed = new Set(unsubscribed.map(member => `${member.member_id || ''}:${normalizeEmail(member.email || member.EmailAddress)}`));
      for (const row of attempted) {
        const verified = confirmed.has(`${row.member.member_id || ''}:${row.email}`);
        stats.results.push({ listIndex: row.listIndex, email: row.email, state: verified ? 'unsubscribed' : 'unverified' });
        if (verified) stats.unsubscribed++;
        else stats.errors.push({ email: row.email, message: 'Laposta did not confirm unsubscribe', system: 'former-members-laposta' });
      }
      await api.waitForRateLimit();
      logger?.log?.(`Former-member cleanup: ${stats.unsubscribed} unsubscribes verified`);
    }
  } catch (error) {
    stats.errors.push({ message: error.message, system: 'former-members-laposta' });
  } finally {
    db?.close();
  }
  return stats;
}

module.exports = { validateSources, buildFormerMemberPlan, fetchFormerPeople, syncFormerMembersToLaposta };
