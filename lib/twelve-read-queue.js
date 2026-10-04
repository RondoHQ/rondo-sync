/** Bounded independent browser reads; yield in date order for sequential writes. */
async function* orderedReads(items, readers, prepare) {
  const pending = [];
  let next = 0;
  const start = (index, reader) => Promise.resolve().then(() => prepare(items[index], reader)).then(value => ({ value, reader }), error => ({ error, reader }));
  for (const reader of readers) if (next < items.length) pending.push(start(next++, reader));
  try {
    while (pending.length) {
      const result = await pending.shift();
      if (result.error) throw result.error;
      if (next < items.length) pending.push(start(next++, result.reader));
      yield result.value;
    }
  } finally {
    // Observe every outstanding error and finish reads before closing Chromium.
    await Promise.all(pending);
  }
}
module.exports = { orderedReads };
