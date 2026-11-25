const { requireProductionServer } = require('../lib/server-check');
const { syncStaleLapostaIdentities } = require('../steps/sync-stale-laposta-identities');

if (require.main === module) {
  requireProductionServer({ scriptName: 'Stale Laposta identity cleanup' });
  const args = process.argv.slice(2);
  const emailIndex = args.indexOf('--email');
  const email = emailIndex >= 0 ? args[emailIndex + 1] : undefined;
  if (emailIndex >= 0 && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('--email requires one valid address');
  }
  syncStaleLapostaIdentities({ apply: args.includes('--apply'), email }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
