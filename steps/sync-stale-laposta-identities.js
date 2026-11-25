require('dotenv/config');

const Database = require('better-sqlite3');
const client = require('../lib/laposta-client');
const { DEFAULT_DB_PATH, getLatestSportlinkSnapshot, openDb, recordAutomaticUnsubscription } = require('../lib/laposta-db');
const { normalizeEmail } = require('../lib/parent-dedupe');

const normalizeName = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const ownEmails = member => [member.Email, member.EmailAlternative].map(normalizeEmail).filter(Boolean);
const sourceName = member => normalizeName([member.FirstName, member.Infix, member.LastName].filter(Boolean).join(' '));
const remoteName = member => normalizeName([
  member.custom_fields?.voornaam, member.custom_fields?.tussenvoegsel, member.custom_fields?.achternaam
].filter(Boolean).join(' '));

function readSource() {
  const db = new Database(DEFAULT_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const snapshot = getLatestSportlinkSnapshot(db);
    return snapshot ? JSON.parse(snapshot.results_json) : null;
  } finally {
    db.close();
  }
}

function validateSource(source, now = Date.now()) {
  const observed = Date.parse(source?.ObservedAt);
  if (source?.SourceComplete !== true || !Array.isArray(source.Members) || !source.Members.length
      || source.Members.some(member => !member?.PublicPersonId || !Object.hasOwn(member, 'Email')
        || !Object.hasOwn(member, 'EmailAlternative'))
      || new Set(source.Members.map(member => member.PublicPersonId)).size !== source.Members.length
      || !Number.isFinite(observed) || observed > now + 60000 || now - observed > 3600000) {
    throw new Error('Stale-identity cleanup requires a complete, unique Sportlink snapshot less than one hour old');
  }
}

/** Only retire an obsolete child identity when both child and mailbox retain correct active entries. */
function buildStaleIdentityPlan(source, lists, emailFilter) {
  const people = new Map(source.Members.map(member => [member.PublicPersonId, member]));
  const rows = lists.flatMap(list => list.members.map(member => ({ listIndex: list.index, listId: list.listId, member })));
  const active = rows.filter(row => row.member.state === 'active' && row.member.member_id);
  return active.filter(row => {
    const { member } = row;
    const email = normalizeEmail(member.email);
    if (!email || (emailFilter && email !== normalizeEmail(emailFilter))) return false;
    const person = people.get(member.custom_fields?.relatiecode);
    if (!person || !sourceName(person) || remoteName(member) !== sourceName(person) || ownEmails(person).includes(email)) return false;

    // A source address change alone is insufficient: the correct destination must already be active.
    const replacement = active.some(other => ownEmails(person).includes(normalizeEmail(other.member.email))
      && other.member.custom_fields?.relatiecode === person.PublicPersonId
      && remoteName(other.member) === sourceName(person));
    if (!replacement) return false;

    const parentNames = new Set(source.Members.flatMap(child => [1, 2]
      .filter(number => normalizeEmail(child[`EmailAddressParent${number}`]) === email)
      .map(number => normalizeName(child[`NameParent${number}`])).filter(Boolean)));
    return active.some(other => {
      if (normalizeEmail(other.member.email) !== email) return false;
      const owner = people.get(other.member.custom_fields?.relatiecode);
      if (owner) return ownEmails(owner).includes(email) && remoteName(other.member) === sourceName(owner);
      return !other.member.custom_fields?.relatiecode && parentNames.size === 1
        && parentNames.has(remoteName(other.member));
    });
  });
}

async function syncStaleLapostaIdentities(options = {}) {
  const { apply = false, email, logger, dependencies = {} } = options;
  const api = { ...client, ...dependencies };
  const loadSource = dependencies.readSource || readSource;
  const stats = { candidates: 0, unsubscribed: 0, results: [], errors: [] };
  let db;
  try {
    const source = loadSource();
    // A long submission can outlive its source snapshot. Defer this optional
    // reconciliation so the existing former-member step can refresh its sources.
    if (options.deferStaleSource && Date.now() - Date.parse(source?.ObservedAt) > 3600000) {
      stats.skipped = 'Sportlink snapshot is older than one hour';
      logger?.log?.(`Stale Laposta identities: cleanup deferred (${stats.skipped})`);
      return stats;
    }
    validateSource(source);
    const lists = [];
    for (let index = 1; index <= 4; index++) {
      const { listId } = api.getListConfig(index);
      if (listId) lists.push({ index, listId, members: await api.fetchMembers(listId, 'active') });
    }
    validateSource(source);
    const plan = buildStaleIdentityPlan(source, lists, email);
    stats.candidates = plan.length;
    if (!apply) {
      stats.results = plan.map(row => ({ listIndex: row.listIndex, email: row.member.email,
        memberId: row.member.member_id, name: remoteName(row.member), state: 'proposed' }));
      return stats;
    }
    if (!plan.length) return stats;
    db = (dependencies.openDb || openDb)();
    for (const row of plan) {
      try {
        // Re-read the source and every involved list before each write. Concurrent changes fail closed.
        const currentSource = loadSource();
        validateSource(currentSource);
        if (JSON.stringify(currentSource) !== JSON.stringify(source)) throw new Error('Sportlink snapshot changed during cleanup');
        const currentLists = [];
        for (const list of lists) currentLists.push({ ...list, members: await api.fetchMembers(list.listId, 'active') });
        validateSource(currentSource);
        if (JSON.stringify(loadSource()) !== JSON.stringify(currentSource)) throw new Error('Sportlink snapshot changed during cleanup');
        const current = buildStaleIdentityPlan(currentSource, currentLists, email)
          .find(candidate => candidate.listId === row.listId && candidate.member.member_id === row.member.member_id
            && normalizeEmail(candidate.member.email) === normalizeEmail(row.member.email)
            && candidate.member.custom_fields?.relatiecode === row.member.custom_fields?.relatiecode);
        if (!current) throw new Error('Laposta identity or its replacement changed during cleanup');
        (dependencies.recordAutomaticUnsubscription || recordAutomaticUnsubscription)(
          db, row.listIndex, row.listId, current.member, 'stale-identity-cleanup'
        );
        let writeError;
        try {
          await api.updateMember(row.listId, row.member.member_id, { state: 'unsubscribed' });
        } catch (error) {
          writeError = error; // Do not replay an uncertain write; verify its actual result.
        }
        const confirmed = (await api.fetchMembers(row.listId, 'unsubscribed')).some(member =>
          member.member_id === row.member.member_id && normalizeEmail(member.email) === normalizeEmail(row.member.email)
          && member.state === 'unsubscribed');
        if (!confirmed) throw writeError || new Error('Laposta did not confirm unsubscribe');
        stats.unsubscribed++;
        stats.results.push({ listIndex: row.listIndex, email: row.member.email, memberId: row.member.member_id, state: 'unsubscribed' });
      } catch (error) {
        stats.errors.push({ email: row.member.email, message: error.message, system: 'stale-identities-laposta' });
        break;
      }
    }
    logger?.log?.(`Stale Laposta identities: ${stats.unsubscribed} unsubscribes verified`);
  } catch (error) {
    stats.errors.push({ message: error.message, system: 'stale-identities-laposta' });
  } finally {
    db?.close();
  }
  return stats;
}

module.exports = { validateSource, buildStaleIdentityPlan, syncStaleLapostaIdentities };
