const { SportlinkSession } = require('./sportlink-session');

const ORIGIN = 'https://club.sportlink.com';
const BASE = '/navajo/entity/common/clubweb/maintenance/addressbook/';
const CLUB_ID = /^[A-Z0-9]{7}$/;
const HEADER_NAMES = new Set(['accept', 'authorization', 'x-navajo-entity', 'x-navajo-instance', 'x-navajo-locale']);

class DirectoryError extends Error {
  constructor(message, statusCode = 502) { super(message); this.statusCode = statusCode; }
}

function text(value) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new DirectoryError('Ongeldige gegevens ontvangen van Sportlink.');
  return String(value).trim();
}

function items(body) {
  if (!body || !Array.isArray(body.Items) || body.Items.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new DirectoryError('De gegevens van Sportlink zijn onvolledig. Probeer het later opnieuw.');
  }
  return body.Items;
}

function clubs(body) {
  const result = items(body).map(row => {
    const id = text(row.ClubIdentifier);
    if (!CLUB_ID.test(id) || !text(row.ClubName)) throw new DirectoryError('Verenigingsgegevens van Sportlink zijn onvolledig.');
    return {
      id, name: text(row.ClubName), district: text(row.RegionCode),
      address: [text(row.StreetName), [text(row.AddressNumber), text(row.AddressNumberAppendix)].filter(Boolean).join('')].filter(Boolean).join(' '),
      postcode: text(row.ZipCode), city: text(row.City), phone: text(row.Telephone), email: text(row.Email),
    };
  });
  if (new Set(result.map(row => row.id)).size !== result.length) throw new DirectoryError('Sportlink geeft dubbele verenigingscodes terug.');
  return result;
}

function contacts(body, club) {
  return items(body).map(row => {
    if (!text(row.PersonId) || !text(row.FullName) || text(row.ClubName) !== club.name || typeof row.FunctionDescription !== 'string') {
      throw new DirectoryError('Contactgegevens van Sportlink zijn onvolledig of horen bij een andere vereniging.');
    }
    return {
      id: text(row.PersonId), name: text(row.FullName), function: text(row.FunctionDescription),
      phone: text(row.Telephone), mobile: text(row.Mobile), email: text(row.Email), source: text(row.RoleDescription),
    };
  });
}

/** Read the address book's JSON API. The SPA is used only to obtain its own authenticated request headers. */
class ClubDirectory {
  constructor({ sessionFactory = () => new SportlinkSession(), now = () => new Date() } = {}) {
    this.sessionFactory = sessionFactory;
    this.now = now;
    this.session = null;
    this.page = null;
    this.headers = null;
    this.busy = false;
    this.idleTimer = null;
  }

  async bootstrap() {
    this.session ||= this.sessionFactory();
    this.page = await this.session.getPage();
    const responsePromise = this.page.waitForResponse(response =>
      new URL(response.url()).pathname === BASE + 'SearchClubFilter' && response.request().method() === 'GET' && response.status() === 200,
    { timeout: 60000 });
    // Attach a rejection handler immediately, including when navigation itself fails.
    responsePromise.catch(() => {});
    await this.page.goto(ORIGIN + '/communication/address-book/clubs', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const response = await responsePromise;
    this.headers = Object.fromEntries(Object.entries(await response.request().allHeaders()).filter(([key]) => HEADER_NAMES.has(key)));
    if (!this.headers.authorization) throw new DirectoryError('De Sportlink-sessie kon niet worden geopend.');
  }

  async read(endpoint, params) {
    if (!['ClubSearchList', 'ClubOfficials'].includes(endpoint)) throw new DirectoryError('Ongeldige adresboekaanvraag.', 400);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.headers) await this.bootstrap();
      const url = new URL(BASE + endpoint, ORIGIN);
      url.search = new URLSearchParams(params).toString();
      const response = await this.page.request.get(url.href, { headers: this.headers, timeout: 20000, maxRedirects: 0 });
      if (response.status() === 401 && attempt === 0) {
        this.headers = null;
        await this.session.relogin();
        continue;
      }
      if (!response.ok()) throw new DirectoryError('Sportlink is tijdelijk niet beschikbaar. Probeer het later opnieuw.');
      const body = await response.json();
      items(body); // An error or changed schema must never look like an empty search result.
      return body;
    }
    throw new DirectoryError('De Sportlink-sessie is verlopen. Probeer het opnieuw.');
  }

  async run(callback) {
    if (this.busy) throw new DirectoryError('Het adresboek wordt al geraadpleegd. Probeer het over enkele seconden opnieuw.', 429);
    this.busy = true;
    clearTimeout(this.idleTimer);
    try {
      return await callback();
    } catch (error) {
      await this.close();
      if (error instanceof DirectoryError) throw error;
      // Never expose upstream URLs, headers, tokens or response bodies to logs or callers.
      throw new DirectoryError('Sportlink kon niet worden geraadpleegd. Probeer het later opnieuw.');
    } finally {
      this.busy = false;
      this.idleTimer = setTimeout(() => { this.close().catch(() => {}); }, 5 * 60 * 1000);
      this.idleTimer.unref();
    }
  }

  async search(query, field = 'name') {
    query = typeof query === 'string' ? query.trim() : '';
    if (query.length < 2 || query.length > 80 || !['name', 'city'].includes(field)) throw new DirectoryError('Vul 2 tot 80 tekens in en kies naam of plaats.', 400);
    return this.run(async () => {
      const found = clubs(await this.read('ClubSearchList', {
        CityName: field === 'city' ? query : '', ClubName: field === 'name' ? query : '',
        CommunityName: '', DistrictId: '-1', OrganizationId: '', ShowLiquidated: 'false',
      }));
      return { clubs: found.slice(0, 100), total: found.length, truncated: found.length > 100, fetched_at: this.now().toISOString() };
    });
  }

  async detail(id) {
    if (typeof id !== 'string' || !CLUB_ID.test(id)) throw new DirectoryError('Ongeldige verenigingscode.', 400);
    return this.run(async () => {
      const found = clubs(await this.read('ClubSearchList', {
        CityName: '', ClubName: id, CommunityName: '', DistrictId: '-1', OrganizationId: id, ShowLiquidated: 'false',
      }));
      if (found.length === 0) throw new DirectoryError('Deze vereniging is niet meer beschikbaar in Sportlink.', 404);
      if (found.length !== 1 || found[0].id !== id) throw new DirectoryError('Sportlink kon de vereniging niet eenduidig bevestigen.');
      const club = found[0];
      const rows = contacts(await this.read('ClubOfficials', {
        DistrictId: '-1', FunctionId: '-1', LastName: '', OrganizationId: id, OrganizationName: id + ' - ' + club.name,
      }), club);
      return { club, contacts: rows, fetched_at: this.now().toISOString() };
    });
  }

  async close() {
    clearTimeout(this.idleTimer);
    const session = this.session;
    this.session = null;
    this.page = null;
    this.headers = null;
    if (session) await session.close();
  }
}

module.exports = { ClubDirectory, DirectoryError, clubs, contacts, items };
