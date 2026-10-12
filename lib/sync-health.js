const { getPreviousScheduledRun } = require('./schedule');

/** A completed run must cover the last due slot, allowing time for normal work. */
function isSyncHealthy(pipelines, schedules, now = new Date()) {
  return pipelines.every(pipeline => {
    const schedule = schedules[pipeline.name];
    const graceHours = schedule?.cadence === 'interval' ? 1 : 4;
    const cutoff = new Date(now.getTime() - graceHours * 3600000);
    const due = getPreviousScheduledRun(pipeline.name, cutoff, schedules);
    if (!due) return true; // Disabled/manual or a newly changed schedule.
    const completed = pipeline.previousRun;
    return Boolean(completed && completed.outcome === 'success' && new Date(completed.started_at) >= due.time);
  });
}
module.exports = { isSyncHealthy };
