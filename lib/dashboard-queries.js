const { openDb } = require('./dashboard-db');
const { getNextRun, getPreviousScheduledRun } = require('./schedule');

// Shared database connection (opened lazily, reused)
let db = null;

/**
 * Ensure database connection is open
 * @private
 */
function ensureDb() {
  if (!db) {
    db = openDb();
  }
  return db;
}

/** Grace period: pipeline is overdue when it hasn't run 4 hours after its scheduled time */
const OVERDUE_GRACE_HOURS = 4;

/**
 * Pipeline display names
 * @private
 */
const PIPELINE_CONFIG = {
  people: { displayName: 'People', description: 'Members, parents, photos from Sportlink to Rondo Club + Laposta', sourceSportlink: true },
  nikki: { displayName: 'Nikki', description: 'Contribution status from nikki-online.nl to Rondo Club' },
  freescout: { displayName: 'FreeScout', description: 'Member data from Sportlink to FreeScout customers', sourceSportlink: true },
  'freescout-conversations': { displayName: 'FreeScout conversations', description: 'FreeScout conversations as activities on Rondo Club people' },
  teams: { displayName: 'Teams', description: 'Teams and team work history from Sportlink to Rondo Club', sourceSportlink: true },
  'player-history': { displayName: 'Player history', description: 'Full historical team memberships from Sportlink to Rondo Club work history', sourceSportlink: true },
  functions: { displayName: 'Member roles + VOG', description: 'Committees, roles, VOG dates from Sportlink to Rondo Club for members with pending changes', sourceSportlink: true },
  'functions-full': { displayName: 'Member roles (full)', description: 'Full sync of all member roles, committees, VOG, and invoice data', sourceSportlink: true },
  discipline: { displayName: 'Discipline', description: 'Discipline cases from Sportlink to Rondo Club', sourceSportlink: true },
  reverse: { displayName: 'Reverse sync', description: 'Contact fields, free fields, and financial toggle from Rondo Club back to Sportlink', manualNote: 'Runs every 5 minutes via cron', sourceSportlink: true },
  'former-members': { displayName: 'Former members', description: 'Former/inactive members from Sportlink to Rondo Club', manualNote: 'Only run manually, not needed in normal operation', sourceSportlink: true }
};

/**
 * Get pipeline overview for all primary pipelines
 * @returns {Array<Object>} Array of pipeline objects with status
 */
function getPipelineOverview() {
  const database = ensureDb();
  const now = new Date();
  const pipelines = [];

  for (const [name, config] of Object.entries(PIPELINE_CONFIG)) {
    // Get latest run
    const run = database.prepare(`
      SELECT * FROM runs
      WHERE pipeline = ? AND club_slug = 'rondo'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(name);

    // Get last completed run (for previous duration display)
    const previousRun = database.prepare(`
      SELECT * FROM runs
      WHERE pipeline = ? AND club_slug = 'rondo' AND outcome IN ('success', 'failure', 'partial')
      ORDER BY started_at DESC
      LIMIT 1
    `).get(name);

    // Compute overdue status based on schedule:
    // A pipeline is overdue when it hasn't run since its most recent scheduled time
    // AND more than OVERDUE_GRACE_HOURS have passed since that scheduled time.
    let isOverdue = false;
    const prevScheduled = getPreviousScheduledRun(name, now);
    if (prevScheduled) {
      const scheduledTime = prevScheduled.time;
      const hoursSinceScheduled = (now - scheduledTime) / (1000 * 60 * 60);
      const hasRunSinceScheduled = previousRun && new Date(previousRun.started_at) >= scheduledTime;
      isOverdue = hoursSinceScheduled > OVERDUE_GRACE_HOURS && !hasRunSinceScheduled;
    }

    // Determine status
    let status = 'unknown';
    if (run) {
      status = run.outcome; // 'success', 'failure', 'running'
    }

    // Get next run time
    const nextRun = getNextRun(name);

    pipelines.push({
      name,
      displayName: config.displayName,
      description: config.description || null,
      status,
      isOverdue,
      lastRun: run || null,
      previousRun: previousRun || null,
      nextRun: nextRun || null,
      manualNote: config.manualNote || null,
      sourceSportlink: config.sourceSportlink === true
    });
  }

  return pipelines;
}

/**
 * Get paginated run history for a pipeline
 * @param {string} pipeline - Pipeline name
 * @param {number} page - Page number (1-indexed)
 * @param {number} perPage - Runs per page
 * @returns {Object} { runs: Array, totalRuns: number, totalPages: number }
 */
function getRunHistory(pipeline, page = 1, perPage = 20) {
  const database = ensureDb();

  // Get total count
  const countRow = database.prepare(`
    SELECT COUNT(*) as count FROM runs
    WHERE pipeline = ? AND club_slug = 'rondo'
  `).get(pipeline);
  const totalRuns = countRow.count;
  const totalPages = Math.ceil(totalRuns / perPage);

  // Get paginated runs
  const offset = (page - 1) * perPage;
  const runs = database.prepare(`
    SELECT * FROM runs
    WHERE pipeline = ? AND club_slug = 'rondo'
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).all(pipeline, perPage, offset);

  return {
    runs,
    totalRuns,
    totalPages,
    currentPage: page,
    perPage
  };
}

/**
 * Get run detail with steps and error count
 * @param {number} runId - Run ID
 * @returns {Object|null} { run: Object, steps: Array, errorCount: number }
 */
function getRunDetail(runId) {
  const database = ensureDb();

  // Get run
  const run = database.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId);
  if (!run) {
    return null;
  }

  // Get steps
  const steps = database.prepare(`
    SELECT * FROM run_steps
    WHERE run_id = ?
    ORDER BY started_at ASC
  `).all(runId);

  // Get error count
  const errorRow = database.prepare(`
    SELECT COUNT(*) as count FROM run_errors WHERE run_id = ?
  `).get(runId);
  const errorCount = errorRow.count;

  return {
    run,
    steps,
    errorCount
  };
}

/**
 * Get paginated errors with optional filters
 * @param {Object} options - Filter options
 * @param {string} [options.pipeline] - Pipeline name
 * @param {string} [options.dateFrom] - ISO date string (start of day)
 * @param {string} [options.dateTo] - ISO date string (end of day)
 * @param {number} [options.runId] - Run ID
 * @param {number} [options.page=1] - Page number (1-indexed)
 * @param {number} [options.perPage=20] - Results per page
 * @returns {Object} { errors: Array, totalErrors: number, totalPages: number }
 */
function getErrors(options = {}) {
  const database = ensureDb();
  const {
    pipeline,
    dateFrom,
    dateTo,
    runId,
    page = 1,
    perPage = 20
  } = options;

  // Build WHERE clause dynamically
  const whereConditions = ['runs.club_slug = ?'];
  const params = ['rondo'];

  if (pipeline) {
    whereConditions.push('runs.pipeline = ?');
    params.push(pipeline);
  }

  if (dateFrom) {
    whereConditions.push('run_errors.created_at >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    // Add time to include full day
    whereConditions.push('run_errors.created_at <= ?');
    params.push(dateTo + 'T23:59:59');
  }

  if (runId) {
    whereConditions.push('run_errors.run_id = ?');
    params.push(runId);
  }

  const whereClause = whereConditions.join(' AND ');

  // Get total count
  const countRow = database.prepare(`
    SELECT COUNT(*) as count FROM run_errors
    JOIN runs ON run_errors.run_id = runs.id
    WHERE ${whereClause}
  `).get(...params);
  const totalErrors = countRow.count;
  const totalPages = Math.ceil(totalErrors / perPage);

  // Get paginated errors
  const offset = (page - 1) * perPage;
  const errors = database.prepare(`
    SELECT
      run_errors.id,
      run_errors.run_id,
      run_errors.step_name,
      run_errors.member_identifier,
      run_errors.error_message,
      run_errors.created_at,
      runs.pipeline
    FROM run_errors
    JOIN runs ON run_errors.run_id = runs.id
    WHERE ${whereClause}
    ORDER BY run_errors.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  return {
    errors,
    totalErrors,
    totalPages,
    currentPage: page,
    perPage
  };
}

/**
 * Get all errors for a specific run
 * @param {number} runId - Run ID
 * @returns {Object|null} { run: Object, errors: Array }
 */
function getRunErrors(runId) {
  const database = ensureDb();

  // Get run
  const run = database.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId);
  if (!run) {
    return null;
  }

  // Get all errors for this run
  const errors = database.prepare(`
    SELECT * FROM run_errors
    WHERE run_id = ?
    ORDER BY created_at ASC
  `).all(runId);

  return {
    run,
    errors
  };
}

/**
 * Check if a pipeline is currently running
 * @param {string} pipeline - Pipeline name
 * @returns {boolean} True if pipeline has a run with outcome 'running'
 */
function isPipelineRunning(pipeline) {
  const database = ensureDb();
  const row = database.prepare(`
    SELECT COUNT(*) as count FROM runs
    WHERE pipeline = ? AND club_slug = 'rondo' AND outcome = 'running'
  `).get(pipeline);
  return row.count > 0;
}

/**
 * Delete all errors from the dashboard database.
 * @returns {{ errors: number }} Number of rows deleted
 */
function clearErrors() {
  const database = ensureDb();
  const errors = database.prepare('DELETE FROM run_errors').run().changes;
  return { errors };
}

/**
 * Close database connection (for clean shutdown)
 */
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getPipelineOverview,
  getRunHistory,
  getRunDetail,
  getErrors,
  getRunErrors,
  isPipelineRunning,
  clearErrors,
  closeDb
};

// CLI self-test
if (require.main === module) {
  console.log('Running dashboard-queries self-test...\n');

  console.log('Testing getPipelineOverview():');
  const overview = getPipelineOverview();
  console.log(`  Found ${overview.length} pipelines`);
  overview.forEach(p => {
    console.log(`  - ${p.displayName}: status=${p.status}, overdue=${p.isOverdue}, lastRun=${p.lastRun ? p.lastRun.started_at : 'never'}`);
  });

  console.log('\nTesting getRunHistory():');
  const history = getRunHistory('people', 1, 5);
  console.log(`  Total runs: ${history.totalRuns}, showing ${history.runs.length}`);
  if (history.runs.length > 0) {
    console.log(`  Latest run: ${history.runs[0].started_at} (outcome: ${history.runs[0].outcome})`);
  }

  console.log('\nTesting getRunDetail():');
  if (history.runs.length > 0) {
    const detail = getRunDetail(history.runs[0].id);
    if (detail) {
      console.log(`  Run ${detail.run.id}: ${detail.steps.length} steps, ${detail.errorCount} errors`);
    }
  } else {
    console.log('  No runs found to test detail');
  }

  closeDb();
  console.log('\nSelf-test complete!');
}
