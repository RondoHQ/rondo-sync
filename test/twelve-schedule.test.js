const {test}=require('node:test');
const assert=require('node:assert/strict');
const {defaults,isDue,nextRun,staleAfterHours,validate}=require('../lib/twelve-schedule');
test('opening hours include evening closure and exclude quiet days',()=>{
  for (const iso of ['2026-10-06T18:00:00Z','2026-10-06T20:00:00Z','2026-10-06T22:00:00Z','2026-10-03T08:00:00Z','2026-10-04T22:00:00Z']) assert.equal(isDue(defaults,new Date(iso)),true,iso);
  for (const iso of ['2026-10-05T18:00:00Z','2026-10-06T16:00:00Z','2026-10-06T19:00:00Z','2026-10-03T06:00:00Z']) assert.equal(isDue(defaults,new Date(iso)),false,iso);
  assert.equal(nextRun(defaults,new Date('2026-10-04T22:01:00Z')).toISOString(),'2026-10-06T18:00:00.000Z');
});
test('custom windows use their own start and include an odd-hour closure',()=>{
  const custom={...defaults,days:[{day:1,start:9,end:14}]};
  for (const h of [7,9,11,12]) assert.equal(isDue(custom,new Date(`2026-10-05T${String(h).padStart(2,'0')}:00:00Z`)),true);
  assert.equal(isDue(custom,new Date('2026-10-05T08:00:00Z')),false);
  assert.equal(nextRun({...defaults,days:[]}),null);
  assert.equal(staleAfterHours({...defaults,days:[]}),0);
});
test('calendar windows follow Amsterdam daylight saving transitions',()=>{
  assert.equal(isDue(defaults,new Date('2026-10-25T09:00:00Z')),true);
  assert.equal(isDue(defaults,new Date('2026-10-25T08:00:00Z')),false);
  assert.equal(nextRun(defaults,new Date('2026-10-24T22:30:00Z')).toISOString(),'2026-10-25T09:00:00.000Z');
  assert(staleAfterHours(defaults,new Date('2026-10-06T17:00:00Z'))>=44);
});
test('rejects corrupt schedules rather than running around the clock',()=>{
  for (const days of [[{day:0,start:24,end:24}],[{day:0,start:20,end:1}],[{day:7,start:1,end:3}],[{day:1,start:1,end:3},{day:1,start:5,end:7}]]) assert.throws(()=>validate({...defaults,days}));
});

test('dashboard previous and next run bracket the reference time',()=>{
  const {getNextRun,getPreviousScheduledRun}=require('../lib/schedule');
  const now=new Date('2026-10-06T17:00:00Z');
  assert.equal(getNextRun('twelve',now).time.toISOString(),'2026-10-06T18:00:00.000Z');
  assert.equal(getPreviousScheduledRun('twelve',now).time.toISOString(),'2026-10-04T22:00:00.000Z');
});
