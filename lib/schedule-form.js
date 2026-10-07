'use strict';

const { PIPELINES } = require('./schedule-config');

function parseScheduleForm(form) {
  const schedules = {};
  for (const id of Object.keys(PIPELINES)) {
    const cadence = form[`${id}_cadence`];
    const schedule = { enabled: form[`${id}_enabled`] === 'on', cadence };
    if (cadence === 'interval') schedule.intervalMinutes = Number(form[`${id}_interval`]);
    else {
      schedule.times = String(form[`${id}_times`] || '').split(',').map(time => time.trim());
      if (cadence === 'weekly') schedule.dayOfWeek = Number(form[`${id}_weekday`]);
      if (cadence === 'monthly') schedule.dayOfMonth = Number(form[`${id}_monthday`]);
    }
    schedules[id] = schedule;
  }
  return schedules;
}

module.exports = { parseScheduleForm };
