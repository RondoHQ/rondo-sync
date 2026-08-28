'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeFreshMemberData } = require('../pipelines/sync-individual');

test('individual refresh preserves fields omitted by the partial general response', () => {
  const merged = mergeFreshMemberData(
    {
      PublicPersonId: 'FPJX869',
      FirstName: 'Bas',
      LastName: 'Elbers',
      AgeClassDescription: 'Senioren',
      KernelGameActivities: 'Veld - Algemeen'
    },
    {
      PublicPersonId: 'FPJX869',
      FirstName: 'Bas',
      LastName: 'Elbers',
      Email: 'fresh@example.test'
    }
  );

  assert.equal(merged.Email, 'fresh@example.test');
  assert.equal(merged.AgeClassDescription, 'Senioren');
  assert.equal(merged.KernelGameActivities, 'Veld - Algemeen');
});

test('fresh general values override matching values from the snapshot', () => {
  const merged = mergeFreshMemberData(
    { PublicPersonId: 'FPJX869', Email: 'old@example.test' },
    { PublicPersonId: 'FPJX869', Email: null }
  );

  assert.equal(merged.Email, null);
});
