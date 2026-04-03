const config = require('../config');
const { humanScroll, randomDelay } = require('./stealth');

/**
 * Scrolls a page to the bottom, loading all dynamically loaded content.
 * Uses human-like scrolling (no instant jumps).
 * Handles both infinite scroll and "Load More" buttons.
 */
async function scrollToBottom(page, options = {}) {
  const { maxScrolls = config.scroll.maxScrolls, maxStuck = config.scroll.maxStuck } = options;

  let previousHeight = 0;
  let stuckCount = 0;
  let scrollCount = 0;

  while (stuckCount < maxStuck && scrollCount < maxScrolls) {
    // Check for "Load More" / "Show More" buttons
    const loadMoreBtn = await page.$(
      'button:has-text("Load more"), button:has-text("Show more"), ' +
      'button:has-text("See more"), [data-testid="load-more"]'
    );
    if (loadMoreBtn) {
      try {
        await loadMoreBtn.click();
        await page.waitForTimeout(randomDelay(2000, 3500));
        stuckCount = 0;
        scrollCount++;
        continue;
      } catch (e) {
        // Button might have disappeared
      }
    }

    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

    if (currentHeight === previousHeight) {
      stuckCount++;
    } else {
      stuckCount = 0;
    }

    previousHeight = currentHeight;

    // Human-like scroll instead of instant jump
    await humanScroll(page, 600 + Math.random() * 400);

    // Randomized wait between scrolls
    const wait = randomDelay(1500, 3000);
    await page.waitForTimeout(wait);
    scrollCount++;
  }

  // Scroll back to top (human-like)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(1000);

  return scrollCount;
}

module.exports = { scrollToBottom };
