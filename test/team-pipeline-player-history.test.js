const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const pipeline of ['sync-teams.js', 'sync-all.js']) {
  test(`${pipeline} enriches quick work history with Sportlink relation dates`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'pipelines', pipeline), 'utf8');
    const quickSyncCall = source.indexOf('await runWorkHistorySync(');
    const detailSyncCall = source.indexOf('await runPlayerHistorySync(');

    assert.notEqual(quickSyncCall, -1, 'quick work-history sync is wired into the pipeline');
    assert.notEqual(detailSyncCall, -1, 'player-history detail sync is wired into the pipeline');
    assert.ok(
      detailSyncCall > quickSyncCall,
      'player-history detail sync runs after the quick roster-based work-history sync'
    );
  });
}
