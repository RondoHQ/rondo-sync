/** Format a surname for systems without a separate Dutch infix field. */
function familyName(fields = {}) {
  return [fields.infix, fields.last_name]
    .map(value => String(value || '').trim())
    .filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

/** Compare name parts without guessing or removing surname prefixes. */
function personNameKey(fields = {}) {
  const normalize = value => String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([normalize(fields.first_name), normalize(familyName(fields))]);
}

module.exports = { familyName, personNameKey };
