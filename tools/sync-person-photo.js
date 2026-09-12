require('dotenv/config');
const { requireProductionServer } = require('../lib/server-check');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { SportlinkSession } = require('../lib/sportlink-session');
const { SportlinkPhotoUpload } = require('../lib/sportlink-photo-upload');
const { runPhotoPilot } = require('../lib/photo-reverse-sync');

function parseArgs(args) {
  const options = { apply: false };
  const names = { '--person-id': 'personId', '--knvb-id': 'knvbId', '--revision': 'revision', '--expected-photo-hash': 'expectedPhotoHash' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { options.apply = true; continue; }
    if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Onbekende of onvolledige optie: ${args[i]}`);
    options[names[args[i]]] = args[++i];
  }
  options.personId = Number(options.personId);
  return options;
}

async function main() {
  requireProductionServer({ scriptName: 'De foto-proef' });
  const options = parseArgs(process.argv.slice(2));
  const session = new SportlinkSession();
  let adapter;
  const getAdapter = async () => adapter || (adapter = new SportlinkPhotoUpload(await session.getPage()));
  try {
    const result = await runPhotoPilot({
      ...options,
      api: async (endpoint, method, data) => (await rondoClubRequest(endpoint, method, data)).body,
      sportlink: {
        read: async (...args) => (await getAdapter()).read(...args),
        upload: async (...args) => (await getAdapter()).upload(...args)
      }
    });
    // Only identifiers and fingerprints, never image bytes, signed URLs or credentials.
    console.log(JSON.stringify(result, null, 2));
  } finally { await session.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs };
