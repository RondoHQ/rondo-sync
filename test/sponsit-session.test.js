const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractTotpSecret,
  generateSponsitTotp,
  validateSponsitUrl
} = require('../lib/sponsit-session');

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
