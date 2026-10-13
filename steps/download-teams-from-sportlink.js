require('dotenv/config');

const {
  openDb,
  upsertTeamsWithMetadata,
  upsertTeamMembers,
  clearTeamMembers
} = require('../lib/rondo-club-db');
const { SportlinkSession } = require('../lib/sportlink-session');
const { createLoggerAdapter, createDebugLogger, isDebugEnabled } = require('../lib/log-adapters');

/** Read all responses for one SPA page before accepting its snapshot. */
async function readTeamPage(page, url, endpoints, session, logger, timeout = 60000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Sportlink can refresh its token and retry a 401 in the page itself.
    // Observe that retry, but retain the 401 if no usable response follows.
    const waits = endpoints.map(endpoint => {
      let unauthorized = false;
      return page.waitForResponse(response => {
        if (!new URL(response.url()).pathname.endsWith('/' + endpoint) ||
            response.request().method() !== 'GET') return false;
        if (response.status() === 401) {
          unauthorized = true;
          return false;
        }
        return true;
      }, { timeout }).then(response => ({ response }), error => ({ error, unauthorized }));
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const results = await Promise.all(waits);
    const loggedOut = results.some(result => result.error) && await page
      .getByText('Je bent uitgelogd omdat je een tijdje niet actief was.', { exact: true })
      .isVisible().catch(() => false);
    if ((results.some(result => result.unauthorized) || loggedOut) && session && attempt === 0) {
      logger.verbose('Team request remained unauthorized; logging in again and retrying once');
      await session.relogin();
      continue;
    }
    return results.map((result, index) => {
      if (result.unauthorized) throw new Error(`${endpoints[index]} request failed (401)`);
      if (loggedOut) throw new Error('Sportlink session expired while loading teams');
      if (result.error) throw result.error;
      if (!result.response.ok()) throw new Error(`${endpoints[index]} request failed (${result.response.status()})`);
      return result.response;
    });
  }
}

/**
 * Download team data from Sportlink including player/staff roles
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.rosters=true] - Set false for a read-only team-list snapshot without roster downloads or database writes.
 * @param {Object} [options.page] - Shared Playwright page (already logged in). If provided, skips browser launch and login.
 * @param {SportlinkSession} [options.session] - Session owner for recovery when sharing a page.
 * @returns {Promise<{success: boolean, teamCount: number, memberCount: number, error?: string}>}
 */
async function runTeamDownload(options = {}) {
  const { logger, verbose = false, page: sharedPage } = options;

  const { log, verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });
  const logDebug = createDebugLogger();

  let session;
  try {
    let page;
    if (sharedPage) {
      page = sharedPage;
    } else {
      session = new SportlinkSession({
        logger: { log, verbose: logVerbose, error: logError }
      });
      page = await session.getPage();
    }

    try {
      if (!sharedPage && isDebugEnabled()) {
        page.on('request', r => logDebug('>>', r.method(), r.url()));
        page.on('response', r => logDebug('<<', r.status(), r.url()));
      }

      // Step 1: Navigate to union teams page and capture teams list
      logVerbose('Fetching union teams list...');

      const [teamsResponse] = await readTeamPage(page,
        'https://club.sportlink.com/teams/union-teams', ['UnionTeams'],
        session || options.session, { verbose: logVerbose });

      const teamsData = await teamsResponse.json();
      if (!Array.isArray(teamsData.Team)) throw new Error('Incomplete UnionTeams response');
      const teams = teamsData.Team;
      logVerbose(`Found ${teams.length} union teams`);

      // Prepare team records with metadata for union teams
      const teamRecords = teams.map(team => ({
        team_name: team.TeamName || team.Name || '',
        sportlink_id: team.PublicTeamId || '',
        team_code: team.TeamCode || '',
        game_activity: team.GameActivityDescription || '',
        gender: team.Gender || '',
        player_count: 0,
        staff_count: 0,
        source: 'union'
      })).filter(t => t.team_name && t.sportlink_id);

      // Step 1b: Navigate to club teams page and capture club teams list
      logVerbose('Fetching club teams list...');

      const [clubTeamsResponse] = await readTeamPage(page,
        'https://club.sportlink.com/teams/club-teams', ['ClubTeams'],
        session || options.session, { verbose: logVerbose });

      const clubTeamsData = await clubTeamsResponse.json();
      if (!Array.isArray(clubTeamsData.Team)) throw new Error('Incomplete ClubTeams response');
      const clubTeams = clubTeamsData.Team;

      // Filter out club teams that already exist as union teams
      const filteredClubTeams = clubTeams.filter(team => !team.HasUnionTeamConnection);

      logVerbose(`Found ${filteredClubTeams.length} club-only teams (filtered ${clubTeams.length - filteredClubTeams.length} teams with union team connection)`);

      // Add club team records to the team records array
      const clubTeamRecords = filteredClubTeams.map(team => ({
        team_name: team.TeamName || team.Name || '',
        sportlink_id: team.PublicTeamId || '',
        team_code: team.TeamCode || '',
        game_activity: team.GameActivityDescription || '',
        gender: team.Gender || '',
        player_count: 0,
        staff_count: 0,
        source: 'club'
      })).filter(t => t.team_name && t.sportlink_id);

      // Combine union and club teams
      teamRecords.push(...clubTeamRecords);

      if (teamRecords.length !== teams.length + filteredClubTeams.length) {
        throw new Error('Team snapshot contains missing names or Sportlink IDs');
      }
      const currentSportlinkIds = teamRecords.map(team => team.sportlink_id);

      if (teamRecords.length === 0) {
        log('No teams found');
        return { success: true, teamCount: 0, memberCount: 0, currentSportlinkIds };
      }

      if (options.rosters === false) {
        return { success: true, teamCount: teamRecords.length, memberCount: 0, currentSportlinkIds };
      }

      logVerbose(`Total teams to process: ${teamRecords.length} (${teams.length} union + ${filteredClubTeams.length} club)`);

      // Step 2: Fetch players and staff for each team
      const allMembers = [];
      let totalMemberCount = 0;

      for (let i = 0; i < teamRecords.length; i++) {
        const team = teamRecords[i];
        const teamType = team.source === 'club' ? 'club' : 'union';
        logVerbose(`Fetching members for ${teamType} team ${i + 1}/${teamRecords.length}: ${team.team_name}`);

        // Use same URL pattern for both union and club teams
        const teamMembersUrl = `https://club.sportlink.com/teams/team-details/${team.sportlink_id}/members`;

        // API response patterns differ by team type
        const isClubTeam = team.source === 'club';
        const playersPattern = isClubTeam ? '/ClubTeamPlayers' : '/UnionTeamPlayers';
        const nonPlayersPattern = isClubTeam ? '/ClubTeamNonPlayers' : '/UnionTeamNonPlayers';

        const [playersResponse, nonPlayersResponse] = await readTeamPage(page,
          teamMembersUrl, [playersPattern.slice(1), nonPlayersPattern.slice(1)],
          session || options.session, { verbose: logVerbose });

        // Process players response
        if (playersResponse && playersResponse.ok()) {
          try {
            const playersData = await playersResponse.json();
            if (!Array.isArray(playersData.Person)) throw new Error('Incomplete team players response');
            const players = playersData.Person;
            logDebug(`  Found ${players.length} players`);

            for (const player of players) {
              const personId = player.PublicPersonId;
              if (!personId) continue;

              if (!player.RoleFunctionDescription) {
                logDebug(`Warning: Player ${personId} in team ${team.team_name} has no role description, skipping`);
                continue;
              }

              allMembers.push({
                sportlink_team_id: team.sportlink_id,
                sportlink_person_id: personId,
                role_description: player.RoleFunctionDescription
              });
            }
            team.player_count = players.length;
            totalMemberCount += players.length;
          } catch (err) {
            throw new Error(`Invalid team players response: ${err.message}`);
          }
        }

        // Process non-players (staff) response
        if (nonPlayersResponse && nonPlayersResponse.ok()) {
          try {
            const nonPlayersData = await nonPlayersResponse.json();
            if (!Array.isArray(nonPlayersData.Person)) throw new Error('Incomplete team staff response');
            const staff = nonPlayersData.Person;
            logDebug(`  Found ${staff.length} staff members`);

            for (const person of staff) {
              const personId = person.PublicPersonId;
              if (!personId) continue;

              if (!person.FunctionDescription) {
                logDebug(`Warning: Staff ${personId} in team ${team.team_name} has no role description, skipping`);
                continue;
              }

              allMembers.push({
                sportlink_team_id: team.sportlink_id,
                sportlink_person_id: personId,
                role_description: person.FunctionDescription
              });
            }
            team.staff_count = staff.length;
            totalMemberCount += staff.length;
          } catch (err) {
            throw new Error(`Invalid team staff response: ${err.message}`);
          }
        }

      }

      // Step 3: Store to database
      const db = options.db || openDb();
      try {
        // Clear existing team members and insert fresh data
        clearTeamMembers(db);

        // Remove source field before storing (it was only needed for API routing)
        const dbTeamRecords = teamRecords.map(({ source, ...rest }) => rest);

        // Upsert teams with metadata
        if (dbTeamRecords.length > 0) {
          upsertTeamsWithMetadata(db, dbTeamRecords);
        }

        // Upsert team members
        if (allMembers.length > 0) {
          upsertTeamMembers(db, allMembers);
        }
      } finally {
        if (!options.db) db.close();
      }

      log(`Downloaded ${teamRecords.length} teams with ${totalMemberCount} team members from Sportlink`);
      return { success: true, teamCount: teamRecords.length, memberCount: totalMemberCount, currentSportlinkIds };
    } finally {
      if (session) {
        await session.close();
      }
    }
  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error:', errorMsg);
    return { success: false, teamCount: 0, memberCount: 0, error: errorMsg };
  }
}

module.exports = { runTeamDownload };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  runTeamDownload({ verbose })
    .then(result => {
      if (result.success) {
        console.log(`Success: ${result.teamCount} teams, ${result.memberCount} team members`);
      } else {
        console.error('Failed:', result.error);
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
