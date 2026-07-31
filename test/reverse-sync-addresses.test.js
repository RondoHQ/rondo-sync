const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SPORTLINK_FIELD_MAP,
  clickSaveButton,
  groupChangesByMemberAndPage
} = require('../lib/reverse-sync-sportlink');

test('groups address changes on the address section of the general page', () => {
  const grouped = groupChangesByMemberAndPage([
    { knvb_id: 'TEST001', field_name: 'street_name', new_value: 'Rietdekker' },
    { knvb_id: 'TEST001', field_name: 'house_number', new_value: '31' },
    { knvb_id: 'TEST001', field_name: 'postal_code', new_value: '6603 JV' }
  ]);

  assert.deepEqual(
    grouped.get('TEST001').address.map(change => change.field_name),
    ['street_name', 'house_number', 'postal_code']
  );
  assert.equal(SPORTLINK_FIELD_MAP.street_name.selector, 'input[name="StreetName"]');
  assert.equal(SPORTLINK_FIELD_MAP.postal_code.selector, 'input[name="ZipCode"]');
});

test('waits for Sportlink address lookup to restore the save control', async () => {
  const calls = [];
  let actionRowRestored = false;

  const saveButton = {
    count: async () => {
      calls.push('count');
      return actionRowRestored ? 1 : 0;
    },
    waitFor: async options => {
      calls.push(['button-wait', options]);
    },
    click: async () => {
      calls.push('click');
    }
  };

  const page = {
    waitForSelector: async (selector, options) => {
      calls.push(['form-wait', selector, options]);
      actionRowRestored = true;
    },
    locator: selector => {
      calls.push(['locator', selector]);
      return { first: () => saveButton };
    }
  };

  const selector = await clickSaveButton(page);

  assert.equal(selector, 'button:has-text("Sla op")');
  assert.equal(calls[0][0], 'form-wait');
  assert.match(calls[0][1], /Sla op/);
  assert.deepEqual(calls[0][2], { state: 'visible', timeout: 8000 });
  assert.equal(calls.at(-1), 'click');
});

test('never falls back to an arbitrary submit button', async () => {
  const attemptedSelectors = [];
  const page = {
    waitForSelector: async () => {
      throw new Error('save controls did not return');
    },
    locator: selector => {
      attemptedSelectors.push(selector);
      return {
        first: () => ({ count: async () => 0 })
      };
    }
  };

  await assert.rejects(
    clickSaveButton(page),
    /Could not find save button/
  );
  assert.equal(attemptedSelectors.includes('button[type="submit"]'), false);
});
