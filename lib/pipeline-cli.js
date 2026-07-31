/**
 * Shared CLI finisher for pipeline entry points (`if (require.main === module)`).
 *
 * Centralizes the repo-wide process exit-code convention so every pipeline reports
 * the same thing to scripts/sync.sh (and therefore to the Healthchecks.io dead-man
 * switch + failure email):
 *
 *   0 = success   — clean run, nothing failed.
 *   2 = partial   — the pipeline ran, but some non-fatal per-item errors occurred
 *                   (e.g. one member's photo failed to download). sync.sh treats this
 *                   like 0 for the dead-man switch (check stays green) but still emails.
 *   1 = fatal     — the pipeline aborted (download/prepare failed, or an unexpected
 *                   throw). sync.sh pings <HEALTHCHECK_URL>/fail for this.
 *
 * Partial-vs-fatal is derived from the pipeline's resolved result: a non-`success`
 * result WITHOUT an `error` field is a partial (2); one carrying `error` — or a
 * rejected promise — is fatal (1). This matches how the pipelines build their return
 * values (happy path: `{ success, stats }`; abort/catch paths: `{ success: false,
 * stats, error }`).
 *
 * See scripts/sync.sh and CLAUDE.md ("Error Handling") for the consuming side.
 *
 * Usage in a pipeline's CLI block:
 *   runPipelineCli(runPeopleSync({ verbose, force }));
 *
 * @param {Promise<{success: boolean, error?: string}>} resultPromise
 * @returns {Promise<void>}
 */
function runPipelineCli(resultPromise) {
  return Promise.resolve(resultPromise)
    .then(result => {
      if (!result) {
        // No result object at all — treat as a fatal, unexpected outcome.
        process.exitCode = 1;
        return;
      }
      if (!result.success) {
        process.exitCode = result.error ? 1 : 2;
      }
    })
    .catch(err => {
      console.error('Error:', err && err.message ? err.message : String(err));
      process.exitCode = 1;
    });
}

module.exports = { runPipelineCli };
