const { login } = require('./login');
const { scrapeCourses } = require('./courses');
const { scrapeClassroom } = require('./classroom');
const { scrapeAbout } = require('./about');
const { scrapeFiles } = require('./files');
const progress = require('./utils/progress');
const logger = require('./utils/logger');
const config = require('./config');

/**
 * Main orchestrator. Runs all scrapers in sequence.
 * Supports --only flag to run a single scraper.
 */
async function main() {
  console.log('\n' + '═'.repeat(55));
  console.log('  SKOOL COMMUNITY SCRAPER');
  console.log(`  Target: ${config.communityUrl}`);
  console.log('═'.repeat(55) + '\n');

  // Parse --only flag
  const onlyArg = process.argv.find(a => a.startsWith('--only'));
  const only = onlyArg ? process.argv[process.argv.indexOf(onlyArg) + 1] : null;

  // Initialize
  logger.init();
  const prog = progress.load();

  let browser, context, page;

  try {
    // Login
    const session = await login();
    browser = session.browser;
    context = session.context;
    page = session.page;

    logger.info(`Scrape started. Only: ${only || 'all'}`);

    // Friendly warning if this login is not a member of the community (otherwise
    // the run just finds 0 courses with no explanation). Never blocks the scrape.
    try {
      const groups = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        const self = el && JSON.parse(el.textContent).props.pageProps.self;
        return self && Array.isArray(self.allGroups) ? self.allGroups.map(g => g.name) : null;
      });
      if (groups && !groups.includes(config.communitySlug)) {
        console.log(`\n  ⚠ This Skool login does not look like a member of "${config.communitySlug}".`);
        console.log('    Members-only content (courses, files) will come back empty.');
        if (groups.length > 0) {
          console.log('    Communities this login is in:');
          groups.forEach(g => console.log(`      https://www.skool.com/${g}`));
          console.log('    To scrape one of those:  npm start -- <link>');
        }
        logger.warn(`Login is not a member of ${config.communitySlug}`);
      }
    } catch (e) {}

    // Run scrapers in order. Courses then files run first, exactly as they always have.
    if (!only || only === 'courses') {
      await scrapeCourses(page, prog);
    }

    if (!only || only === 'files') {
      await scrapeFiles(page, prog);
    }

    // About page is part of a full run. A failure here never affects what is already saved.
    if (!only || only === 'about') {
      try {
        await scrapeAbout(page, prog);
      } catch (e) {
        if (only) throw e;
        logger.error('About page failed', e.message);
        console.log(`\n  ⚠ About page failed (${e.message}) — carrying on.`);
      }
    }

    // Community posts are opt-in only (npm run scrape:classroom) — not yet proven reliable.
    if (only === 'classroom') {
      await scrapeClassroom(page, prog);
    }

    // Summary
    console.log('\n' + '═'.repeat(55));
    console.log('  SCRAPE COMPLETE');
    console.log('═'.repeat(55));
    console.log(`  Courses: ${Object.keys(prog.courses).length}`);
    console.log(`  Posts: ${prog.posts.scraped}/${prog.posts.totalFound}`);
    console.log(`  About: ${prog.about}`);
    console.log(`  Files: ${prog.files.downloaded}/${prog.files.totalFound}`);
    console.log(`  Saved to: ${config.outputDir}`);
    console.log(`  Log: ${config.outputDir}/scrape-log.txt`);
    console.log('═'.repeat(55) + '\n');

    logger.info('Scrape completed successfully');

  } catch (e) {
    logger.error('Scrape failed', e.message);
    console.error('\n❌ Scrape failed:', e.message);
    console.error('   Run the same command to resume from where it stopped.\n');

    // Save progress even on failure
    progress.save(prog);
  } finally {
    if (browser) {
      console.log('  Closing browser...');
      await browser.close();
    }
  }
}

main();
