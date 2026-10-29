/**
 * Dual-stream logger module
 * Writes to both stdout and a date-based log file simultaneously
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const LOGS_DIR = path.join(process.cwd(), 'logs');

// stdout/stderr are process-wide: one guard per stream, even when several
// loggers exist. Keep it for the process lifetime so late write errors remain
// handled after a logger closes its file.
const terminalWriters = new WeakMap();

function terminalWriter(stream) {
  if (terminalWriters.has(stream)) return terminalWriters.get(stream);

  let disconnected = false;
  function handleError(error) {
    if (error.code !== 'EPIPE') throw error;
    disconnected = true;
  }
  stream.on('error', handleError);

  const write = message => {
    if (disconnected) return;
    try {
      stream.write(message + '\n');
    } catch (error) {
      handleError(error);
    }
  };
  terminalWriters.set(stream, write);
  return write;
}

/**
 * Ensure logs directory exists
 */
function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Generate log file path with ISO 8601 date
 * @param {string} [prefix] - Optional prefix for log file name
 * @returns {string} Path like logs/sync-2026-01-24.log or logs/sync-people-2026-01-24.log
 */
function getDefaultLogPath(prefix) {
  const today = new Date().toISOString().split('T')[0];
  const name = prefix ? `sync-${prefix}-${today}` : `sync-${today}`;
  return path.join(LOGS_DIR, `${name}.log`);
}

/**
 * Create a sync logger with dual output (stdout + file)
 * @param {Object} options
 * @param {boolean} [options.verbose=false] - Enable verbose output
 * @param {string} [options.logFile] - Override log file path
 * @param {string} [options.prefix] - Prefix for log file name (e.g., 'people', 'photos', 'teams')
 * @returns {Object} Logger instance
 */
function createSyncLogger(options = {}) {
  const { verbose = false, logFile, prefix } = options;

  ensureLogsDir();

  const logPath = logFile || getDefaultLogPath(prefix);
  const fileStream = fs.createWriteStream(logPath, { flags: 'a' });

  const writeStdout = terminalWriter(process.stdout);
  const writeStderr = terminalWriter(process.stderr);

  // A file failure stays visible on stderr, including if stdout disconnected.
  fileStream.on('error', (err) => {
    writeStderr(`[Logger] Warning: Could not write to log file: ${err.message}`);
  });

  // Timer storage
  const timers = new Map();
  let timerIdCounter = 0;

  /**
   * Write to both terminal and file
   */
  function writeOutput(prefix, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    const formattedMessage = prefix ? `${prefix} ${message}` : message;

    // Persist independently of the optional terminal consumer.
    fileStream.write(`[${timestamp}] ${formattedMessage}\n`);
    writeStdout(formattedMessage);
  }

  /**
   * Write error to both terminal and file
   */
  function writeError(prefix, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    const formattedMessage = prefix ? `${prefix} ${message}` : message;

    fileStream.write(`[${timestamp}] ${formattedMessage}\n`);
    writeStderr(formattedMessage);
  }

  const logger = {
    /**
     * Always outputs (summary-level messages)
     */
    log(...args) {
      writeOutput('', ...args);
    },

    /**
     * Only outputs if verbose mode enabled
     */
    verbose(...args) {
      if (verbose) {
        writeOutput('[verbose]', ...args);
      }
    },

    /**
     * Always outputs, prefixed for visibility
     */
    error(...args) {
      writeError('[ERROR]', ...args);
    },

    /**
     * Outputs section divider (three lines for email HTML conversion)
     */
    section(title) {
      const divider = '='.repeat(40);
      const minorDivider = '-'.repeat(40);
      writeOutput('', '');
      writeOutput('', divider);
      writeOutput('', title.toUpperCase());
      writeOutput('', minorDivider);
    },

    /**
     * Start a timer
     * @returns {number} Timer ID
     */
    startTimer() {
      const id = ++timerIdCounter;
      timers.set(id, performance.now());
      return id;
    },

    /**
     * End a timer and get duration
     * @param {number} id - Timer ID from startTimer()
     * @returns {string} Duration in seconds (one decimal)
     */
    endTimer(id) {
      const start = timers.get(id);
      if (start === undefined) {
        return '0.0';
      }
      timers.delete(id);
      const duration = (performance.now() - start) / 1000;
      return duration.toFixed(1);
    },

    /**
     * Close the file stream
     */
    close() {
      fileStream.end();
    },

    /**
     * Get the log file path
     */
    getLogPath() {
      return logPath;
    }
  };

  // Register process exit handler to ensure stream is closed
  process.on('exit', () => {
    if (!fileStream.destroyed) {
      fileStream.end();
    }
  });

  return logger;
}

/**
 * Simple logger factory (for backward compatibility)
 * @param {boolean} enabled - Whether logging is enabled
 * @returns {Function} Logger function
 */
function createLogger(enabled) {
  return (...args) => {
    if (enabled) {
      console.log(...args);
    }
  };
}

module.exports = {
  createSyncLogger,
  createLogger
};
