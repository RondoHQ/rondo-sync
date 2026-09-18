const { selectInactiveMemberStatus } = require('./download-inactive-members');

/** Validate a targeted SearchMembers response without mistaking missing data for empty values. */
function readMemberSearchResult(data, knvbId) {
  if (!Array.isArray(data?.Members)) {
    throw new Error('SearchMembers returned an incomplete member list');
  }
  const matches = data.Members.filter(member => member?.PublicPersonId === knvbId);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error(`SearchMembers returned multiple records for ${knvbId}`);
  const member = matches[0];
  for (const field of ['KernelGameActivities', 'AgeClassDescription']) {
    if (!Object.hasOwn(member, field) || (member[field] !== null && typeof member[field] !== 'string')) {
      throw new Error(`SearchMembers omitted or returned an invalid ${field} for ${knvbId}`);
    }
  }
  return member;
}

/** Fetch one complete, current member record using the same search as the People import. */
async function fetchMemberSearchData(page, knvbId, logger, { session } = {}) {
  for (const inactive of [false, true]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto('https://club.sportlink.com/member/search', { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (!page.url().includes('/member/search')) {
          if (!session || attempt > 0) throw new Error('Sportlink redirected away from member search');
          await session.relogin();
          page = await session.getPage();
          await page.goto('https://club.sportlink.com/member/search', { waitUntil: 'domcontentloaded', timeout: 45000 });
        }
        if (inactive) {
          await selectInactiveMemberStatus(page);
        } else {
          await page.waitForSelector('#btnShowMore:not([disabled])', { timeout: 20000 });
          await page.click('#btnShowMore');
        }
        break;
      } catch (error) {
        if (attempt > 0) throw error;
        logger.verbose(`Member search panel unavailable; retrying once: ${error.message}`);
      }
    }
    await page.waitForSelector('#scFetchUnionTeams_input', { timeout: 20000 });
    await page.check('#scFetchUnionTeams_input');
    await page.fill('input[name="SEARCHVALUE"]', knvbId);
    const [response] = await Promise.all([
      page.waitForResponse(
        resp => resp.url().includes('/navajo/entity/common/clubweb/member/search/SearchMembers')
          && resp.request().method() === 'POST',
        { timeout: 60000 }
      ),
      page.click('#btnSearch')
    ]);
    if (!response.ok()) throw new Error(`SearchMembers failed (${response.status()}) for ${knvbId}`);
    const member = readMemberSearchResult(await response.json(), knvbId);
    if (member) return member;
    logger.verbose(`No exact ${inactive ? 'inactive' : 'active'} SearchMembers match for ${knvbId}`);
  }
  throw new Error(`SearchMembers did not return ${knvbId}; individual sync stopped`);
}

module.exports = { fetchMemberSearchData, readMemberSearchResult };
