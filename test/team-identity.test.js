'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { buildUniqueTeamMap } = require('../lib/team-lookup');
const { lookupTeamRondoClubId } = require('../steps/submit-rondo-club-work-history');
const { resolveTeamRondoClubId } = require('../steps/submit-rondo-club-player-history');

const teams = [
  { team_name: 'AWC 4', team_code: '4', rondo_club_id: 2608 },
  { team_name: 'AWC 4', team_code: '4', rondo_club_id: 2609 },
  { team_name: 'AWC O12-1', team_code: 'O12-1', rondo_club_id: 2610 }
];

test('same-named Saturday and Sunday teams never overwrite each other', () => {
  for (const input of [teams, [...teams].reverse()]) {
    const map = buildUniqueTeamMap(input);
    assert.equal(map.get('awc 4'), null);
    assert.equal(map.get('4'), null);
    assert.equal(lookupTeamRondoClubId(' AWC O12-1 ', map), 2610);
    assert.equal(lookupTeamRondoClubId('AWC 4', map), undefined);
  }
});

test('ambiguous names and codes resolve only to a single member roster identity', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rondo_club_teams (sportlink_id TEXT, rondo_club_id INTEGER, team_name TEXT, team_code TEXT);
    CREATE TABLE sportlink_team_members (sportlink_team_id TEXT, sportlink_person_id TEXT);
    INSERT INTO rondo_club_teams VALUES ('sat',2608,'AWC 4','4'),('sun',2609,'AWC 4','4');
    INSERT INTO sportlink_team_members VALUES ('sat','saturday'),('sun','sunday'),('sat','both'),('sun','both');
  `);
  for (const name of ['AWC 4', '4', 'awc 4']) {
    const map = buildUniqueTeamMap(teams);
    assert.equal(lookupTeamRondoClubId(name, map, db, 'saturday'), 2608);
    assert.equal(lookupTeamRondoClubId(name, map, db, 'sunday'), 2609);
    assert.equal(lookupTeamRondoClubId(name, map, db, 'both'), undefined);
    assert.equal(lookupTeamRondoClubId(name, map, db, 'absent'), undefined);
  }
  db.close();
});

test('unmapped namesakes and colliding aliases cannot create a unique match', () => {
  const map = buildUniqueTeamMap([
    teams[0],
    {team_name:'awc 4', team_code:'other', rondo_club_id:null},
    {team_name:'4', team_code:'other-code', rondo_club_id:2700},
    teams[0]
  ]);
  assert.equal(map.get('awc 4'),null);
  assert.equal(map.get('4'),null);
});

test('detailed history uses stable IDs and never guesses for an unknown ID or shared name', () => {
  const byId = new Map([['sat',2608],['sun',2609]]);
  const byName = buildUniqueTeamMap(teams, ['team_name']);
  assert.equal(resolveTeamRondoClubId({PublicTeamId:'sat',TeamName:'AWC 4'},byId,byName),2608);
  assert.equal(resolveTeamRondoClubId({PublicTeamId:'sun',TeamName:'AWC 4'},byId,byName),2609);
  assert.equal(resolveTeamRondoClubId({TeamName:'AWC 4',GameTypeDescription:'Veld - Zaterdag'},byId,byName),null);
  assert.equal(resolveTeamRondoClubId({PublicTeamId:'retired',TeamName:'AWC O12-1'},byId,byName),null);
  assert.equal(resolveTeamRondoClubId({TeamName:'AWC O12-1'},byId,byName),2610);
});
