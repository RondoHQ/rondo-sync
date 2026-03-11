#!/usr/bin/env node
/**
 * Inspect Sportlink address form fields on the /general page.
 * Navigates to a member, enters edit mode on the address section,
 * and logs all input/select field names and their current values.
 *
 * Usage: node tools/inspect-sportlink-address-fields.js [knvbId]
 */
require('dotenv/config');

const { chromium } = require('playwright');
const { loginToSportlink } = require('../lib/sportlink-login');
const { openDb } = require('../lib/rondo-club-db');

async function run() {
  const knvbId = process.argv[2];

  if (!knvbId) {
    // Pick a random member from the database
    const db = openDb();
    const member = db.prepare(`
      SELECT knvb_id FROM rondo_club_members
      WHERE knvb_id IS NOT NULL
      LIMIT 1
    `).get();
    db.close();

    if (!member) {
      console.error('No members found in database. Pass a KNVB ID as argument.');
      process.exit(1);
    }

    console.log(`No KNVB ID provided, using: ${member.knvb_id}`);
    return inspectMember(member.knvb_id);
  }

  return inspectMember(knvbId);
}

async function inspectMember(knvbId) {
  const username = process.env.SPORTLINK_USERNAME;
  const password = process.env.SPORTLINK_PASSWORD;
  const otpSecret = process.env.SPORTLINK_OTP_SECRET;

  if (!username || !password) {
    console.error('Missing SPORTLINK_USERNAME or SPORTLINK_PASSWORD in .env');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  const page = await context.newPage();

  try {
    // Login
    console.log('Logging in to Sportlink...');
    await loginToSportlink(page, {
      logger: { log: console.log, verbose: console.log, error: console.error },
      credentials: { username, password, otpSecret }
    });

    // Navigate to member general page
    const url = `https://club.sportlink.com/member/member-details/${knvbId}/general`;
    console.log(`\nNavigating to: ${url}`);

    // Intercept MemberAddresses API response
    const addressPromise = page.waitForResponse(
      resp => resp.url().includes('/member/persondata/MemberAddresses?'),
      { timeout: 15000 }
    ).catch(() => null);

    await page.goto(url, { waitUntil: 'networkidle' });

    // Log the API response
    const addressResponse = await addressPromise;
    if (addressResponse && addressResponse.ok()) {
      const data = await addressResponse.json();
      console.log('\n=== MemberAddresses API Response ===');
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log('\nNo MemberAddresses API response captured');
    }

    // Find ALL Wijzig (Edit) buttons on the page
    const wijzigButtons = page.locator('button:has-text("Wijzig")');
    const buttonCount = await wijzigButtons.count();
    console.log(`\n=== Found ${buttonCount} "Wijzig" buttons ===`);

    for (let i = 0; i < buttonCount; i++) {
      const btn = wijzigButtons.nth(i);
      const text = await btn.textContent();
      const parent = await btn.evaluate(el => {
        // Walk up to find section header
        let node = el.parentElement;
        for (let j = 0; j < 10 && node; j++) {
          const h = node.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="header"]');
          if (h) return h.textContent.trim();
          node = node.parentElement;
        }
        return '(unknown section)';
      });
      console.log(`  Button ${i}: "${text.trim()}" in section: "${parent}"`);
    }

    // Try clicking each Wijzig button and inspecting the form fields
    for (let i = 0; i < buttonCount; i++) {
      console.log(`\n=== Clicking Wijzig button ${i} ===`);

      // Reload the page fresh before each attempt
      if (i > 0) {
        await page.goto(url, { waitUntil: 'networkidle' });
      }

      const btn = wijzigButtons.nth(i);
      try {
        await btn.waitFor({ state: 'visible', timeout: 5000 });
        await btn.click();
        await page.waitForLoadState('networkidle');

        // Wait a moment for form to render
        await page.waitForTimeout(1000);

        // Collect all input fields
        const fields = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input, select, textarea');
          return Array.from(inputs).map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.name || '',
            id: el.id || '',
            value: el.value || '',
            placeholder: el.placeholder || '',
            disabled: el.disabled,
            // Get nearby label
            label: (() => {
              if (el.id) {
                const lbl = document.querySelector(`label[for="${el.id}"]`);
                if (lbl) return lbl.textContent.trim();
              }
              const parent = el.closest('.form-group, .field, [class*="field"]');
              if (parent) {
                const lbl = parent.querySelector('label');
                if (lbl) return lbl.textContent.trim();
              }
              return '';
            })()
          }));
        });

        // Filter to enabled, named fields
        const editableFields = fields.filter(f => f.name && !f.disabled);
        console.log(`  Found ${editableFields.length} editable named fields:`);
        for (const f of editableFields) {
          console.log(`    ${f.tag}[name="${f.name}"] type=${f.type} value="${f.value}" label="${f.label}" placeholder="${f.placeholder}"`);
        }

        // Also look for fields that might be address-related even without name
        const addressKeywords = ['street', 'straat', 'address', 'adres', 'house', 'huis', 'zip', 'post', 'city', 'plaats', 'country', 'land'];
        const possibleAddressFields = fields.filter(f => {
          const searchStr = `${f.name} ${f.id} ${f.label} ${f.placeholder}`.toLowerCase();
          return addressKeywords.some(kw => searchStr.includes(kw));
        });

        if (possibleAddressFields.length > 0) {
          console.log(`\n  ADDRESS-RELATED FIELDS:`);
          for (const f of possibleAddressFields) {
            console.log(`    ${f.tag}[name="${f.name}"] id="${f.id}" value="${f.value}" label="${f.label}" disabled=${f.disabled}`);
          }
        }

        // Click cancel/annuleren to exit edit mode
        const cancelBtn = page.locator('button:has-text("Annuleer"), button:has-text("Cancel")').first();
        if (await cancelBtn.count() > 0) {
          await cancelBtn.click();
          await page.waitForLoadState('networkidle');
        }

      } catch (err) {
        console.log(`  Error: ${err.message}`);
      }
    }

  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
