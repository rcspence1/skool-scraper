const config = require('../config');
const logger = require('./logger');
const { randomDelay } = require('./stealth');

let inBackoff = false;
let backoffUntil = 0;

/**
 * Wait a randomized delay between actions.
 * Min 2s, max 5s (human-like). Respects backoff mode.
 */
async function wait(page) {
  if (inBackoff && Date.now() < backoffUntil) {
    const remaining = Math.round((backoffUntil - Date.now()) / 1000);
    logger.warn(`Rate-limited — backing off for ${remaining}s`);
    await page.waitForTimeout(config.delays.backoff);
    return;
  }

  if (inBackoff && Date.now() >= backoffUntil) {
    inBackoff = false;
    logger.info('Backoff period ended, resuming normal speed');
  }

  // Randomized 2-5 second delay (human-like)
  const delay = randomDelay(2000, 5000);
  await page.waitForTimeout(delay);
}

/**
 * Trigger backoff mode. Called on 429/403 responses.
 * Pauses for 30 seconds then retries once before stopping.
 */
async function triggerBackoff(page) {
  logger.warn('Rate limit or 403 detected — pausing 30 seconds');
  console.log('\n  ⚠ Rate limit detected. Pausing 30 seconds...\n');
  inBackoff = true;
  backoffUntil = Date.now() + 30000;
  await page.waitForTimeout(30000);
}

/**
 * Check if a response indicates rate limiting or blocking
 */
function isRateLimited(response) {
  if (!response) return false;
  const status = response.status();
  return status === 429 || status === 403;
}

module.exports = { wait, triggerBackoff, isRateLimited };
