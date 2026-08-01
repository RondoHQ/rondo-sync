'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toNumberOrNull, buildPerYearFields } = require('../steps/sync-nikki-to-rondo-club');

// Regression: WordPress REST rejects empty-string values on number-typed native field
// fields with `rest_invalid_type`. On 2026-05-28 that rejection caused
// 2,600+ retries from a single People sync, ballooning logs to 302k lines.
test('toNumberOrNull coerces empty/junk to null and preserves numbers', () => {
  // empty / whitespace / nullish -> null
  assert.equal(toNumberOrNull(''), null);
  assert.equal(toNumberOrNull('   '), null);
  assert.equal(toNumberOrNull(null), null);
  assert.equal(toNumberOrNull(undefined), null);

  // non-numeric -> null
  assert.equal(toNumberOrNull('abc'), null);
  assert.equal(toNumberOrNull(NaN), null);
  assert.equal(toNumberOrNull(Infinity), null);
  assert.equal(toNumberOrNull(-Infinity), null);

  // numeric strings -> number
  assert.equal(toNumberOrNull('100'), 100);
  assert.equal(toNumberOrNull(' 12.5 '), 12.5);
  assert.equal(toNumberOrNull('-7'), -7);

  // numbers pass through
  assert.equal(toNumberOrNull(100), 100);
  assert.equal(toNumberOrNull(0), 0);

  // zero must survive both as number and string (it's a meaningful saldo)
  assert.equal(toNumberOrNull('0'), 0);
});

test('buildPerYearFields never emits empty strings for _total/_saldo', () => {
  const fields = buildPerYearFields([
    { year: 2025, hoofdsom: 250, saldo: 0, status: 'OPEN' },
    { year: 2024, hoofdsom: '', saldo: '', status: '' },           // Excel empties
    { year: 2023, hoofdsom: '1.50', saldo: null, status: null },   // string-coerce + null
    { year: 2022, hoofdsom: undefined, saldo: 'junk', status: 'PAID' }
  ]);

  assert.equal(fields._nikki_2025_total, 250);
  assert.equal(fields._nikki_2025_saldo, 0);
  assert.equal(fields._nikki_2025_status, 'OPEN');

  assert.equal(fields._nikki_2024_total, null);
  assert.equal(fields._nikki_2024_saldo, null);
  assert.equal(fields._nikki_2024_status, null);

  assert.equal(fields._nikki_2023_total, 1.5);
  assert.equal(fields._nikki_2023_saldo, null);
  assert.equal(fields._nikki_2023_status, null);

  assert.equal(fields._nikki_2022_total, null);
  assert.equal(fields._nikki_2022_saldo, null);
  assert.equal(fields._nikki_2022_status, 'PAID');

  // No value should ever be the empty string — that's what triggered the
  // rest_invalid_type retry storm against `fields[_nikki_YYYY_saldo]`.
  for (const v of Object.values(fields)) {
    assert.notEqual(v, '');
  }
});
