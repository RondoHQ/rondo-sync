const SOURCES = { sportlink: 'Sportlink/voetbal.nl', rondo: 'Rondo' };
const STATUSES = { changed: 'gewijzigd', deleted: 'verwijderd', skipped: 'overgeslagen', failed: 'mislukt' };

function logPhotoEvent(logger, event) {
  const message = `Foto ${STATUSES[event.status] || event.status} | Bron: ${SOURCES[event.source]} | Naar: ${SOURCES[event.destination]} | KNVB-ID: ${event.knvbId} | Rondo-persoon: ${event.personId || 'onbekend'}${event.reason ? ` | ${event.reason}` : ''}`;
  if (event.status === 'failed') logger?.error(message);
  else logger?.log(message);
}

module.exports = { SOURCES, STATUSES, logPhotoEvent };
