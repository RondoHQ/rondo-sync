const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('commissie pagination stops at the final partial page without probing past it', async () => {
  const requests = [];
  const originalLoad = Module._load;

  Module._load = function(request, parent, isMain) {
    if (request === '../lib/rondo-club-client' && parent?.filename.endsWith('submit-rondo-club-commissies.js')) {
      return {
        rondoClubRequest: async (endpoint) => {
          requests.push(endpoint);
          return {
            body: [{ id: 10, title: { rendered: 'Bestuur' } }],
            headers: { 'x-wp-totalpages': '1' }
          };
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const modulePath = require.resolve('../steps/submit-rondo-club-commissies');
  delete require.cache[modulePath];

  try {
    const { fetchAllWordPressCommissies } = require(modulePath);
    const commissies = await fetchAllWordPressCommissies({});

    assert.deepEqual(commissies, [{ id: 10, title: 'Bestuur' }]);
    assert.deepEqual(requests, ['wp/v2/commissies?per_page=100&page=1']);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
});
