const { openDb } = require('./dashboard-db');
const { nowISO } = require('./utils');

// Module-level state for crash handlers
let _crashHandlersRegistered = false;
let _activeTracker = null;

/**
 * Handle uncaught exceptions and unhandled rejections
 * @private
 */
function _handleCrash(errOrReason) {
  const tracker = _activeTracker;
  if (tracker && tracker.runId && tracker.db) {
    try {
      const finishedAt = nowISO();
      // Compute duration
      let durationMs = 0;
      const runRow = tracker._getRunStart.get(tracker.runId);
      if (runRow && runRow.started_at) {
        durationMs = new Date(finishedAt) - new Date(runRow.started_at);
      }
      // Aggregate step counts
      const totals = tracker._sumSteps.get(tracker.runId);
      // Record the crash as an error
      tracker._insertError.run(
        tracker.runId,
        null,
        'crash',
        null,
        String(errOrReason && errOrReason.message ? errOrReason.message : errOrReason).substring(0, 2000),
        errOrReason && errOrReason.stack ? String(errOrReason.stack).substring(0, 4000) : null,
        finishedAt
      );
      // Update run as failure
      tracker._updateRun.run(
        finishedAt,
        durationMs,
        'failure',
        totals.total_created,
        totals.total_updated,
        totals.total_skipped,
        totals.total_failed,
        JSON.stringify({ crash: true, error: String(errOrReason) }),
        tracker.runId
      );
      tracker.db.close();
      tracker.db = null;
    } catch (dbErr) {
      console.error(`[run-tracker] Failed to record crash: ${dbErr.message}`);
    }
  }
  _activeTracker = null;
}

/**
 * RunTracker - Track pipeline execution in dashboard database
 *
 * Records run timing, per-step counts, and individual errors.
 * All public methods are wrapped in try/catch to ensure tracking
 * failures never crash the pipeline.
 */
class RunTracker {
  /**
   * @param {string} pipeline - Pipeline name (e.g., 'people', 'teams', 'all')
   */
  constructor(pipeline) {
    this.pipeline = pipeline;
    this.runId = null;
    this.db = null;

    try {
      this.db = openDb();
      this._prepareStatements();
    } catch (err) {
      console.error(`[run-tracker] Failed to open database: ${err.message}`);
    }
  }

  /**
   * Prepare all SQL statements for performance
   * @private
   */
  _prepareStatements() {
    if (!this.db) return;

    this._insertRun = this.db.prepare(`
      INSERT INTO runs (pipeline, started_at, outcome)
      VALUES (?, ?, 'running')
    `);

    this._insertStep = this.db.prepare(`
      INSERT INTO run_steps (run_id, step_name, started_at)
      VALUES (?, ?, ?)
    `);

    this._updateStep = this.db.prepare(`
      UPDATE run_steps
      SET finished_at = ?, duration_ms = ?, outcome = ?,
          created_count = ?, updated_count = ?, skipped_count = ?,
          failed_count = ?, detail_json = ?
      WHERE id = ?
    `);

    this._insertError = this.db.prepare(`
      INSERT INTO run_errors
        (run_id, run_step_id, step_name, member_identifier, error_message, error_stack, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this._getStepStart = this.db.prepare(`
      SELECT started_at FROM run_steps WHERE id = ?
    `);

    this._getRunStart = this.db.prepare(`
      SELECT started_at FROM runs WHERE id = ?
    `);

    this._sumSteps = this.db.prepare(`
      SELECT
        COALESCE(SUM(created_count), 0) as total_created,
        COALESCE(SUM(updated_count), 0) as total_updated,
        COALESCE(SUM(skipped_count), 0) as total_skipped,
        COALESCE(SUM(failed_count), 0) as total_failed
      FROM run_steps
      WHERE run_id = ?
    `);

    this._updateRun = this.db.prepare(`
      UPDATE runs
      SET finished_at = ?, duration_ms = ?, outcome = ?,
          total_created = ?, total_updated = ?, total_skipped = ?,
          total_failed = ?, summary_json = ?
      WHERE id = ?
    `);
  }

  /**
   * Delete runs, steps, and errors older than 3 days.
   *
   * Runs still marked `running` are kept regardless of age — deleting them
   * loses the only record that the dashboard has of a stuck pipeline, so
   * the next launch silently shows "Never run" while the orphaned process
   * still holds its flock. Stale runners get marked `failure` separately
   * (see {@link _markStaleRunning}).
   * @private
   */
  _cleanup() {
    if (!this.db) return;

    try {
      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`DELETE FROM run_errors WHERE run_id IN (
        SELECT id FROM runs WHERE started_at < ? AND outcome != 'running'
      )`).run(cutoff);
      this.db.prepare(`DELETE FROM run_steps WHERE run_id IN (
        SELECT id FROM runs WHERE started_at < ? AND outcome != 'running'
      )`).run(cutoff);
      this.db.prepare(`DELETE FROM runs WHERE started_at < ? AND outcome != 'running'`).run(cutoff);
    } catch (err) {
      console.error(`[run-tracker] Cleanup failed: ${err.message}`);
    }
  }

  /**
   * Mark `running` rows older than 12 hours as `failure` so the dashboard
   * stops showing them as in-flight. Runs of this length without a finish
   * timestamp are always crashes (the process exited without endRun), not
   * legitimate long syncs — even player-history finishes within an hour.
   * @private
   */
  _markStaleRunning() {
    if (!this.db) return;

    try {
      const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`
        UPDATE runs
        SET outcome = 'failure',
            finished_at = ?,
            summary_json = COALESCE(summary_json, '{"stale":true,"note":"marked failed by _markStaleRunning"}')
        WHERE outcome = 'running' AND started_at < ?
      `).run(new Date().toISOString(), cutoff);
    } catch (err) {
      console.error(`[run-tracker] Stale-run sweep failed: ${err.message}`);
    }
  }

  /**
   * Safely execute a function, catching and logging any errors
   * @private
   */
  _safe(fn, methodName) {
    if (!this.db) return null;

    try {
      return fn();
    } catch (err) {
      console.error(`[run-tracker] Error in ${methodName}: ${err.message}`);
      return null;
    }
  }

  /**
   * Start a new run
   * @returns {number|null} Run ID or null if failed
   */
  startRun() {
    return this._safe(() => {
      // Mark abandoned runs as failure, then purge old finished rows.
      this._markStaleRunning();
      this._cleanup();

      const result = this._insertRun.run(this.pipeline, nowISO());
      this.runId = result.lastInsertRowid;

      // Set this tracker as active for crash handling
      _activeTracker = this;

      // Register crash handlers (once per process)
      if (!_crashHandlersRegistered) {
        process.once('uncaughtException', (err) => {
          console.error(`[run-tracker] Uncaught exception, marking run as failed: ${err.message}`);
          _handleCrash(err);
          process.exit(1);
        });
        process.once('unhandledRejection', (reason) => {
          console.error(`[run-tracker] Unhandled rejection, marking run as failed: ${reason}`);
          _handleCrash(reason);
          process.exit(1);
        });
        _crashHandlersRegistered = true;
      }

      return this.runId;
    }, 'startRun');
  }

  /**
   * Start a step within the current run
   * @param {string} stepName - Step name
   * @returns {number|null} Step ID or null if failed
   */
  startStep(stepName) {
    return this._safe(() => {
      const result = this._insertStep.run(this.runId, stepName, nowISO());
      return result.lastInsertRowid;
    }, 'startStep');
  }

  /**
   * End a step and record its results
   * @param {number|null} stepId - Step ID from startStep
   * @param {Object} options - Step results
   * @param {string} [options.outcome='success'] - 'success' or 'failure'
   * @param {number} [options.created=0] - Number of items created
   * @param {number} [options.updated=0] - Number of items updated
   * @param {number} [options.skipped=0] - Number of items skipped
   * @param {number} [options.failed=0] - Number of items failed
   * @param {Object} [options.detail] - Additional detail to store as JSON
   */
  endStep(stepId, options = {}) {
    if (!stepId) return;

    this._safe(() => {
      const {
        outcome = 'success',
        created = 0,
        updated = 0,
        skipped = 0,
        failed = 0,
        detail = null
      } = options;

      const finishedAt = nowISO();
      const detailJson = detail ? JSON.stringify(detail) : null;

      // Compute duration from step's started_at
      let durationMs = 0;
      const stepRow = this._getStepStart.get(stepId);
      if (stepRow && stepRow.started_at) {
        const startedAt = new Date(stepRow.started_at);
        const finishedAtDate = new Date(finishedAt);
        durationMs = finishedAtDate - startedAt;
      }

      this._updateStep.run(
        finishedAt,
        durationMs,
        outcome,
        created,
        updated,
        skipped,
        failed,
        detailJson,
        stepId
      );
    }, 'endStep');
  }

  /**
   * Record a single error
   * @param {Object} options - Error details
   * @param {string} options.stepName - Step name where error occurred
   * @param {number} [options.stepId] - Step ID (optional)
   * @param {string} [options.memberIdentifier] - Member identifier (KNVB ID, email, etc.)
   * @param {string} options.errorMessage - Error message
   * @param {string} [options.errorStack] - Error stack trace (optional)
   */
  recordError({ stepName, stepId, memberIdentifier, errorMessage, errorStack }) {
    this._safe(() => {
      // Truncate message and stack to fit database limits
      const message = errorMessage ? String(errorMessage).substring(0, 2000) : 'Unknown error';
      const stack = errorStack ? String(errorStack).substring(0, 4000) : null;
      const identifier = memberIdentifier || null;

      this._insertError.run(
        this.runId,
        stepId || null,
        stepName,
        identifier,
        message,
        stack,
        nowISO()
      );
    }, 'recordError');
  }

  /**
   * Record multiple errors from a pipeline step
   * @param {string} stepName - Step name
   * @param {number|null} stepId - Step ID
   * @param {Array|number} errors - Array of error objects or error count
   */
  recordErrors(stepName, stepId, errors) {
    // Handle no errors case
    if (!errors || (Array.isArray(errors) && errors.length === 0)) {
      return;
    }

    // Handle numeric error count (e.g., nikki pipeline)
    if (typeof errors === 'number' && errors > 0) {
      this.recordError({
        stepName,
        stepId,
        memberIdentifier: null,
        errorMessage: `Step reported ${errors} error(s)`,
        errorStack: null
      });
      return;
    }

    // Handle error array
    if (!Array.isArray(errors)) {
      return;
    }

    for (const error of errors) {
      // Extract member identifier with precedence order
      const memberIdentifier =
        error.knvb_id ||
        error.email ||
        error.dossier_id ||
        error.team_name ||
        error.commissie_name ||
        null;

      const errorMessage = error.message || error.error || 'Unknown error';
      const errorStack = error.stack || null;

      this.recordError({
        stepName,
        stepId,
        memberIdentifier,
        errorMessage,
        errorStack
      });
    }
  }

  /**
   * End the run and compute totals
   * @param {string|boolean} outcome - Outcome: 'success', 'partial', 'failure' (or true/false for backward compat)
   * @param {Object} stats - Pipeline stats object to store as summary
   */
  endRun(outcome, stats) {
    this._safe(() => {
      // Backward compatibility: accept boolean
      if (outcome === true) outcome = 'success';
      if (outcome === false) outcome = 'failure';

      const finishedAt = nowISO();

      // Compute duration from run's started_at
      let durationMs = 0;
      const runRow = this._getRunStart.get(this.runId);
      if (runRow && runRow.started_at) {
        const startedAt = new Date(runRow.started_at);
        const finishedAtDate = new Date(finishedAt);
        durationMs = finishedAtDate - startedAt;
      }

      // Aggregate step counts
      const totals = this._sumSteps.get(this.runId);

      // Update run record
      this._updateRun.run(
        finishedAt,
        durationMs,
        outcome,
        totals.total_created,
        totals.total_updated,
        totals.total_skipped,
        totals.total_failed,
        JSON.stringify(stats),
        this.runId
      );

      // Clear active tracker so crash handler won't double-act
      _activeTracker = null;

      // Close database connection
      this.close();
    }, 'endRun');
  }

  /**
   * Close database connection (idempotent)
   */
  close() {
    if (this.db) {
      try {
        // Clear active tracker reference as safety net
        if (_activeTracker === this) {
          _activeTracker = null;
        }
        this.db.close();
        this.db = null;
      } catch (err) {
        console.error(`[run-tracker] Error closing database: ${err.message}`);
      }
    }
  }
}

module.exports = { RunTracker };

// CLI self-test
if (require.main === module) {
  console.log('Running RunTracker self-test...');

  const tracker = new RunTracker('test');
  const runId = tracker.startRun();

  console.log(`Started run ${runId}`);

  // Test step with success
  const step1 = tracker.startStep('test-step-1');
  tracker.endStep(step1, {
    outcome: 'success',
    created: 10,
    updated: 5,
    skipped: 2,
    failed: 0
  });

  // Test step with errors
  const step2 = tracker.startStep('test-step-2');
  tracker.recordError({
    stepName: 'test-step-2',
    stepId: step2,
    memberIdentifier: 'test-123',
    errorMessage: 'Test error message',
    errorStack: 'Test stack trace'
  });
  tracker.endStep(step2, {
    outcome: 'failure',
    failed: 1
  });

  // Test recordErrors with array
  const step3 = tracker.startStep('test-step-3');
  tracker.recordErrors('test-step-3', step3, [
    { knvb_id: '456', message: 'Error 1' },
    { email: 'test@example.com', message: 'Error 2' }
  ]);
  tracker.endStep(step3, { outcome: 'success', failed: 2 });

  // Test recordErrors with number
  const step4 = tracker.startStep('test-step-4');
  tracker.recordErrors('test-step-4', step4, 3);
  tracker.endStep(step4, { outcome: 'failure', failed: 3 });

  tracker.endRun(true, { test: 'data', totalProcessed: 17 });

  console.log(`Run tracker test complete, run_id: ${runId}`);
}
