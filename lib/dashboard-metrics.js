'use strict';

const PEOPLE_PROCESSED_STEPS = new Set([
  'sportlink-download',
  'sportlink-inactive-download',
  'laposta-prepare',
  'photo-download'
]);

function parseSummary(summaryJson) {
  if (!summaryJson) return null;

  try {
    return JSON.parse(summaryJson);
  } catch {
    return null;
  }
}

/**
 * Add dashboard-only totals with domain semantics.
 *
 * A People run's stored totals aggregate every step. That made downloaded and
 * prepared rows look like newly created people. The pipeline summary already
 * contains the authoritative Rondo Club person counts, so use those in the UI.
 */
function withDisplayMetrics(run) {
  if (!run) return run;

  const decorated = {
    ...run,
    display_created: Number(run.total_created || 0),
    display_updated: Number(run.total_updated || 0),
    display_skipped: Number(run.total_skipped || 0),
    display_metric_label: null
  };

  if (run.pipeline !== 'people') return decorated;

  const summary = parseSummary(run.summary_json);
  const people = summary?.rondoClub;
  if (!people) return decorated;

  decorated.display_created = Number(people.created || 0);
  decorated.display_updated = Number(people.updated || 0);
  decorated.display_skipped = Number(people.skipped || 0);
  decorated.display_metric_label = 'People';

  return decorated;
}

/**
 * Reclassify internal People pipeline output as processed work for display.
 * The underlying run data stays untouched so historical records remain intact.
 */
function withDisplayStepMetrics(pipeline, steps) {
  return steps.map((step) => {
    const decorated = { ...step, processed_count: 0 };

    if (pipeline === 'people' && PEOPLE_PROCESSED_STEPS.has(step.step_name)) {
      decorated.processed_count = Number(step.created_count || 0);
      decorated.created_count = 0;
    }

    return decorated;
  });
}

module.exports = {
  withDisplayMetrics,
  withDisplayStepMetrics
};
