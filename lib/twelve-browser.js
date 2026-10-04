/** Twelve's normal login and CSV export UI. No undocumented API calls. */
const { chromium } = require('playwright');
const { dateOnly, nextDate, period } = require('./twelve-export');

const ORIGIN = 'https://admin.twelve.eu';
const EXPORTS = [
  { kind: 'transactions', button: 'Export transactions to csv', filename: 'transactions.csv' },
  { kind: 'products', button: 'Export sell to csv', filename: 'products.csv' },
  { kind: 'raw', button: 'Export this list to csv', filename: 'raw.zip' }
];

class TwelveBrowser {
  constructor({ username, password, clientId, launch = options => chromium.launch(options) }) {
    if (!username || !password || !/^\d+$/.test(clientId || '')) throw new Error('Set TWELVE_USERNAME, TWELVE_PASSWORD and TWELVE_CLIENT_ID');
    this.username = username; this.password = password; this.clientId = clientId;
    this.launch = launch;
    this.browser = null;
    this.page = null;
  }

  async open() {
    if (this.page) return this.page;
    try {
      this.browser = await this.launch({ headless: true });
      const context = await this.browser.newContext({ acceptDownloads: true, locale: 'en-US', timezoneId: 'Europe/Amsterdam' });
      this.page = await context.newPage();
      this.page.setDefaultTimeout(30000);
      this.page.setDefaultNavigationTimeout(60000);
      await this.page.goto(`${ORIGIN}/scripts/login.aspx`, { waitUntil: 'domcontentloaded' });
      await this.page.locator('#LoginPage_LoginName').fill(this.username);
      await this.page.locator('#LoginPage_Password').fill(this.password);
      await this.page.locator('select#language').selectOption('en-US');
      await this.page.locator('#button_text_td_login_button').click();
      try {
        await this.page.waitForURL(url => url.origin === ORIGIN && !url.pathname.toLowerCase().includes('login'), { timeout: 30000 });
      } catch {
        throw new Error('Twelve login did not complete; check credentials or complete any additional authentication manually');
      }
      await this.reportPage();
      return this.page;
    } catch (error) {
      await this.close();
      // Never echo locator call logs: password fill errors can contain its value.
      if (error.message.startsWith('Twelve login did not complete')) throw error;
      throw new Error('Twelve browser login failed; no files were accepted');
    }
  }

  async reportPage() {
    await this.page.goto(`${ORIGIN}/scripts/admin/report_edit.aspx?strTab=rbsd&clt_id=${this.clientId}`, { waitUntil: 'domcontentloaded' });
    const url = new URL(this.page.url());
    if (url.origin !== ORIGIN || url.searchParams.get('clt_id') !== this.clientId || url.pathname !== '/scripts/admin/report_edit.aspx') {
      throw new Error('Twelve session expired or the requested club is unavailable');
    }
    await this.page.locator('#report_date_begin_d').waitFor({ state: 'visible' });
  }

  async setPeriod(from, to) {
    period(from, to);
    await this.reportPage();
    for (const [side, date] of [['begin', from], ['end', to]]) {
      const [y, m, d] = date.split('-').map(Number);
      // Set day 1 before changing month/year, avoiding a transient invalid date.
      await this.page.locator(`#report_date_${side}_d`).selectOption('1');
      for (const [part, value] of [['y', y], ['m', m], ['d', d]]) {
        await this.page.locator(`#report_date_${side}_${part}`).selectOption(String(value));
      }
      for (const [part, value] of [['h', 6], ['n', 0], ['s', 0]]) {
        await this.page.locator(`select[name="report_time_${side}_${part}"]`).selectOption(String(value));
      }
    }
    // Server-rendered form navigation, verified against the live Search control.
    await Promise.all([
      this.page.waitForEvent('load', { timeout: 60000 }),
      this.page.getByRole('cell', { name: 'Search', exact: true }).last().click()
    ]);
    for (const [side, date] of [['begin', from], ['end', to]]) {
      const [y, m, d] = date.split('-').map(Number);
      for (const [part, value] of [['y', y], ['m', m], ['d', d]]) {
        if (await this.page.locator(`#report_date_${side}_${part}`).inputValue() !== String(value)) throw new Error('Twelve did not retain the requested date filter');
      }
      for (const [part, value] of [['h', '6'], ['n', '0'], ['s', '0']]) {
        if (await this.page.locator(`select[name="report_time_${side}_${part}"]`).inputValue() !== value) throw new Error('Twelve did not retain the 06:00 business-day boundary');
      }
    }
    const text = await this.page.locator('body').innerText();
    const match = /There are (\d+) records/.exec(text);
    if (!match) throw new Error('Twelve did not confirm a raw record count');
    return Number(match[1]);
  }

  async download(exportType, destination) {
    const item = EXPORTS.find(e => e.kind === exportType);
    if (!item) throw new Error('Unknown export');
    // Validate downloaded schema instead of changing persistent column settings.
    const [download] = await Promise.all([
      this.page.waitForEvent('download', { timeout: 120000 }),
      this.page.getByRole('cell', { name: item.button, exact: true }).last().click()
    ]);
    await download.saveAs(destination);
    if (await download.failure()) throw new Error(`Twelve ${exportType} download failed`);
  }

  async close() {
    const browser = this.browser;
    this.browser = null; this.page = null;
    if (browser) await browser.close();
  }
}

function chunks(from, to, size = 31) {
  period(from, to);
  if (!Number.isInteger(size) || size < 1 || size > 31) throw new Error('Chunk size must be 1–31 days');
  const result = [];
  for (let start = dateOnly(from); start < to;) {
    const end = nextDate(start, size) < to ? nextDate(start, size) : to;
    result.push({ from: start, to: end }); start = end;
  }
  return result;
}

module.exports = { TwelveBrowser, EXPORTS, chunks };
