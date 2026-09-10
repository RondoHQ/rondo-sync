const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyFieldByType } = require('../lib/reverse-sync-sportlink');

function pageWithInputValue(value) {
  return {
    inputValue: async () => value
  };
}

test('accepts the four-letter Dutch September date rendered by Sportlink', async () => {
  await assert.doesNotReject(
    verifyFieldByType(
      pageWithInputValue('4 sept 2026'),
      { selector: 'input[name="inputRemarks8"]', type: 'text' },
      '2026-09-04',
      'datum_vog'
    )
  );
});

test('still rejects a genuinely different Dutch date', async () => {
  await assert.rejects(
    verifyFieldByType(
      pageWithInputValue('5 sept 2026'),
      { selector: 'input[name="inputRemarks8"]', type: 'text' },
      '2026-09-04',
      'datum_vog'
    ),
    /expected "2026-09-04", got "5 sept 2026"/
  );
});
