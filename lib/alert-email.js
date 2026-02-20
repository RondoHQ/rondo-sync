#!/usr/bin/env node
require('dotenv/config');

const { Lettermint } = require('lettermint');
const { openDb } = require('./dashboard-db');
const { getPreviousScheduledRun, PIPELINE_SCHEDULES } = require('./schedule');

// Last overdue alert state (in-memory for 4-hour cooldown)
let lastOverdueAlert = {
  timestamp: null,
  pipelines: []
};

/** Grace period: pipeline is overdue when it hasn't run 4 hours after its scheduled time */
const OVERDUE_GRACE_HOURS = 4;

// Pipeline display names
const PIPELINE_CONFIG = {
  people: { displayName: 'People' },
  nikki: { displayName: 'Nikki' },
  freescout: { displayName: 'FreeScout' },
  teams: { displayName: 'Teams' },
  functions: { displayName: 'Member roles + VOG' },
  'functions-full': { displayName: 'Member roles (full)' },
  discipline: { displayName: 'Discipline' },
  'former-members': { displayName: 'Former members' }
};

/**
 * Send a failure alert email for a pipeline run
 * @param {Object} options
 * @param {string} options.pipeline - Pipeline name
 * @param {number} options.runId - Run ID
 * @param {string} [options.error] - Error message
 * @param {string} [options.startedAt] - ISO timestamp when run started
 * @returns {Promise<void>}
 */
async function sendFailureAlert({ pipeline, runId, error, startedAt }) {
  // Validate environment
  if (!process.env.LETTERMINT_API_TOKEN) {
    console.warn('[alert-email] LETTERMINT_API_TOKEN not set, skipping failure alert');
    return;
  }
  if (!process.env.LETTERMINT_FROM_EMAIL || !process.env.OPERATOR_EMAIL) {
    console.warn('[alert-email] LETTERMINT_FROM_EMAIL or OPERATOR_EMAIL not set, skipping failure alert');
    return;
  }

  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
  const displayName = PIPELINE_CONFIG[pipeline]?.displayName || pipeline;
  const runUrl = `${dashboardUrl}/run/${runId}`;

  // Build email subject
  const subject = `[Rondo Sync] FAILED: ${pipeline} pipeline`;

  // Build email body
  const htmlBody = buildFailureEmailHtml({
    displayName,
    pipeline,
    runId,
    runUrl,
    error,
    startedAt
  });

  const textBody = buildFailureEmailText({
    displayName,
    pipeline,
    runId,
    runUrl,
    error,
    startedAt
  });

  // Send email
  const lettermint = new Lettermint({ apiToken: process.env.LETTERMINT_API_TOKEN });
  try {
    await lettermint.email
      .from(`Rondo SYNC <${process.env.LETTERMINT_FROM_EMAIL}>`)
      .to(process.env.OPERATOR_EMAIL)
      .subject(subject)
      .html(htmlBody)
      .text(textBody)
      .send();
    console.log(`[alert-email] Failure alert sent for ${pipeline} pipeline (run ${runId})`);
  } catch (err) {
    console.error(`[alert-email] Failed to send failure alert: ${err.message}`);
    throw err;
  }
}

/**
 * Send an overdue alert email for multiple pipelines
 * @param {Array<Object>} overduePipelines - Array of { name, displayName, hoursSince }
 * @returns {Promise<void>}
 */
async function sendOverdueAlert(overduePipelines) {
  // Validate environment
  if (!process.env.LETTERMINT_API_TOKEN) {
    console.warn('[alert-email] LETTERMINT_API_TOKEN not set, skipping overdue alert');
    return;
  }
  if (!process.env.LETTERMINT_FROM_EMAIL || !process.env.OPERATOR_EMAIL) {
    console.warn('[alert-email] LETTERMINT_FROM_EMAIL or OPERATOR_EMAIL not set, skipping overdue alert');
    return;
  }

  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

  // Build subject line (pipeline names, comma-separated)
  const pipelineNames = overduePipelines.map(p => p.name).join(', ');
  const subject = `[Rondo Sync] OVERDUE: ${pipelineNames}`;

  // Build email body
  const htmlBody = buildOverdueEmailHtml({
    overduePipelines,
    dashboardUrl
  });

  const textBody = buildOverdueEmailText({
    overduePipelines,
    dashboardUrl
  });

  // Send email
  const lettermint = new Lettermint({ apiToken: process.env.LETTERMINT_API_TOKEN });
  try {
    await lettermint.email
      .from(`Rondo SYNC <${process.env.LETTERMINT_FROM_EMAIL}>`)
      .to(process.env.OPERATOR_EMAIL)
      .subject(subject)
      .html(htmlBody)
      .text(textBody)
      .send();
    console.log(`[alert-email] Overdue alert sent for ${overduePipelines.length} pipeline(s)`);
  } catch (err) {
    console.error(`[alert-email] Failed to send overdue alert: ${err.message}`);
    throw err;
  }
}

/**
 * Check for overdue pipelines and send alert if needed
 * Implements 4-hour cooldown to prevent spam
 * @returns {Promise<void>}
 */
async function checkAndAlertOverdue() {
  let db;
  try {
    db = openDb();
    const now = new Date();
    const overduePipelines = [];

    // Check each pipeline for overdue status based on schedule
    for (const [name, config] of Object.entries(PIPELINE_CONFIG)) {
      const previousRun = db.prepare(`
        SELECT * FROM runs
        WHERE pipeline = ? AND club_slug = 'rondo' AND outcome IN ('success', 'failure', 'partial')
        ORDER BY started_at DESC
        LIMIT 1
      `).get(name);

      const prevScheduled = getPreviousScheduledRun(name, now);
      if (!prevScheduled) continue;

      const scheduledTime = prevScheduled.time;
      const hoursSinceScheduled = (now - scheduledTime) / (1000 * 60 * 60);
      const hasRunSinceScheduled = previousRun && new Date(previousRun.started_at) >= scheduledTime;
      const isOverdue = hoursSinceScheduled > OVERDUE_GRACE_HOURS && !hasRunSinceScheduled;

      if (isOverdue) {
        overduePipelines.push({
          name,
          displayName: config.displayName,
          hoursSince: Math.floor(hoursSinceScheduled)
        });
      }
    }

    // If no pipelines are overdue, clear state and return
    if (overduePipelines.length === 0) {
      lastOverdueAlert = { timestamp: null, pipelines: [] };
      return;
    }

    // Check 4-hour cooldown
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const shouldSendAlert = shouldSendOverdueAlert(overduePipelines, fourHoursMs);

    if (shouldSendAlert) {
      await sendOverdueAlert(overduePipelines);
      // Update last alert state
      lastOverdueAlert = {
        timestamp: now,
        pipelines: overduePipelines.map(p => p.name)
      };
    } else {
      console.log(`[alert-email] Overdue pipelines detected but within 4-hour cooldown, skipping alert`);
    }
  } catch (err) {
    console.error(`[alert-email] Error checking overdue pipelines: ${err.message}`);
    throw err;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Determine if an overdue alert should be sent
 * @param {Array} overduePipelines - Current overdue pipelines
 * @param {number} cooldownMs - Cooldown period in milliseconds
 * @returns {boolean}
 * @private
 */
function shouldSendOverdueAlert(overduePipelines, cooldownMs) {
  // First alert ever
  if (!lastOverdueAlert.timestamp) {
    return true;
  }

  // Check if set of overdue pipelines has changed
  const currentPipelineSet = new Set(overduePipelines.map(p => p.name));
  const previousPipelineSet = new Set(lastOverdueAlert.pipelines);

  const setsEqual =
    currentPipelineSet.size === previousPipelineSet.size &&
    [...currentPipelineSet].every(p => previousPipelineSet.has(p));

  // If the set changed, send alert regardless of cooldown
  if (!setsEqual) {
    return true;
  }

  // If set unchanged, check cooldown
  const timeSinceLastAlert = Date.now() - lastOverdueAlert.timestamp;
  return timeSinceLastAlert >= cooldownMs;
}

/**
 * Build HTML email for failure alert
 * @private
 */
function buildFailureEmailHtml({ displayName, pipeline, runId, runUrl, error, startedAt }) {
  const errorSection = error
    ? `<p style="margin: 16px 0; padding: 12px; background: #f8d7da; border-left: 4px solid #dc3545; color: #721c24;">
         <strong>Error:</strong> ${escapeHtml(error)}
       </p>`
    : '';

  const timeInfo = startedAt
    ? `<p style="margin: 8px 0; color: #666;">Started: ${new Date(startedAt).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; max-width: 600px; color: #333; line-height: 1.5;">
  <h1 style="font-size: 20px; color: #dc3545; margin-bottom: 16px;">Pipeline Failure: ${escapeHtml(displayName)}</h1>

  <p style="margin: 8px 0;">The <strong>${escapeHtml(pipeline)}</strong> pipeline failed during execution.</p>
  ${timeInfo}

  ${errorSection}

  <p style="margin: 24px 0;">
    <a href="${runUrl}" style="display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; font-weight: 500;">View Run Details</a>
  </p>

  <p style="margin: 24px 0 0 0; font-size: 12px; color: #999; border-top: 1px solid #ddd; padding-top: 16px;">
    Rondo Sync Dashboard: <a href="${process.env.DASHBOARD_URL || 'http://localhost:3000'}" style="color: #007bff;">${process.env.DASHBOARD_URL || 'http://localhost:3000'}</a>
  </p>
</body>
</html>`;
}

/**
 * Build text email for failure alert
 * @private
 */
function buildFailureEmailText({ displayName, pipeline, runId, runUrl, error, startedAt }) {
  const errorSection = error ? `\nError: ${error}\n` : '';
  const timeInfo = startedAt ? `Started: ${new Date(startedAt).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })}\n` : '';

  return `PIPELINE FAILURE: ${displayName}

The ${pipeline} pipeline failed during execution.
${timeInfo}${errorSection}
View run details: ${runUrl}

---
Rondo Sync Dashboard: ${process.env.DASHBOARD_URL || 'http://localhost:3000'}
`;
}

/**
 * Build HTML email for overdue alert
 * @private
 */
function buildOverdueEmailHtml({ overduePipelines, dashboardUrl }) {
  const pipelineRows = overduePipelines.map(p => {
    const hoursDisplay = p.hoursSince > 1000 ? 'Never run' : `${p.hoursSince}h ago`;
    return `<tr>
      <td style="padding: 8px; border-bottom: 1px solid #ddd;">${escapeHtml(p.displayName)}</td>
      <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right; color: #dc3545; font-weight: 500;">${hoursDisplay}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; max-width: 600px; color: #333; line-height: 1.5;">
  <h1 style="font-size: 20px; color: #ff9800; margin-bottom: 16px;">Overdue Pipelines</h1>

  <p style="margin: 8px 0 16px 0;">The following pipelines have not run within their expected schedule:</p>

  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <thead>
      <tr style="background: #f5f5f5;">
        <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Pipeline</th>
        <th style="padding: 8px; text-align: right; border-bottom: 2px solid #ddd;">Last Run</th>
      </tr>
    </thead>
    <tbody>
      ${pipelineRows}
    </tbody>
  </table>

  <p style="margin: 24px 0;">
    <a href="${dashboardUrl}" style="display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; font-weight: 500;">View Dashboard</a>
  </p>

  <p style="margin: 24px 0 0 0; font-size: 12px; color: #999; border-top: 1px solid #ddd; padding-top: 16px;">
    This alert will repeat every 4 hours while pipelines remain overdue.
  </p>
</body>
</html>`;
}

/**
 * Build text email for overdue alert
 * @private
 */
function buildOverdueEmailText({ overduePipelines, dashboardUrl }) {
  const pipelineList = overduePipelines.map(p => {
    const hoursDisplay = p.hoursSince > 1000 ? 'Never run' : `${p.hoursSince}h ago`;
    return `  - ${p.displayName}: ${hoursDisplay}`;
  }).join('\n');

  return `OVERDUE PIPELINES

The following pipelines have not run within their expected schedule:

${pipelineList}

View dashboard: ${dashboardUrl}

---
This alert will repeat every 4 hours while pipelines remain overdue.
`;
}

/**
 * Escape HTML entities
 * @private
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  sendFailureAlert,
  sendOverdueAlert,
  checkAndAlertOverdue
};

// CLI
if (require.main === module) {
  const command = process.argv[2];

  if (command === 'send-failure-alert') {
    // Parse arguments
    const args = process.argv.slice(3);
    const pipelineIndex = args.indexOf('--pipeline');
    const runIdIndex = args.indexOf('--run-id');

    if (pipelineIndex === -1) {
      console.error('Usage: alert-email.js send-failure-alert --pipeline <name> [--run-id <id>]');
      console.error('');
      console.error('If --run-id is not provided, the latest run for the pipeline will be used.');
      process.exit(1);
    }

    const pipeline = args[pipelineIndex + 1];
    let runId = runIdIndex !== -1 ? parseInt(args[runIdIndex + 1], 10) : null;

    // If no run ID provided, look up the latest run
    if (!runId) {
      const db = openDb();
      try {
        const row = db.prepare(`
          SELECT id, started_at FROM runs
          WHERE pipeline = ? AND club_slug = 'rondo'
          ORDER BY started_at DESC
          LIMIT 1
        `).get(pipeline);

        if (!row) {
          console.error(`No runs found for pipeline: ${pipeline}`);
          process.exit(1);
        }

        runId = row.id;
      } finally {
        db.close();
      }
    }

    // Send failure alert
    sendFailureAlert({ pipeline, runId })
      .then(() => {
        console.log('Failure alert sent successfully');
        process.exit(0);
      })
      .catch(err => {
        console.error('Failed to send failure alert:', err.message);
        process.exit(1);
      });

  } else if (command === 'check-overdue') {
    checkAndAlertOverdue()
      .then(() => {
        console.log('Overdue check complete');
        process.exit(0);
      })
      .catch(err => {
        console.error('Overdue check failed:', err.message);
        process.exit(1);
      });

  } else {
    console.error('Usage: alert-email.js <command> [options]');
    console.error('');
    console.error('Commands:');
    console.error('  send-failure-alert --pipeline <name> [--run-id <id>]');
    console.error('    Send a failure alert for a pipeline run');
    console.error('    If --run-id is omitted, uses the latest run for the pipeline');
    console.error('');
    console.error('  check-overdue');
    console.error('    Check for overdue pipelines and send alerts if needed');
    console.error('    Implements 4-hour cooldown to prevent spam');
    console.error('');
    console.error('Required environment variables:');
    console.error('  LETTERMINT_API_TOKEN  - Lettermint API Token');
    console.error('  LETTERMINT_FROM_EMAIL - Verified sender email address');
    console.error('  OPERATOR_EMAIL        - Recipient email address');
    console.error('  DASHBOARD_URL         - Dashboard URL (e.g., https://sync.rfreimann.nl)');
    process.exit(1);
  }
}
