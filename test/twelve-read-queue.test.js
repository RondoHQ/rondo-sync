const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orderedReads } = require('../lib/twelve-read-queue');
test('reads are bounded per browser page and writes stay ordered despite later reads finishing first', async () => {
  const busy = new Set(), done = [];
  let peak = 0;
  const results = [];
  for await (const value of orderedReads([0, 1, 2, 3, 4], ['a', 'b'], async (i, page) => {
    assert.equal(busy.has(page), false); busy.add(page); peak = Math.max(peak, busy.size);
    await new Promise(resolve => setTimeout(resolve, i === 0 ? 20 : 1));
    busy.delete(page); done.push(i); return i;
  })) results.push(value);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(done[0], 1); assert.equal(peak, 2); assert.equal(busy.size, 0);
});
test('failed read stops writes and waits for the other in-flight reader to settle', async () => {
  let finished = false;
  await assert.rejects(async () => { for await (const _ of orderedReads([0, 1, 2], ['a', 'b'], async i => {
    if (i === 0) throw new Error('source changed');
    await new Promise(resolve => setTimeout(resolve, 5)); finished = true; return i;
  })) assert.fail('must not write'); }, /source changed/);
  assert.equal(finished, true);
});
