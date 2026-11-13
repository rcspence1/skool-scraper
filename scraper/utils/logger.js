const fs = require('fs');
const path = require('path');
const config = require('../config');

const logFile = path.join(config.outputDir, 'scrape-log.txt');

/**
 * Append a timestamped entry to the scrape log
 */
function log(type, message, details = '') {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${type.toUpperCase()}] ${message}${details ? ' | ' + details : ''}\n`;

  fs.appendFileSync(logFile, entry);

  // Also console output with color coding
  const colors = {
    visit: '\x1b[36m',    // cyan
    save: '\x1b[32m',     // green
    error: '\x1b[31m',    // red
    warn: '\x1b[33m',     // yellow
    info: '\x1b[37m',     // white
    download: '\x1b[35m', // magenta
  };
  const color = colors[type] || '\x1b[37m';
  console.log(`${color}  [${type.toUpperCase()}]\x1b[0m ${message}`);
}

/**
 * Log a URL visit
 */
function visit(url) {
  log('visit', url);
}

/**
 * Log a file save
 */
function saved(filepath) {
  log('save', filepath);
}

/**
 * Log a file download
 */
function downloaded(filename, sourceUrl) {
  log('download', filename, `from: ${sourceUrl}`);
}

/**
 * Log an error
 */
function error(message, details) {
  log('error', message, details);
}

/**
 * Log a warning (rate limit, auth issue, etc)
 */
function warn(message) {
  log('warn', message);
}

/**
 * Log general info
 */
function info(message) {
  log('info', message);
}

/**
 * Initialize the log file
 */
function init() {
  const header = `\n${'='.repeat(60)}\nSCRAPE SESSION: ${new Date().toISOString()}\nCommunity: ${config.communityUrl}\n${'='.repeat(60)}\n\n`;
  fs.mkdirSync(path.dirname(logFile), { recursive: true }); // first run: output folder does not exist yet
  fs.appendFileSync(logFile, header);
}

module.exports = { log, visit, saved, downloaded, error, warn, info, init };
