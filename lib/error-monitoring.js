'use strict';
require('dotenv/config');
const { performanceEvent, sanitizeTransaction } = require('./performance-monitoring');
const Sentry = require('@sentry/node');
const { version } = require('../package.json');

/** Classify locally; never send an arbitrary message or provider error code. */
function errorCode(event, hint) {
  const error = hint?.originalException;
  const codes = {
    ERR_SPORTLINK_SESSION_EXPIRED: 'sportlink_session_expired',
    ERR_SPORTLINK_SOURCE_INCOMPLETE: 'sportlink_source_incomplete',
    ERR_MEMBER_TEAMS_PANEL_NOT_LOADED: 'sportlink_teams_incomplete',
    ERR_REQUEST_DEADLINE: 'request_timeout',
    ETIMEDOUT: 'request_timeout',
    ECONNRESET: 'connection_reset',
    ENOTFOUND: 'dns_failure',
  };
  if (Object.hasOwn(codes, error?.code)) return codes[error.code];
  const message = event.exception?.values?.map(value => value.value || '').join('\n') || '';
  if (/Current Rondo team role is absent from Sportlink history/.test(message)) return 'team_history_conflict';
  if (/Incomplete MemberFreeFields\/MemberHeader response/.test(message)) return 'sportlink_vog_incomplete';
  if (/MemberTeams panel not loaded/.test(message)) return 'sportlink_teams_incomplete';
  if (/Sportlink source remained unauthorized|(?:Teams|Club teams|Sportlink source) request failed \(401\)/.test(message)) return 'sportlink_session_expired';
  if (/Request deadline exceeded|\bTimeout\b.*exceeded/.test(message)) return 'request_timeout';
  if (message === 'Sync run did not complete successfully') return 'sync_run_incomplete';
  return 'unclassified_error';
}

/** Keep only diagnostic metadata; local logs retain original messages. */
function sanitizeEvent(event, hint) {
  const code = errorCode(event, hint);
  const tags = Object.fromEntries(Object.entries(event.tags || {}).filter(([key]) => ['pipeline', 'step', 'outcome'].includes(key)));
  tags.error_code = code;
  const fingerprint = ['rondo-sync', tags.pipeline || 'unknown', tags.step || 'run', code];
  // Unknown failures retain stack-based separation within their pipeline/step.
  if (code === 'unclassified_error') fingerprint.push('{{ default }}');
  return {
    event_id: event.event_id, timestamp: event.timestamp, platform: event.platform,
    level: event.level, release: event.release, environment: event.environment,
    sdk: event.sdk,
    tags, fingerprint,
    exception: event.exception && { values: event.exception.values.map(value => ({
      type: value.type, value: `Rondo Sync: ${code}; details in private local logs`,
      stacktrace: value.stacktrace && { frames: value.stacktrace.frames.map(frame => ({
        filename: frame.filename?.split(/[?#]/)[0], function: frame.function,
        lineno: frame.lineno, colno: frame.colno, in_app: frame.in_app,
      })) },
    })) },
  };
}

const enabled = Boolean(process.env.GLITCHTIP_DSN);
if (enabled) {
  Sentry.init({ dsn: process.env.GLITCHTIP_DSN, release: `rondo-sync@${version}`,
    environment: process.env.GLITCHTIP_ENVIRONMENT || 'production',
    defaultIntegrations: false, sendDefaultPii: false,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false }, maxBreadcrumbs: 0,
    beforeSend: sanitizeEvent, traceLifecycle: 'static', tracesSampleRate: process.env.GLITCHTIP_PERFORMANCE === 'false' ? 0 : 1,
    beforeSendTransaction: sanitizeTransaction, sendClientReports: false,
  });
}

function captureError(error, tags = {}) {
  if (!enabled) return;
  try {
    return Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags });
  } catch { /* Monitoring must never interrupt a sync. */ }
}
async function flush() {
  if (!enabled) return true;
  try { return await Sentry.flush(2000); } catch { return false; }
}
function recordPerformance(details) {
  if (!enabled || process.env.GLITCHTIP_PERFORMANCE === 'false') return;
  try {
    const event = performanceEvent(details);
    if (event) Sentry.captureEvent(event);
  } catch { /* Observability must never interrupt a sync. */ }
}
module.exports = { captureError, flush, sanitizeEvent, recordPerformance };
