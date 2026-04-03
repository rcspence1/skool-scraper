/**
 * Anti-detection utilities. Makes Playwright look like a real human browsing.
 */

const CHROME_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Configure browser context to look like a real Chrome session
 */
function getBrowserConfig() {
  return {
    userAgent: CHROME_USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    deviceScaleFactor: 2,
    hasTouch: false,
    javaScriptEnabled: true
  };
}

/**
 * Inject stealth scripts into a page to hide automation signals
 */
async function applyStealthScripts(page) {
  await page.addInitScript(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    // Override permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // Chrome runtime
    window.chrome = { runtime: {} };
  });
}

/**
 * Random delay between min and max (milliseconds)
 */
function randomDelay(min = 2000, max = 5000) {
  return min + Math.random() * (max - min);
}

/**
 * Simulate human-like mouse movement to an element before clicking
 */
async function humanClick(page, selector, options = {}) {
  const element = await page.waitForSelector(selector, { timeout: options.timeout || 10000 });
  if (!element) throw new Error(`Element not found: ${selector}`);

  const box = await element.boundingBox();
  if (!box) throw new Error(`Element not visible: ${selector}`);

  // Move to a random point within the element
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

  // Move mouse in steps (not instant teleport)
  await page.mouse.move(targetX, targetY, { steps: 5 + Math.floor(Math.random() * 10) });

  // Small pause before clicking (like a human)
  await page.waitForTimeout(200 + Math.random() * 400);

  await element.click();
  return element;
}

/**
 * Simulate human-like scrolling (not instant jumps)
 */
async function humanScroll(page, distance = 300) {
  const steps = 3 + Math.floor(Math.random() * 5);
  const stepSize = distance / steps;

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepSize + (Math.random() * 50 - 25));
    await page.waitForTimeout(100 + Math.random() * 200);
  }
}

module.exports = {
  CHROME_USER_AGENT,
  getBrowserConfig,
  applyStealthScripts,
  randomDelay,
  humanClick,
  humanScroll
};
