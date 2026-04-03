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

    // Run scrapers in order — CLASSROOM (courses) is priority
    // Community posts are secondary and can be added later
    if (!only || only === 'courses') {
      await scrapeCourses(page, prog);
    }

    if (only === 'about') {
      await scrapeAbout(page, prog);
    }

    if (only === 'classroom') {
      await scrapeClassroom(page, prog);
    }

    if (!only || only === 'files') {
      await scrapeFiles(page, prog);
    }

    // Summary
    console.log('\n' + '═'.repeat(55));
    console.log('  SCRAPE COMPLETE');
    console.log('═'.repeat(55));
    console.log(`  Courses: ${Object.keys(prog.courses).length}`);
    console.log(`  Posts: ${prog.posts.scraped}/${prog.posts.totalFound}`);
    console.log(`  About: ${prog.about}`);
    console.log(`  Files: ${prog.files.downloaded}/${prog.files.totalFound}`);
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
