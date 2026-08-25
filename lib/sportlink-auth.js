/**
 * Return whether a URL points at Sportlink's identity provider.
 *
 * Sportlink has used both a legacy `/auth/realms/` path and the current
 * `idm.sportlink.com/realms/` host. Keep this check centralized so session
 * probes and navigation recovery cannot drift apart again.
 *
 * @param {string} value URL to inspect.
 * @returns {boolean}
 */
function isSportlinkAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'idm.sportlink.com'
      || url.pathname.includes('/auth/realms/');
  } catch {
    return false;
  }
}

module.exports = { isSportlinkAuthUrl };
