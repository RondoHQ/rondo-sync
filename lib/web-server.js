require('dotenv/config');

const fastify = require('fastify');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const SqliteStore = require('fastify-session-better-sqlite3-store');
const { requireAuth, requireApiKey, loginHandler, logoutHandler } = require('./auth');
const { syncIndividual } = require('../pipelines/sync-individual');
const { getPipelineOverview, getRunHistory, getRunDetail, getErrors, getRunErrors, isPipelineRunning, clearErrors, closeDb } = require('./dashboard-queries');
const { openDb, getFreeFieldMappings, upsertFreeFieldMappings } = require('./rondo-club-db');


/**
 * Build and configure Fastify server with all plugins and routes.
 * @returns {Promise<FastifyInstance>}
 */
async function buildServer() {
  // Create Fastify instance
  const app = fastify({
    logger: true,
    trustProxy: true // Required for rate limiting behind nginx
  });

  // Validate SESSION_SECRET
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters. Generate with: openssl rand -base64 32');
  }

  // Ensure data directory exists for session database
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Register @fastify/cookie (required by @fastify/session)
  await app.register(require('@fastify/cookie'));

  // Register @fastify/formbody (parse POST form data)
  await app.register(require('@fastify/formbody'));

  // Create SQLite database for sessions
  const sessionDb = new Database(path.join(dataDir, 'sessions.sqlite'));

  // Register @fastify/session with SQLite store
  await app.register(require('@fastify/session'), {
    secret: sessionSecret,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      sameSite: 'lax', // CSRF protection
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    },
    store: new SqliteStore(sessionDb)
  });

  // Register @fastify/rate-limit (not global - per-route)
  await app.register(require('@fastify/rate-limit'), {
    global: false
  });

  // Register @fastify/static (serve static files from public/)
  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/public/'
  });

  // Register @fastify/view with EJS templates
  await app.register(require('@fastify/view'), {
    engine: {
      ejs: require('ejs')
    },
    root: path.join(__dirname, '..', 'views')
  });

  // Routes

  // GET /login - Login page (unauthenticated)
  app.get('/login', async (request, reply) => {
    // If already logged in, redirect to dashboard
    if (request.session.user) {
      return reply.redirect('/');
    }
    return reply.view('login', { error: null });
  });

  // POST /login - Login handler (rate limited)
  app.post('/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute'
      }
    }
  }, loginHandler);

  // POST /logout - Logout handler (requires auth)
  app.post('/logout', { preHandler: requireAuth }, logoutHandler);

  // GET /health - Health check (unauthenticated, for monitoring)
  app.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Helper: Format relative time
  function formatRelativeTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}w ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
  }

  // Helper: Format duration
  function formatDuration(ms) {
    if (!ms) return '0s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  // Helper: Format next run time
  function formatNextRun(nextRunObj) {
    if (!nextRunObj) return '';
    const formatted = nextRunObj.time.toLocaleString('en-US', {
      timeZone: 'Europe/Amsterdam',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return formatted;
  }

  // Known pipelines for validation
  const KNOWN_PIPELINES = {
    people: 'People',
    nikki: 'Nikki',
    freescout: 'FreeScout',
    'freescout-conversations': 'FreeScout conversations',
    teams: 'Teams',
    functions: 'Member roles + VOG',
    'functions-full': 'Member roles (full)',
    discipline: 'Discipline',
    'former-members': 'Former members'
  };

  const FREE_FIELD_SOURCES = ['Remarks1', 'Remarks2', 'Remarks3', 'Remarks4', 'Remarks5', 'Remarks6', 'Remarks7', 'Remarks8'];
  const FREE_FIELD_VALUE_TYPES = ['string', 'number', 'date', 'boolean'];
  const FREE_FIELD_TARGET_OPTIONS = [
    'freescout-id',
    'datum-vog',
    'financiele-blokkade',
    'first_name',
    'infix',
    'last_name',
    'gender',
    'birth_year',
    'birthdate',
    'type-lid',
    'leeftijdsgroep',
    'lid-sinds',
    'lid-tot',
    'datum-overlijden',
    'datum-foto',
    'former_member',
    'factuur-adres',
    'factuur-email',
    'factuur-referentie',
    'team'
  ];

  // GET / - Dashboard overview (requires auth)
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const pipelines = getPipelineOverview();
    return reply.view('overview', {
      title: 'Dashboard',
      page: 'overview',
      user: request.session.user,
      pipelines,
      formatRelativeTime,
      formatDuration,
      formatNextRun
    });
  });

  // GET /beheer/free-fields - Configure mapping of Sportlink Remarks1..8 to Rondo Club fields
  app.get('/beheer/free-fields', { preHandler: requireAuth }, async (request, reply) => {
    const db = openDb();
    try {
      const rows = getFreeFieldMappings(db);
      const bySource = new Map(rows.map(row => [row.source_field, row]));
      const mappings = FREE_FIELD_SOURCES.map((source) => {
        const row = bySource.get(source);
        return {
          source_field: source,
          target_field: row?.target_field || '',
          value_type: row?.value_type || 'string'
        };
      });

      return reply.view('free-field-mappings', {
        title: 'Beheer - Vrije Velden',
        page: 'beheer',
        user: request.session.user,
        mappings,
        valueTypes: FREE_FIELD_VALUE_TYPES,
        targetOptions: FREE_FIELD_TARGET_OPTIONS,
        saved: request.query.saved === '1'
      });
    } finally {
      db.close();
    }
  });

  // POST /beheer/free-fields - Save free-field mappings
  app.post('/beheer/free-fields', { preHandler: requireAuth }, async (request, reply) => {
    const form = request.body || {};
    const mappings = FREE_FIELD_SOURCES.map((source) => {
      const key = source.toLowerCase();
      const target = String(form[`${key}_target`] || '').trim();
      const type = String(form[`${key}_type`] || 'string').trim();
      return {
        source_field: source,
        target_field: target || null,
        value_type: FREE_FIELD_VALUE_TYPES.includes(type) ? type : 'string'
      };
    });

    const db = openDb();
    try {
      upsertFreeFieldMappings(db, mappings);
    } finally {
      db.close();
    }

    return reply.redirect('/beheer/free-fields?saved=1');
  });

  // GET /pipeline/:name - Run history for a pipeline (requires auth)
  app.get('/pipeline/:name', { preHandler: requireAuth }, async (request, reply) => {
    const pipelineName = request.params.name;

    // Validate pipeline name
    if (!KNOWN_PIPELINES[pipelineName]) {
      return reply.code(404).send('Pipeline not found');
    }

    // Parse page parameter
    const page = parseInt(request.query.page || '1', 10);
    if (isNaN(page) || page < 1) {
      return reply.code(400).send('Invalid page parameter');
    }

    // Get run history
    const history = getRunHistory(pipelineName, page, 20);

    return reply.view('run-history', {
      title: `${KNOWN_PIPELINES[pipelineName]} - Run History`,
      page: 'overview',
      user: request.session.user,
      pipelineName,
      pipelineDisplayName: KNOWN_PIPELINES[pipelineName],
      runs: history.runs,
      pagination: {
        current: history.currentPage,
        total: history.totalPages,
        perPage: history.perPage,
        totalRuns: history.totalRuns
      },
      formatDuration
    });
  });

  // POST /api/pipeline/:name/start - Trigger a pipeline run (requires auth)
  app.post('/api/pipeline/:name/start', { preHandler: requireAuth }, async (request, reply) => {
    const pipelineName = request.params.name;

    if (!KNOWN_PIPELINES[pipelineName]) {
      return reply.code(404).send({ ok: false, error: 'Unknown pipeline' });
    }

    // Prevent starting a pipeline that's already running
    if (isPipelineRunning(pipelineName)) {
      return reply.code(409).send({ ok: false, error: 'Pipeline is already running' });
    }

    try {
      const projectRoot = path.join(__dirname, '..');

      // Map dashboard pipeline names to sync.sh arguments
      const PIPELINE_ARGS = {
        'functions-full': ['functions', '--all', '--with-invoice'],
        'former-members': ['former-members'],
        'freescout-conversations': ['conversations']
      };
      const args = PIPELINE_ARGS[pipelineName] || [pipelineName];

      // Launch detached from the web server process.
      // The systemd service uses KillMode=process so only the web server
      // itself is stopped on restart, not these child processes.
      const child = spawn('scripts/sync.sh', args, {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      app.log.info(`Pipeline "${pipelineName}" started by ${request.session.user} via systemd-run`);
      return { ok: true, pipeline: pipelineName };
    } catch (err) {
      app.log.error(`Failed to start pipeline "${pipelineName}": ${err.message}`);
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // GET /run/:id - Run detail (requires auth)
  app.get('/run/:id', { preHandler: requireAuth }, async (request, reply) => {
    const runId = parseInt(request.params.id, 10);
    if (isNaN(runId)) {
      return reply.code(400).send('Invalid run ID');
    }

    // Get run detail
    const detail = getRunDetail(runId);
    if (!detail) {
      return reply.code(404).send('Run not found');
    }

    return reply.view('run-detail', {
      title: `Run #${runId}`,
      page: 'overview',
      user: request.session.user,
      run: detail.run,
      pipelineDisplayName: KNOWN_PIPELINES[detail.run.pipeline] || detail.run.pipeline,
      steps: detail.steps,
      errorCount: detail.errorCount,
      formatDuration
    });
  });

  // GET /errors - Error browser with filters (requires auth)
  app.get('/errors', { preHandler: requireAuth }, async (request, reply) => {
    // Parse query parameters
    const pipeline = request.query.pipeline || '';
    const dateFrom = request.query.date_from || '';
    const dateTo = request.query.date_to || '';
    const runId = request.query.run_id ? parseInt(request.query.run_id, 10) : null;
    const page = parseInt(request.query.page || '1', 10);

    if (isNaN(page) || page < 1) {
      return reply.code(400).send('Invalid page parameter');
    }

    // Build filter object
    const filters = {
      pipeline: pipeline || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      runId: runId || null,
      page
    };

    // Get errors
    const result = getErrors(filters);

    return reply.view('errors', {
      title: 'Error Browser',
      page: 'errors',
      user: request.session.user,
      errors: result.errors,
      totalErrors: result.totalErrors,
      totalPages: result.totalPages,
      currentPage: result.currentPage,
      filters: {
        pipeline,
        dateFrom,
        dateTo,
        runId,
        page
      }
    });
  });

  // GET /errors/:runId - Error detail for a specific run (requires auth)
  app.get('/errors/:runId', { preHandler: requireAuth }, async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) {
      return reply.code(400).send('Invalid run ID');
    }

    // Get run errors
    const result = getRunErrors(runId);
    if (!result) {
      return reply.code(404).send('Run not found');
    }

    return reply.view('error-detail', {
      title: `Errors for Run #${runId}`,
      page: 'errors',
      user: request.session.user,
      run: result.run,
      pipelineDisplayName: KNOWN_PIPELINES[result.run.pipeline] || result.run.pipeline,
      errors: result.errors
    });
  });

  // POST /api/errors/clear - Clear all errors (requires auth)
  app.post('/api/errors/clear', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const result = clearErrors();
      app.log.info(`Errors cleared by ${request.session.user}: ${result.errors} errors`);
      return reply.redirect('/errors');
    } catch (err) {
      app.log.error(`Failed to clear errors: ${err.message}`);
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // Individual sync concurrency guard (Sportlink uses TOTP, one Playwright session at a time)
  let individualSyncRunning = false;

  // POST /api/sync/individual - Sync a single member by KNVB ID (API key auth)
  app.post('/api/sync/individual', {
    preHandler: requireApiKey,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const { knvb_id } = request.body || {};

    if (!knvb_id || typeof knvb_id !== 'string' || !/^[A-Z0-9-]{4,10}$/i.test(knvb_id)) {
      return reply.code(400).send({ ok: false, error: 'Invalid knvb_id: must be 4-10 alphanumeric characters' });
    }

    if (individualSyncRunning) {
      return reply.code(429).send({ ok: false, error: 'Another individual sync is already in progress. Try again in a minute.' });
    }

    individualSyncRunning = true;
    try {
      const result = await syncIndividual(knvb_id, { force: true, fetch: true });

      if (!result.success) {
        const status = result.error === 'Member not found' ? 422 : 500;
        return reply.code(status).send({ ok: false, error: result.error });
      }

      return {
        ok: true,
        knvb_id,
        action: result.action,
        rondo_club_id: result.rondoClubId || null
      };
    } catch (err) {
      app.log.error(`Individual sync failed for ${knvb_id}: ${err.message}`);
      return reply.code(500).send({ ok: false, error: 'Internal sync error' });
    } finally {
      individualSyncRunning = false;
    }
  });

  // Register onClose hook for clean shutdown
  app.addHook('onClose', async () => {
    closeDb();
  });

  return app;
}

module.exports = { buildServer };

// CLI: Start server
if (require.main === module) {
  const HOST = process.env.WEB_HOST || '127.0.0.1';
  const PORT = parseInt(process.env.WEB_PORT || '3000', 10);

  buildServer().then(server => {
    server.listen({ port: PORT, host: HOST }, (err) => {
      if (err) {
        server.log.error(err);
        process.exit(1);
      }
    });
  }).catch(err => {
    console.error('Failed to build server:', err);
    process.exit(1);
  });
}
