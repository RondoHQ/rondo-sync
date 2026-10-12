'use strict';
require('dotenv/config');
const Sentry = require('@sentry/node');
const { version } = require('../package.json');

/** Keep only diagnostic metadata; local logs retain original messages. */
function sanitizeEvent(event) {
  return {
    event_id: event.event_id, timestamp: event.timestamp, platform: event.platform,
    level: event.level, release: event.release, environment: event.environment,
    sdk: event.sdk,
    tags: Object.fromEntries(Object.entries(event.tags || {}).filter(([key]) => ['pipeline', 'step', 'outcome'].includes(key))),
    exception: event.exception && { values: event.exception.values.map(value => ({
      type: value.type, value: 'Rondo Sync error; details in private local logs',
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
    defaultIntegrations: false, sendDefaultPii: false, maxBreadcrumbs: 0,
    beforeSend: sanitizeEvent, tracesSampleRate: 0, sendClientReports: false,
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
module.exports = { captureError, flush, sanitizeEvent };
