const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchMemberTeamMemberships } = require('../steps/download-functions-from-sportlink');

test('retries once when the Sportlink memberships panel misses its first render', async () => {
  let navigations = 0;
  let panelWaits = 0;
  let toggleClicks = 0;
  const messages = [];
  const page = {
    goto: async () => { navigations++; },
    waitForLoadState: async () => {},
    waitForSelector: async () => {
      panelWaits++;
      if (panelWaits === 1) throw new Error('panel timeout');
    },
    $$: async () => [{
      isChecked: async () => false,
      click: async () => { toggleClicks++; }
    }],
    waitForResponse: async () => ({
      ok: () => true,
      headers: () => ({ 'content-type': 'application/json' }),
      json: async () => ({ Team: [{ TeamName: 'Rondo 1' }] })
    })
  };
  const logger = { verbose: message => messages.push(message) };

  const rows = await fetchMemberTeamMemberships(page, 'TEST001', logger, { strict: true });

  assert.equal(navigations, 2);
  assert.equal(toggleClicks, 1);
  assert.deepEqual(rows, [{ TeamName: 'Rondo 1' }]);
  assert.ok(messages.some(message => message.includes('retrying once')));
});
