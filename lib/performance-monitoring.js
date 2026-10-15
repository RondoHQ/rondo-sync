const { randomBytes } = require('node:crypto');
const pipelines = new Set(["functions", "functions-full", "all", "discipline", "former-members", "freescout", "freescout-conversations", "nikki", "people", "player-history", "reverse", "sponsit", "teams", "twelve"]);
const steps = new Set(["activities-prepare", "activities-submit", "capability-sync", "commissie-sync", "commissie-work-history-sync", "conversations-download", "deceased-laposta", "deceased-rondo", "discipline-download", "discipline-sync", "former-members-laposta", "former-members-photos-download", "former-members-photos-upload", "former-members-sync", "free-fields-sync", "freescout-sync", "functions-download", "laposta-deliverability", "laposta-prepare", "laposta-submit", "laposta-sync", "nikki-download", "onboarding-source-checks", "photo-download", "photo-upload", "player-history-sync", "rondo-club-sync", "sponsit-download", "sportlink-download", "sportlink-inactive-download", "sportlink-update", "sync-freescout-ids-to-rondo-club", "team-download", "team-sync", "twelve-reports", "work-history-sync"]);
const outcomes = new Set(['success', 'partial', 'failure', 'running']);
const id = bytes => randomBytes(bytes).toString('hex');
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : undefined;
function sanitizeTransaction(event) {
  const pipeline = pipelines.has(event.tags?.pipeline) ? event.tags.pipeline : 'other';
  const step = steps.has(event.tags?.step) ? event.tags.step : (event.tags?.step ? 'other' : undefined);
  const trace = event.contexts?.trace || {};
  const measurements = {};
  for (const key of ['created', 'updated', 'skipped', 'failed']) {
    const value = event.measurements?.[key]?.value;
    if (Number.isFinite(value) && value >= 0) measurements[key] = { value, unit: 'none' };
  }
  return {
    event_id: hex(event.event_id, 32), type: 'transaction', platform: 'node',
    transaction: step ? `${pipeline}/${step}` : pipeline,
    release: event.release, environment: event.environment,
    start_timestamp: event.start_timestamp, timestamp: event.timestamp,
    contexts: { trace: { trace_id: hex(trace.trace_id, 32), span_id: hex(trace.span_id, 16),
      op: step ? 'sync.step' : 'sync.run', status: trace.status === 'internal_error' ? 'internal_error' : 'ok' } },
    tags: { pipeline, ...(step ? { step } : {}), outcome: outcomes.has(event.tags?.outcome) ? event.tags.outcome : 'failure' },
    measurements, spans: [],
  };
}
function performanceEvent({ pipeline, step, startedAt, finishedAt, outcome, counts = {}, traceId }) {
  const start = new Date(startedAt).getTime() / 1000;
  const end = new Date(finishedAt).getTime() / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return sanitizeTransaction({
    event_id: id(16), start_timestamp: start, timestamp: end,
    contexts: { trace: { trace_id: traceId || id(16), span_id: id(8), status: outcome === 'failure' ? 'internal_error' : 'ok' } },
    tags: { pipeline, step, outcome: outcome === true ? 'success' : outcome === false ? 'failure' : outcome },
    measurements: Object.fromEntries(Object.entries(counts).map(([key,value]) => [key, { value }])),
  });
}
module.exports = { performanceEvent, sanitizeTransaction, newTraceId: () => id(16) };
