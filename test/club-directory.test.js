const test = require('node:test');
const assert = require('node:assert/strict');
const fastify = require('fastify');
const { ClubDirectory, DirectoryError, clubs, contacts } = require('../lib/club-directory');
const { registerClubDirectoryRoutes } = require('../lib/club-directory-routes');

const rawClub = { ClubIdentifier: 'TEST001', ClubName: 'Testvereniging', RegionCode: 'Oost', StreetName: 'Sportlaan', AddressNumber: 2, AddressNumberAppendix: 'A', ZipCode: '1234 AB', City: 'Teststad', Telephone: null, Email: 'info@example.test' };
const rawContact = { PersonId: 'PERSON1', FullName: 'Test Contact', FunctionDescription: 'Wedstrijdsecretaris algemeen', ClubName: 'Testvereniging', RoleDescription: 'Bond', Telephone: '', Mobile: '0612345678', Email: 'secretaris@example.test' };
const fixedNow = () => new Date('2026-10-30T15:00:00Z');

test('normalizes JSON fields, retains all function rows and does not invent missing contact details', () => {
  const club = clubs({ Items: [rawClub] })[0];
  assert.equal(club.address, 'Sportlaan 2A'); assert.equal(club.phone, '');
  const rows = contacts({ Items: [rawContact, { ...rawContact, FunctionDescription: 'Secretaris' }] }, club);
  assert.equal(rows.length, 2); assert.equal(rows[1].function, 'Secretaris');
  assert.deepEqual(Object.keys(rows[0]), ['id', 'name', 'function', 'phone', 'mobile', 'email', 'source']);
});

test('rejects incomplete, duplicate and cross-club source responses; explicit empty results are valid', () => {
  for (const body of [{}, { Items: null }, { Items: [null] }, { Items: [{ ClubName: 'No code' }] }, { Items: [rawClub, rawClub] }]) assert.throws(() => clubs(body), DirectoryError);
  assert.deepEqual(clubs({ Items: [] }), []);
  assert.throws(() => contacts({ Items: [{ ...rawContact, ClubName: 'Andere club' }] }, { name: rawClub.ClubName }), DirectoryError);
  assert.throws(() => contacts({ Items: [{ ...rawContact, FullName: null }] }, { name: rawClub.ClubName }), DirectoryError);
});

test('search uses nationwide JSON parameters, supports place search and reports truncation', async () => {
  const directory = new ClubDirectory({ now: fixedNow });
  const calls = [];
  directory.read = async (endpoint, params) => { calls.push({ endpoint, params }); return { Items: Array.from({ length: 101 }, (_, n) => ({ ...rawClub, ClubIdentifier: 'TEST' + String(n).padStart(3, '0') })) }; };
  try {
    const result = await directory.search('  Teststad ', 'city');
    assert.equal(result.clubs.length, 100); assert.equal(result.total, 101); assert.equal(result.truncated, true);
    assert.equal(result.fetched_at, fixedNow().toISOString());
    assert.equal(calls[0].endpoint, 'ClubSearchList');
    assert.equal(calls[0].params.DistrictId, '-1'); assert.equal(calls[0].params.CityName, 'Teststad'); assert.equal(calls[0].params.OrganizationId, ''); assert.equal(calls[0].params.ClubName, '');
    for (const query of ['', 'a', 'x'.repeat(81)]) await assert.rejects(directory.search(query), { statusCode: 400 });
    await assert.rejects(directory.search('club', 'unsafe'), { statusCode: 400 });
  } finally { await directory.close(); }
});

test('detail verifies exact source club identity before requesting contacts', async () => {
  const directory = new ClubDirectory({ now: fixedNow }); const calls = [];
  directory.read = async (endpoint, params) => { calls.push({ endpoint, params }); return { Items: endpoint === 'ClubSearchList' ? [rawClub] : [rawContact] }; };
  try {
    const result = await directory.detail('TEST001');
    assert.equal(result.contacts[0].function, 'Wedstrijdsecretaris algemeen');
    assert.equal(calls[0].params.ClubName, 'TEST001'); assert.equal(calls[0].params.OrganizationId, 'TEST001');
    assert.equal(calls[1].params.OrganizationId, 'TEST001'); assert.equal(calls[1].params.OrganizationName, 'TEST001 - Testvereniging'); assert.equal(calls[1].params.DistrictId, '-1');
    await assert.rejects(directory.detail('../evil'), { statusCode: 400 });
    directory.read = async () => ({ Items: [{ ...rawClub, ClubIdentifier: 'WRONG01' }] });
    await assert.rejects(directory.detail('TEST001'), { statusCode: 502 });
    directory.read = async () => ({ Items: [] });
    await assert.rejects(directory.detail('TEST001'), { statusCode: 404 });
  } finally { await directory.close(); }
});

test('simultaneous uncached lookups are bounded and failures do not expose transport secrets', async () => {
  const directory = new ClubDirectory(); let finish;
  const first = directory.run(() => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(directory.run(async () => 'second'), { statusCode: 429 });
  finish('first'); assert.equal(await first, 'first');
  await assert.rejects(directory.run(async () => { throw new Error('https://secret.example/?token=private'); }), error => error.statusCode === 502 && !error.message.includes('private'));
  await directory.close();
});

test('bootstrap uses only the SPA JSON request, allowlists auth headers, and never reads HTML tables', async () => {
  let target;
  const sourceResponse = { url: () => 'https://club.sportlink.com/navajo/entity/common/clubweb/maintenance/addressbook/SearchClubFilter', status: () => 200, request: () => ({ method: () => 'GET', allHeaders: async () => ({ authorization: 'private', ':authority': 'ignored', cookie: 'ignored', 'x-navajo-entity': 'entity', baggage: 'ignored' }) }) };
  const page = { waitForResponse: async predicate => { assert.ok(predicate(sourceResponse)); return sourceResponse; }, goto: async url => { target = url; } };
  const directory = new ClubDirectory({ sessionFactory: () => ({ getPage: async () => page, close: async () => {} }) });
  await directory.bootstrap(); assert.equal(target, 'https://club.sportlink.com/communication/address-book/clubs');
  assert.deepEqual(directory.headers, { authorization: 'private', 'x-navajo-entity': 'entity' }); await directory.close();
});

test('JSON requests stay on the fixed host, do not redirect, and retry authentication once only', async () => {
  const directory = new ClubDirectory(); let logins = 0; let calls = 0;
  directory.session = { relogin: async () => { logins++; }, close: async () => {} };
  directory.bootstrap = async () => { directory.headers = { authorization: 'private' }; };
  directory.page = { request: { get: async (url, options) => { const u = new URL(url); assert.equal(u.origin, 'https://club.sportlink.com'); assert.equal(options.maxRedirects, 0); assert.equal(u.searchParams.get('ClubName'), 'a&evil=true'); calls++; return { status: () => calls === 1 ? 401 : 200, ok: () => calls > 1, json: async () => ({ Items: [] }) }; } } };
  assert.deepEqual(await directory.read('ClubSearchList', { ClubName: 'a&evil=true' }), { Items: [] }); assert.equal(logins, 1); assert.equal(calls, 2);
  await assert.rejects(directory.read('UserInfo', {}), { statusCode: 400 });
  directory.page.request.get = async () => ({ status: () => 403, ok: () => false });
  await assert.rejects(directory.read('ClubSearchList', {}), { statusCode: 502 }); assert.equal(logins, 1); await directory.close();
});

test('HTTP routes enforce the existing API key and redact unexpected errors', async () => {
  const previous = process.env.SYNC_API_KEY; process.env.SYNC_API_KEY = 'test-directory-key';
  const app = fastify(); let calls = 0;
  registerClubDirectoryRoutes(app, { search: async () => { calls++; return { clubs: [] }; }, detail: async () => { const e = new Error('private token'); e.statusCode = 500; throw e; }, close: async () => {} });
  try {
    assert.equal((await app.inject('/api/club-directory?search=Test')).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/club-directory?search=Test', headers: { 'x-sync-api-key': 'wrong' } })).statusCode, 403);
    assert.equal(calls, 0);
    const good = await app.inject({ url: '/api/club-directory?search=Test', headers: { 'x-sync-api-key': 'test-directory-key' } });
    assert.equal(good.statusCode, 200); assert.equal(good.headers['cache-control'], 'private, no-store');
    const bad = await app.inject({ url: '/api/club-directory/TEST001', headers: { 'x-sync-api-key': 'test-directory-key' } });
    assert.equal(bad.statusCode, 502); assert.ok(!bad.body.includes('private token'));
  } finally { await app.close(); if (previous === undefined) delete process.env.SYNC_API_KEY; else process.env.SYNC_API_KEY = previous; }
});
