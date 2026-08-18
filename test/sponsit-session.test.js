const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SponsitSession,
  extractTotpSecret,
  generateSponsitTotp,
  validateSponsitUrl
} = require('../lib/sponsit-session');

test('requestFile accepts authenticated images from the Sponsit origin', async () => {
  const session = new SponsitSession({
    url: 'https://account.sponsit.test',
    username: 'test',
    password: 'test'
  });
  session._page = { isClosed: () => false };
  session._context = {
    request: {
      get: async () => ({
        status: () => 200,
        headers: () => ({ 'content-type': 'image/png', 'content-length': '4' }),
        url: () => 'https://account.sponsit.test/uploads/1/preview/logo.png',
        ok: () => true,
        body: async () => Buffer.from('logo')
      })
    }
  };

  const file = await session.requestFile('/uploads/1/preview/logo.png');
  assert.equal(file.contentType, 'image/png');
  assert.equal(file.buffer.toString(), 'logo');
});

test('extractTotpSecret accepts base32 values and otpauth URLs', () => {
  assert.equal(extractTotpSecret('abcd efgh-2345'), 'ABCDEFGH2345');
  assert.equal(
    extractTotpSecret('otpauth://totp/Sponsit:test?secret=abcd2345&issuer=Sponsit'),
    'ABCD2345'
  );
});

test('generateSponsitTotp supports the shorter Base32 secrets issued by Sponsit', () => {
  assert.match(generateSponsitTotp('JBSWY3DPEHPK3PXP'), /^\d{6}$/);
});

test('Sponsit credentials can only be submitted to an HTTPS origin', () => {
  assert.equal(
    validateSponsitUrl('https://account.sponsit.nl/contacts'),
    'https://account.sponsit.nl'
  );
  assert.throws(
    () => validateSponsitUrl('http://account.sponsit.nl'),
    /must use HTTPS/
  );
});
