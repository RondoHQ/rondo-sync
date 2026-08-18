const fs = require('fs');

/**
 * Wait briefly for a detached child to fail before reporting a successful launch.
 * Long-running children resolve with null after the observation window.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null, error?: Error}|null>}
 */
function waitForEarlyExit(child, timeoutMs = 500) {
  return new Promise((resolve) => {
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(result);
    };
    const onError = (error) => finish({ code: null, signal: null, error });
    const onExit = (code, signal) => finish({ code, signal });

    child.once('error', onError);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Return the final non-empty launch-log lines as a concise dashboard message.
 *
 * @param {string} logPath
 * @param {string} fallback
 * @returns {string}
 */
function readLaunchFailure(logPath, fallback) {
  try {
    const lines = fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(-2).join(' ').slice(0, 600) || fallback;
  } catch {
    return fallback;
  }
}

module.exports = { waitForEarlyExit, readLaunchFailure };
