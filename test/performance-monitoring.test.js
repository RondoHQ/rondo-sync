const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performanceEvent, sanitizeTransaction } = require('../lib/performance-monitoring');

test('long sync steps keep full duration, bounded labels and only aggregate counts', () => {
  const event = performanceEvent({ pipeline: 'people', step: 'PRIVATE', startedAt: '2026-10-15T10:00:00Z',
    finishedAt: '2026-10-15T12:00:00Z', outcome: 'partial', counts: { created: 3, email: 'PRIVATE', failed: 1 }, traceId: 'a'.repeat(32) });
  assert.equal(event.timestamp - event.start_timestamp, 7200);
  assert.equal(event.contexts.trace.trace_id, 'a'.repeat(32));
  assert.equal(event.tags.outcome, 'partial');
  assert.deepEqual(event.measurements.created, { value: 3, unit: 'none' });
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE|email/);
  assert.equal(event.transaction, 'people/other');
});

test('sanitizer removes SDK enrichment and invalid timing is rejected', () => {
  const clean = sanitizeTransaction({ contexts: { trace: { trace_id: 'PRIVATE', data: 'PRIVATE' } },
    tags: { pipeline: 'PRIVATE', outcome: 'PRIVATE' }, user: 'PRIVATE', request: 'PRIVATE', spans: ['PRIVATE'] });
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE/);
  assert.equal(performanceEvent({ startedAt: 'invalid', finishedAt: new Date() }), null);
});
