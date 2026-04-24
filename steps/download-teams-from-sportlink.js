require('dotenv/config');

const { chromium } = require('playwright');
const {
  openDb,
  upsertTeamsWithMetadata,
  upsertTeamMembers,
  clearTeamMembers
} = require('../lib/rondo-club-db');
const { loginToSportlink } = require('../lib/sportlink-login');
const { createLoggerAdapter, createDebugLogger, isDebugEnabled } = require('../lib/log-adapters');

/**
 * Download team data from Sportlink including player/staff roles
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {Object} [options.page] - Shared Playwright page (already logged in). If provided, skips browser launch and login.
 * @returns {Promise<{success: boolean, teamCount: number, memberCount: number, error?: string}>}
 */
async function runTeamDownload(options = {}) {
  const { logger, verbose = false, page: sharedPage } = options;

  const { log, verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });
  const logDebug = createDebugLogger();

  const ownsBrowser = !sharedPage;
  let browser;
  try {
    let page;
    if (sharedPage) {
      page = sharedPage;
    } else {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
      });
      page = await context.newPage();
    }

    try {
      if (!sharedPage && isDebugEnabled()) {
        page.on('request', r => logDebug('>>', r.method(), r.url()));
        page.on('response', r => logDebug('<<', r.status(), r.url()));
      }

      if (!sharedPage) {
        await loginToSportlink(page, { logger: { log, verbose: logVerbose, error: logError } });
      }

      // Step 1: Navigate to union teams page and capture teams list
      logVerbose('Fetching union teams list...');

      const teamsResponsePromise = page.waitForResponse(
        resp => resp.url().includes('/navajo/entity/common/clubweb/team/UnionTeams') &&
                !resp.url().includes('Players') &&
                !resp.url().includes('NonPlayers') &&
                resp.request().method() === 'GET',
        { timeout: 60000 }
      );

      await page.goto('https://club.sportlink.com/teams/union-teams', { waitUntil: 'domcontentloaded' });

      const teamsResponse = await teamsResponsePromise;
      if (!teamsResponse.ok()) {
        const errorMsg = `Teams request failed (${teamsResponse.status()})`;
        logError(errorMsg);
        return { success: false, teamCount: 0, memberCount: 0, error: errorMsg };
      }

      const teamsData = await teamsResponse.json();
      const teams = Array.isArray(teamsData.Team) ? teamsData.Team : [];
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

      const clubTeamsResponsePromise = page.waitForResponse(
        resp => resp.url().includes('/navajo/entity/common/clubweb/team/ClubTeams') &&
                !resp.url().includes('Players') &&
                !resp.url().includes('NonPlayers') &&
                resp.request().method() === 'GET',
        { timeout: 60000 }
      );

      await page.goto('https://club.sportlink.com/teams/club-teams', { waitUntil: 'domcontentloaded' });

      const clubTeamsResponse = await clubTeamsResponsePromise;
      if (!clubTeamsResponse.ok()) {
        const errorMsg = `Club teams request failed (${clubTeamsResponse.status()})`;
        logError(errorMsg);
        return { success: false, teamCount: 0, memberCount: 0, error: errorMsg };
      }

      const clubTeamsData = await clubTeamsResponse.json();
      const clubTeams = Array.isArray(clubTeamsData.Team) ? clubTeamsData.Team : [];

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

      if (teamRecords.length === 0) {
        log('No teams found');
        return { success: true, teamCount: 0, memberCount: 0 };
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

        // Set up listeners for both players and non-players responses
        const playersResponsePromise = page.waitForResponse(
          resp => resp.url().includes(playersPattern) &&
                  resp.request().method() === 'GET',
          { timeout: 10000 }
        ).catch(() => null);

        const nonPlayersResponsePromise = page.waitForResponse(
          resp => resp.url().includes(nonPlayersPattern) &&
                  resp.request().method() === 'GET',
          { timeout: 10000 }
        ).catch(() => null);

        await page.goto(teamMembersUrl, { waitUntil: 'commit' });

        // Process players response
        const playersResponse = await playersResponsePromise;
        if (playersResponse && playersResponse.ok()) {
          try {
            const playersData = await playersResponse.json();
            const players = Array.isArray(playersData.Person) ? playersData.Person : [];
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
            logDebug(`  Error parsing players: ${err.message}`);
          }
        }

        // Process non-players (staff) response
        const nonPlayersResponse = await nonPlayersResponsePromise;
        if (nonPlayersResponse && nonPlayersResponse.ok()) {
          try {
            const nonPlayersData = await nonPlayersResponse.json();
            const staff = Array.isArray(nonPlayersData.Person) ? nonPlayersData.Person : [];
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
            logDebug(`  Error parsing staff: ${err.message}`);
          }
        }

      }

      // Step 3: Store to database
      const db = openDb();
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
        db.close();
      }

      log(`Downloaded ${teamRecords.length} teams with ${totalMemberCount} team members from Sportlink`);
      return { success: true, teamCount: teamRecords.length, memberCount: totalMemberCount };
    } finally {
      if (ownsBrowser && browser) {
        await browser.close();
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
