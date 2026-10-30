const { ClubDirectory, DirectoryError } = require('./club-directory');
const { requireApiKey } = require('./auth');

function registerClubDirectoryRoutes(app, directory = new ClubDirectory()) {
  const options = { preHandler: requireApiKey, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const handle = callback => async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try { return await callback(request); }
    catch (error) {
      return reply.code([400, 404, 429, 502].includes(error.statusCode) ? error.statusCode : 502)
        .send({ error: error instanceof DirectoryError ? error.message : 'Sportlink kon niet worden geraadpleegd.' });
    }
  };
  app.get('/api/club-directory', options, handle(request => directory.search(request.query.search, request.query.field || 'name')));
  app.get('/api/club-directory/:id', options, handle(request => directory.detail(request.params.id)));
  app.addHook('onClose', async () => directory.close());
}

module.exports = { registerClubDirectoryRoutes };
