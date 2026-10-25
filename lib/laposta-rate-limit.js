const RATE_LIMIT_DELAY = 2500;
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60_000;

function retryAfterMs(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  // Accept HTTP dates, but do not let Date.parse interpret malformed numbers.
  if (!/^[A-Za-z]{3}, /.test(text)) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

/**
 * One queue per process, shared by all lists and steps using the client.
 * Only an explicit HTTP 429 is safe to replay; ambiguous writes are not retried.
 */
function createRateLimitedRequest(request, {
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  let queue = Promise.resolve();
  let nextAllowedAt = 0;
  let cooldownError;

  async function run(config) {
    for (let attempt = 0; ; attempt += 1) {
      // Recheck after sleeping so an early timer cannot violate Retry-After.
      while (nextAllowedAt > now()) {
        const wait = nextAllowedAt - now();
        // Never shorten a long provider cooldown just to fit our wait budget.
        if (wait > MAX_WAIT_MS) throw cooldownError;
        await sleep(wait);
      }
      nextAllowedAt = now() + RATE_LIMIT_DELAY;
      try {
        return await request(config);
      } catch (error) {
        if (error.status !== 429) throw error;
        const delay = retryAfterMs(error.retryAfter, now()) ?? RATE_LIMIT_DELAY * (2 ** attempt);
        nextAllowedAt = Math.max(nextAllowedAt, now() + delay);
        cooldownError = error;
        // Keep the cooldown for the next queued call even when retries run out.
        if (attempt >= MAX_RETRIES || nextAllowedAt - now() > MAX_WAIT_MS) throw error;
      }
    }
  }

  return config => {
    const result = queue.then(() => run(config));
    queue = result.catch(() => {});
    return result;
  };
}

module.exports = { createRateLimitedRequest, RATE_LIMIT_DELAY };
