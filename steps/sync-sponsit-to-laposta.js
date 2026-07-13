#!/usr/bin/env node
require('dotenv/config');

const { openDb, getContactRecords } = require('../lib/sponsit-db');
const { readEnv } = require('../lib/utils');
const { fetchFields, fetchMembers, upsertMember, updateMember, waitForRateLimit } = require('../lib/laposta-client');
const { fetchRondoPeople } = require('./sync-sponsit-to-rondo-club');
const { buildSponsitLapostaPlan, validateLapostaFields, getMemberCustomField } = require('../lib/sponsit-laposta');

function memberEmail(member) {
  return normalize(member.email || member.EmailAddress);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

async function runSponsitLapostaSync(options = {}) {
  const listId = readEnv('LAPOSTA_SPONSIT_LIST');
  const db = openDb();
  try {
    const records = getContactRecords(db, { activeOnly: true });
    if (!listId) {
      const localPlan = buildSponsitLapostaPlan(records);
      const summary = {
        candidates: localPlan.members.length,
        quarantined: localPlan.quarantined.length,
        configured: false
      };
      console.log(JSON.stringify(summary, null, 2));
      return { success: true, dryRun: true, summary };
    }

    const rondoPeople = await fetchRondoPeople(options);
    const plan = buildSponsitLapostaPlan(records, rondoPeople);
    const summary = {
      candidates: plan.members.length,
      quarantined: plan.quarantined.length,
      quarantineReasons: plan.quarantined.reduce((counts, item) => {
        counts[item.reason] = (counts[item.reason] || 0) + 1;
        return counts;
      }, {})
    };

    const fields = await fetchFields(listId);
    const missingFields = validateLapostaFields(fields);
    if (missingFields.length) {
      throw new Error(`Laposta sponsor list is missing fields: ${missingFields.join(', ')}`);
    }

    const [active, unsubscribed, cleaned] = await Promise.all([
      fetchMembers(listId, 'active'),
      fetchMembers(listId, 'unsubscribed'),
      fetchMembers(listId, 'cleaned')
    ]);
    const blocked = new Set([...unsubscribed, ...cleaned].map(memberEmail).filter(Boolean));
    const activeByEmail = new Map(active.map((member) => [memberEmail(member), member]));
    const desiredEmails = new Set(plan.members.map((member) => member.email));
    const actions = {
      create: plan.members.filter((member) => !blocked.has(member.email) && !activeByEmail.has(member.email)),
      update: plan.members.filter((member) => !blocked.has(member.email) && activeByEmail.has(member.email)),
      skipOptOut: plan.members.filter((member) => blocked.has(member.email)),
      unsubscribe: active.filter((member) => {
        const email = memberEmail(member);
        return getMemberCustomField(member, 'sponsitcontactid') && !desiredEmails.has(email);
      })
    };
    Object.assign(summary, Object.fromEntries(Object.entries(actions).map(([key, value]) => [key, value.length])));
    console.log(JSON.stringify({ ...summary, configured: true, apply: Boolean(options.apply) }, null, 2));
    if (!options.apply) return { success: true, dryRun: true, summary };

    const errors = [];
    const work = [
      ...actions.update.map((member) => ({ type: 'update', member })),
      ...actions.create.map((member) => ({ type: 'create', member })),
      ...actions.unsubscribe.map((member) => ({ type: 'unsubscribe', member }))
    ];
    for (let index = 0; index < work.length; index += 1) {
      const item = work[index];
      try {
        if (item.type === 'create') {
          await upsertMember(listId, item.member);
        } else if (item.type === 'update') {
          const existing = activeByEmail.get(item.member.email);
          await updateMember(listId, existing.member_id || item.member.email, { custom_fields: item.member.custom_fields });
        } else {
          await updateMember(listId, item.member.member_id || memberEmail(item.member), { state: 'unsubscribed' });
        }
      } catch (error) {
        errors.push({
          type: item.type,
          email: item.member.email || memberEmail(item.member),
          message: error.details?.error?.message || error.details?.message || error.message
        });
      }
      if ((index + 1) % 25 === 0 || index === work.length - 1) {
        console.log(`Laposta progress: ${index + 1}/${work.length} (${errors.length} errors)`);
      }
      if (index < work.length - 1) await waitForRateLimit();
    }
    return { success: errors.length === 0, dryRun: false, summary, errors };
  } finally {
    db.close();
  }
}

module.exports = { runSponsitLapostaSync };

if (require.main === module) {
  runSponsitLapostaSync({ apply: process.argv.includes('--apply'), verbose: process.argv.includes('--verbose') })
    .then((result) => {
      if (!result.dryRun) {
        const errorSummary = (result.errors || []).reduce((counts, error) => {
          const key = `${error.type}: ${error.message}`;
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {});
        console.log(JSON.stringify({ errors: result.errors?.length || 0, errorSummary }, null, 2));
      }
      if (!result.success) process.exitCode = 2;
    })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
