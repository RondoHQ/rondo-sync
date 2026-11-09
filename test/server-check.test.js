const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { isProductionServer, requireProductionServer } = require('../lib/server-check');

test('srv1 is the production sync host', t => {
  t.mock.method(os, 'hostname', () => 'srv1-rondo-club');
  assert.equal(isProductionServer(), true);
  assert.equal(requireProductionServer(), true);
});

for (const hostname of ['rondo-sync', 'developer-laptop']) {
  test(`${hostname} cannot run production syncs`, t => {
    t.mock.method(os, 'hostname', () => hostname);
    t.mock.method(console, 'error', () => {});
    t.mock.method(process, 'exit', code => { throw new Error(`exit:${code}`); });
    assert.equal(isProductionServer(), false);
    assert.throws(() => requireProductionServer(), /exit:1/);
  });
}
