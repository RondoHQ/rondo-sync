const test = require('node:test');
const assert = require('node:assert/strict');
const { selectInactiveMemberStatus } = require('../steps/download-inactive-members');

const dropdown = '#dropdownMultiMemberStatus_styled';
const option = status => `input[name="DROPDOWN_MULTISELECT_OPTION_${status}"]`;

function createPage({ modern, checked = {} }) {
  const calls = [];
  return {
    calls,
    waitForSelector: async (selector, options) => calls.push(['waitForSelector', selector, options]),
    click: async selector => calls.push(['click', selector]),
    $: async selector => selector === dropdown && modern ? {} : null,
    isChecked: async selector => Boolean(checked[selector]),
    check: async (selector, options) => calls.push(['check', selector, options]),
    uncheck: async (selector, options) => calls.push(['uncheck', selector, options])
  };
}

test('selects only Oud lid in the current Sportlink status dropdown', async () => {
  const page = createPage({
    modern: true,
    checked: {
      [option('ACTIVE')]: true,
      [option('PROCESSING')]: true,
      [option('ELIGABLE_FOR_REMOVE')]: true,
      [option('REJECTED')]: true,
      [option('ASPIRANT')]: true
    }
  });

  assert.equal(await selectInactiveMemberStatus(page), 'dropdown');
  assert.deepEqual(page.calls, [
    ['waitForSelector', '#btnShowMore:not([disabled])', { timeout: 20000 }],
    ['click', '#btnShowMore'],
    ['waitForSelector', '#dropdownMultiMemberStatus_styled, #chipStatusACTIVE', { timeout: 20000 }],
    ['click', '#dropdownMultiMemberStatus_styled'],
    ['waitForSelector', option('INACTIVE'), { timeout: 20000 }],
    ['uncheck', option('ACTIVE'), { force: true }],
    ['check', option('INACTIVE'), { force: true }],
    ['uncheck', option('PROCESSING'), { force: true }],
    ['uncheck', option('ELIGABLE_FOR_REMOVE'), { force: true }],
    ['uncheck', option('REJECTED'), { force: true }],
    ['uncheck', option('ASPIRANT'), { force: true }],
    ['click', '#btnApplydropdownMultiMemberStatus']
  ]);
});

test('retains support for the legacy Sportlink status chips', async () => {
  const page = createPage({ modern: false });

  assert.equal(await selectInactiveMemberStatus(page), 'chips');
  assert.deepEqual(page.calls, [
    ['waitForSelector', '#btnShowMore:not([disabled])', { timeout: 20000 }],
    ['click', '#btnShowMore'],
    ['waitForSelector', '#dropdownMultiMemberStatus_styled, #chipStatusACTIVE', { timeout: 20000 }],
    ['click', '#chipStatusACTIVE'],
    ['click', '#chipStatusELIGABLE_FOR_REMOVE'],
    ['click', '#chipStatusINACTIVE']
  ]);
});
