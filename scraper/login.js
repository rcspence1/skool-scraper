const { chromium } = require('playwright');
const fs = require('fs');
const config = require('./config');
const { getBrowserConfig, applyStealthScripts } = require('./utils/stealth');
const logger = require('./utils/logger');

/**
 * Opens browser with stealth config, handles login.
 * Instead of waiting for ENTER (which doesn't work in Claude Code),
 * polls the page every 3 seconds to detect when login is complete.
 */
async function login() {
  console.log('\n🔐 Starting browser for Skool login...\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: config.browser.slowMo,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--window-size=1440,900'
    ]
  });

  const browserConfig = getBrowserConfig();
  let context;
  let page;

  // Try to restore saved session first
  if (fs.existsSync(config.sessionFile)) {
    console.log('  Found saved session, attempting to restore...');
    try {
      const storageState = JSON.parse(fs.readFileSync(config.sessionFile, 'utf-8'));
      context = await browser.newContext({ storageState, ...browserConfig });
      page = await context.newPage();
      await applyStealthScripts(page);

      await page.goto(config.communityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      logger.visit(config.communityUrl);
      await page.waitForTimeout(5000);

      const url = page.url();
      if (url.includes('/login') || url.includes('/signup')) {
        console.log('  Session expired, need fresh login.');
        await page.close();
        await context.close();
        page = null;
        context = null;
      } else {
        console.log('  ✓ Session restored!\n');
        return { browser, context, page };
      }
    } catch (e) {
      console.log(`  Session restore failed: ${e.message}`);
      logger.warn(`Session restore failed: ${e.message}`);
    }
  }

  // Fresh login — open login page
  context = await browser.newContext(browserConfig);
  page = await context.newPage();
  await applyStealthScripts(page);

  await page.goto('https://www.skool.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  logger.visit('https://www.skool.com/login');

  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log('  │  Log in to Skool in the browser window.         │');
  console.log('  │                                                 │');
  console.log('  │  I\'ll detect when you\'re logged in             │');
  console.log('  │  automatically — no need to press anything.     │');
  console.log('  │                                                 │');
  console.log('  │  If you see a CAPTCHA, solve it manually.       │');
  console.log('  └─────────────────────────────────────────────────┘\n');

  // Poll until the user has logged in and navigated to the community
  // Detect login by checking if the URL has moved away from /login
  console.log('  ⏳ Waiting for login...');
  await waitForLogin(page);
  console.log('  ✓ Login detected!\n');

  // Save session for future runs
  const storageState = await context.storageState();
  fs.writeFileSync(config.sessionFile, JSON.stringify(storageState, null, 2));
  console.log('  ✓ Session saved for future runs.\n');
  logger.info('Session saved');

  // Navigate to community if not already there
  if (!page.url().includes(config.communitySlug)) {
    await page.goto(config.communityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    logger.visit(config.communityUrl);
    await page.waitForTimeout(5000);
  }

  return { browser, context, page };
}

/**
 * Polls the page every 3 seconds to detect when the user has logged in.
 * Login is detected when the URL no longer contains /login or /signup.
 * Times out after 5 minutes.
 */
async function waitForLogin(page, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(3000);
    try {
      const url = page.url();
      // User has logged in when URL moves away from login/signup
      if (!url.includes('/login') && !url.includes('/signup') && url.includes('skool.com')) {
        return;
      }
    } catch (e) {
      // Page might be navigating, just wait
    }
  }
  throw new Error('Login timed out after 5 minutes. Run the scraper again.');
}

/**
 * Check if current page shows we're still authenticated.
 * If session expires mid-scrape, wait for re-login automatically.
 */
async function checkAuth(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/signup')) {
    logger.warn('Session expired — waiting for re-authentication');
    console.log('\n  ⚠ Session expired! Log in again in the browser window.\n');
    console.log('  ⏳ Waiting for re-login...');

    await waitForLogin(page);
    console.log('  ✓ Re-login detected!\n');

    // Navigate back to community
    await page.goto(config.communityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Save refreshed session
    const storageState = await page.context().storageState();
    fs.writeFileSync(config.sessionFile, JSON.stringify(storageState, null, 2));
    logger.info('Session refreshed after re-auth');
    console.log('  ✓ Session refreshed.\n');
  }
}

module.exports = { login, checkAuth };
