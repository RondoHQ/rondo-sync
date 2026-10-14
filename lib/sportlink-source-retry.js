const { isSportlinkAuthUrl } = require('./sportlink-auth');

/** Observe the SPA's token-refresh retry instead of accepting its initial 401. */
function waitForSourceResponse(page, matches, timeout = 15000) {
  let unauthorized = false;
  return page.waitForResponse(response => {
    if (!matches(response)) return false;
    if (response.status() === 401) {
      unauthorized = true;
      return false;
    }
    return true;
  }, { timeout }).then(response => ({ response }), error => ({
    error: unauthorized
      ? Object.assign(new Error('Sportlink source remained unauthorized'), { code: 'ERR_SPORTLINK_SESSION_EXPIRED' })
      : error
  }));
}

async function sessionExpired(page) {
  return isSportlinkAuthUrl(page.url()) || await page
    .getByText('Je bent uitgelogd omdat je een tijdje niet actief was.', { exact: true })
    .isVisible().catch(() => false);
}

/** Retry reads only, at most once; the caller retains ownership of the session. */
async function readSourceWithRecovery({ page, session, logger }, read) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const currentPage = session ? await session.getPage() : page;
    try {
      const result = await read(currentPage);
      if (await sessionExpired(currentPage)) {
        throw Object.assign(new Error('Sportlink session expired while reading source'), { code: 'ERR_SPORTLINK_SESSION_EXPIRED' });
      }
      return result;
    } catch (error) {
      if (error.code === 'ERR_SPORTLINK_MEMBER_NOT_FOUND' || attempt === 1) throw error;
      const expired = error.code === 'ERR_SPORTLINK_SESSION_EXPIRED' || await sessionExpired(currentPage);
      const retryable = expired || error.name === 'TimeoutError'
        || ['ERR_SPORTLINK_SOURCE_INCOMPLETE', 'ERR_MEMBER_TEAMS_PANEL_NOT_LOADED'].includes(error.code);
      if (!retryable || (expired && !session)) throw error;
      logger?.verbose('Sportlink source unavailable; retrying the read once' + (expired ? ' after session renewal' : ''));
      if (expired) await session.relogin();
    }
  }
}

module.exports = { waitForSourceResponse, readSourceWithRecovery };
