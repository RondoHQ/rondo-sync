require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb, getAllTrackedMembers, getAllActiveMemberFunctions, getAllActiveMemberCommittees } = require('../lib/rondo-club-db');

async function clearWorkHistory() {
  const db = openDb();

  // Get members who have functions or committees
  const functions = getAllActiveMemberFunctions(db);
  const committees = getAllActiveMemberCommittees(db);
  const knvbIds = new Set([...functions.map(f => f.knvb_id), ...committees.map(c => c.knvb_id)]);

  // Get their rondo_club_ids
  const members = getAllTrackedMembers(db);
  const memberMap = new Map(members.map(m => [m.knvb_id, m.rondo_club_id]));

  console.log('Clearing work_history for', knvbIds.size, 'members...');

  let count = 0;
  for (const knvbId of knvbIds) {
    const rondoClubId = memberMap.get(knvbId);
    if (!rondoClubId) continue;

    try {
      // Get existing data
      const resp = await rondoClubRequest(`wp/v2/people/${rondoClubId}`, 'GET', null, {});
      const firstName = resp.body.fields?.first_name || '';
      const lastName = resp.body.fields?.last_name || '';

      // Clear work_history
      await rondoClubRequest(`wp/v2/people/${rondoClubId}`, 'PUT', {
        fields: { first_name: firstName, last_name: lastName, work_history: [] }
      }, {});
      count++;
      if (count % 50 === 0) console.log('Cleared', count, 'members...');
    } catch (e) {
      console.log('Error for', knvbId + ':', e.message);
    }
  }

  console.log('Done. Cleared work_history for', count, 'members');
  db.close();
}

clearWorkHistory();
