#!/usr/bin/env node
require('dotenv/config');

const {
  openDb,
  setPlayerHistorySkip,
  clearPlayerHistorySkip,
  listPlayerHistorySkipped
} = require('../lib/rondo-club-db');

/**
 * Manage the player-history quarantine list.
 *
 * The player-history pipeline calls Sportlink's /member-details/{id}/memberships
 * endpoint for each member. Sometimes Sportlink's SPA hangs on a specific
 * member's data (verified for PKWR41Q since 2026-03-02 — reported upstream).
 * When that happens, every player-history run wastes 45s + emits an error
 * for that member, every time, forever.
 *
 * Quarantining a knvb_id causes the pipeline to skip it entirely until the
 * quarantine is lifted. Lift it with `remove` once Sportlink confirms a fix.
 *
 * Usage:
 *   node tools/player-history-quarantine.js list
 *   node tools/player-history-quarantine.js add <knvb_id> <reason>
 *   node tools/player-history-quarantine.js remove <knvb_id>
 */

function usage() {
  console.log('Usage:');
  console.log('  node tools/player-history-quarantine.js list');
  console.log('  node tools/player-history-quarantine.js add <knvb_id> <reason...>');
  console.log('  node tools/player-history-quarantine.js remove <knvb_id>');
}

function cmdList(db) {
  const rows = listPlayerHistorySkipped(db);
  if (rows.length === 0) {
    console.log('No members are currently quarantined.');
    return 0;
  }
  console.log(`${rows.length} member(s) quarantined from player-history sync:`);
  console.log('');
  for (const row of rows) {
    console.log(`  ${row.knvb_id} (rondo_club_id=${row.rondo_club_id}): ${row.player_history_skip_reason}`);
  }
  return 0;
}

function cmdAdd(db, knvbId, reason) {
  if (!knvbId || !reason) {
    console.error('add: requires <knvb_id> and <reason>');
    usage();
    return 2;
  }
  const changes = setPlayerHistorySkip(db, knvbId, reason);
  if (changes === 0) {
    console.error(`add: knvb_id "${knvbId}" is not tracked in rondo_club_members — nothing changed.`);
    return 1;
  }
  console.log(`Quarantined ${knvbId} from player-history sync.`);
  console.log(`Reason: ${reason}`);
  console.log('');
  console.log('Lift with: node tools/player-history-quarantine.js remove ' + knvbId);
  return 0;
}

function cmdRemove(db, knvbId) {
  if (!knvbId) {
    console.error('remove: requires <knvb_id>');
    usage();
    return 2;
  }
  const changes = clearPlayerHistorySkip(db, knvbId);
  if (changes === 0) {
    console.log(`${knvbId} was not quarantined — nothing to do.`);
    return 0;
  }
  console.log(`Lifted quarantine on ${knvbId}. The next player-history run will fetch them from Sportlink.`);
  return 0;
}

function main() {
  const [, , command, ...rest] = process.argv;

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage();
    process.exit(command ? 0 : 2);
  }

  const db = openDb();
  try {
    switch (command) {
      case 'list':
        process.exit(cmdList(db));
      case 'add': {
        const [knvbId, ...reasonParts] = rest;
        process.exit(cmdAdd(db, knvbId, reasonParts.join(' ')));
      }
      case 'remove':
      case 'rm': {
        const [knvbId] = rest;
        process.exit(cmdRemove(db, knvbId));
      }
      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exit(2);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { cmdList, cmdAdd, cmdRemove };
