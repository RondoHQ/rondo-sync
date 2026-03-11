#!/usr/bin/env node
/**
 * Inspect Sportlink address form fields on the /general page.
 * Navigates to a member, finds the address edit UI,
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
    // Pick a living member from the database
    const db = openDb();
    const member = db.prepare(`
      SELECT m.knvb_id FROM rondo_club_members m
      WHERE m.knvb_id IS NOT NULL
      AND m.rondo_club_id IS NOT NULL
      ORDER BY RANDOM()
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

    // Dump ALL clickable elements (buttons, links, icons) on the page
    console.log('\n=== All clickable elements ===');
    const clickables = await page.evaluate(() => {
      const els = document.querySelectorAll('button, a, [role="button"], [class*="edit"], [class*="pencil"], svg[class*="edit"]');
      return Array.from(els).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim().substring(0, 80) || '',
        href: el.getAttribute('href') || '',
        className: el.className?.toString().substring(0, 100) || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        dataAction: el.getAttribute('data-action') || '',
        id: el.id || ''
      }));
    });

    for (const el of clickables) {
      if (!el.text && !el.href && !el.ariaLabel && !el.title) continue;
      console.log(`  <${el.tag}> text="${el.text}" href="${el.href}" class="${el.className}" aria="${el.ariaLabel}" title="${el.title}" id="${el.id}"`);
    }

    // Find ALL "Wijzig" buttons and any address-related clickable
    const wijzigButtons = page.locator('button:has-text("Wijzig")');
    const buttonCount = await wijzigButtons.count();
    console.log(`\n=== Found ${buttonCount} "Wijzig" buttons ===`);

    for (let i = 0; i < buttonCount; i++) {
      const btn = wijzigButtons.nth(i);
      const text = await btn.textContent();
      // Get bounding box for position context
      const box = await btn.boundingBox();
      console.log(`  Button ${i}: "${text.trim()}" at y=${Math.round(box?.y || 0)}`);
    }

    // Now try each Wijzig button and look for address fields
    for (let i = 0; i < buttonCount; i++) {
      console.log(`\n=== Clicking Wijzig button ${i} ===`);

      // Reload fresh
      if (i > 0) {
        await page.goto(url, { waitUntil: 'networkidle' });
      }

      // Listen for any API calls triggered by clicking edit
      const apiCalls = [];
      page.on('response', resp => {
        if (resp.url().includes('club.sportlink.com') && !resp.url().includes('.js') && !resp.url().includes('.css')) {
          apiCalls.push(resp.url());
        }
      });

      const btn = page.locator('button:has-text("Wijzig")').nth(i);
      try {
        await btn.waitFor({ state: 'visible', timeout: 5000 });
        await btn.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1500);

        // Log API calls triggered
        if (apiCalls.length > 0) {
          console.log('  API calls after click:');
          for (const url of apiCalls) {
            console.log(`    ${url.substring(0, 150)}`);
          }
        }

        // Collect ALL form fields (including disabled ones)
        const fields = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input, select, textarea');
          return Array.from(inputs)
            .filter(el => el.name || el.id)
            .map(el => ({
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              name: el.name || '',
              id: el.id || '',
              value: el.value || '',
              placeholder: el.placeholder || '',
              disabled: el.disabled,
              readOnly: el.readOnly,
              label: (() => {
                if (el.id) {
                  const lbl = document.querySelector(`label[for="${el.id}"]`);
                  if (lbl) return lbl.textContent.trim();
                }
                const parent = el.closest('.form-group, .field, [class*="field"], tr, [class*="row"]');
                if (parent) {
                  const lbl = parent.querySelector('label, th, [class*="label"]');
                  if (lbl) return lbl.textContent.trim();
                }
                return '';
              })()
            }));
        });

        console.log(`  All named fields (${fields.length}):`);
        for (const f of fields) {
          const state = f.disabled ? 'DISABLED' : f.readOnly ? 'READONLY' : 'EDITABLE';
          console.log(`    [${state}] ${f.tag}[name="${f.name}"] id="${f.id}" type=${f.type} value="${f.value}" label="${f.label}"`);
        }

        // Click cancel
        const cancelBtn = page.locator('button:has-text("Annuleer"), button:has-text("Cancel")').first();
        if (await cancelBtn.count() > 0) {
          await cancelBtn.click();
          await page.waitForLoadState('networkidle');
        }

      } catch (err) {
        console.log(`  Error: ${err.message}`);
      }

      page.removeAllListeners('response');
    }

    // Also check if there's an "address" link or separate address edit page
    console.log('\n=== Checking for address-specific edit links ===');
    const addressLinks = await page.evaluate(() => {
      const all = document.querySelectorAll('a[href*="address" i], a[href*="adres" i], button[class*="address" i]');
      return Array.from(all).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim() || '',
        href: el.getAttribute('href') || '',
        className: el.className || ''
      }));
    });

    if (addressLinks.length > 0) {
      for (const l of addressLinks) {
        console.log(`  ${l.tag}: text="${l.text}" href="${l.href}" class="${l.className}"`);
      }
    } else {
      console.log('  No address-specific links found');
    }

    // Take a screenshot for visual inspection
    await page.screenshot({ path: '/tmp/sportlink-general.png', fullPage: true });
    console.log('\nScreenshot saved to /tmp/sportlink-general.png');

  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
