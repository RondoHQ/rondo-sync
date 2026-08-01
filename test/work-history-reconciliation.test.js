'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  detectTeamChanges,
  findTeamWorkHistoryIndex
} = require('../steps/submit-rondo-club-work-history');
const { computeWorkHistoryHash } = require('../lib/rondo-club-db');
const { reconcilePlayerHistory } = require('../steps/submit-rondo-club-player-history');

test('team cleanup ignores a stale index and finds the current row by team ID', () => {
  const rows = [
    { team_id: 999, job_title: 'Commissielid', is_current: true },
    { team_id: 2618, job_title: 'Assistent-trainer/coach', is_current: false },
    { team_id: 2618, job_title: 'Assistent-trainer/coach', is_current: true }
  ];

  assert.equal(findTeamWorkHistoryIndex(rows, 1, 2618), 2);
});

test('role-only hash changes are detected without forcing the team sync', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rondo_club_work_history (
      knvb_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      rondo_club_work_history_id INTEGER,
      is_backfill INTEGER DEFAULT 0,
      source_hash TEXT NOT NULL,
      last_synced_hash TEXT,
      last_synced_at TEXT,
      UNIQUE(knvb_id, team_name)
    );
    INSERT INTO rondo_club_work_history (
      knvb_id, team_name, rondo_club_work_history_id,
      source_hash, last_synced_hash, last_synced_at
    ) VALUES ('BNCB87F', 'AWC O12-3JM', 15, 'new-role-hash', 'old-role-hash', '2026-07-19');
  `);

  const changes = detectTeamChanges(db, 'BNCB87F', ['AWC O12-3JM']);
  assert.deepEqual(changes.added, []);
  assert.deepEqual(changes.removed, []);
  assert.deepEqual(changes.updated, ['AWC O12-3JM']);
  db.close();
});

test('work-history hashes include the role description', () => {
  const assistant = computeWorkHistoryHash('BNCB87F', 'AWC O11-3JM', 'Assistent-trainer/coach');
  const manager = computeWorkHistoryHash('BNCB87F', 'AWC O11-3JM', 'Teammanager');
  assert.notEqual(assistant, manager);
});

test('player history closes a legacy current duplicate when Sportlink has ended it', () => {
  const existing = [
    {
      team_id: 2618,
      job_title: 'Assistent-trainer/coach',
      start_date: '20260212',
      end_date: '20260705',
      is_current: false
    },
    {
      team_id: 2618,
      job_title: 'Assistent-trainer/coach',
      start_date: '20250701',
      end_date: '',
      is_current: true
    },
    {
      team_id: 2662,
      job_title: 'Bestuurslid',
      start_date: '20231117',
      end_date: '',
      is_current: true
    }
  ];
  const source = [{
    team_id: 2618,
    job_title: 'Assistent-trainer/coach',
    start_date: '20250701',
    end_date: '20260701',
    is_current: false
  }];

  const result = reconcilePlayerHistory(existing, source);
  assert.equal(result.created, 0);
  assert.equal(result.reconciled, 1);
  assert.equal(result.workHistory[1].is_current, false);
  assert.equal(result.workHistory[1].end_date, '20260701');
  assert.equal(result.workHistory[2].is_current, true, 'non-team function history is preserved');
});

test('an active source stint prevents an older ended stint from closing the current row', () => {
  const existing = [{
    team_id: 2630,
    job_title: 'Teammanager',
    start_date: '20250813',
    end_date: '',
    is_current: true
  }];
  const source = [
    {
      team_id: 2630,
      job_title: 'Teammanager',
      start_date: '20240813',
      end_date: '20250701',
      is_current: false
    },
    {
      team_id: 2630,
      job_title: 'Teammanager',
      start_date: '20250813',
      end_date: '',
      is_current: true
    }
  ];

  const result = reconcilePlayerHistory(existing, source);
  const currentRows = result.workHistory.filter(row => row.team_id === 2630 && row.is_current);
  assert.equal(currentRows.length, 1);
  assert.equal(currentRows[0].start_date, '20250813');
});
