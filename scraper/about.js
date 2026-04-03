const config = require('./config');
const rateLimit = require('./utils/rate-limit');
const save = require('./utils/save');
const logger = require('./utils/logger');
const { checkAuth } = require('./login');

/**
 * Scrape the about page, pinned content, welcome guides, and resources.
 */
async function scrapeAbout(page, prog) {
  console.log('\nℹ️  SCRAPING ABOUT PAGE\n');

  if (prog.about === 'complete') {
    console.log('  ⏭ Already scraped, skipping.\n');
    return;
  }

  const aboutUrl = `${config.communityUrl}/about`;
  await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  logger.visit(aboutUrl);
  await page.waitForTimeout(3000);
  await checkAuth(page);

  await save.saveHtml(page, 'about');

  const aboutData = await page.evaluate(() => {
    const data = {
      name: '',
      description: '',
      rules: '',
      links: [],
      sections: [],
      memberCount: '',
      createdBy: ''
    };

    // Community name
    const nameEl = document.querySelector('h1, [class*="community-name"], [class*="CommunityName"]');
    if (nameEl) data.name = nameEl.textContent.trim();

    // Description / about text
    const descSelectors = [
      '[class*="about-description"]', '[class*="AboutDescription"]',
      '[class*="description"]', '[class*="bio"]',
      'article', 'main p'
    ];
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 20) {
        data.description = el.innerText.trim();
        break;
      }
    }

    // Rules section
    const rulesEl = document.querySelector('[class*="rules"], [class*="Rules"]');
    if (rulesEl) data.rules = rulesEl.innerText.trim();

    // All links on the page
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      const text = a.textContent?.trim();
      if (href && !href.startsWith('#') && text && text.length < 200) {
        data.links.push({ url: href, text });
      }
    });

    // Any distinct sections
    document.querySelectorAll('h2, h3').forEach(h => {
      const title = h.textContent?.trim();
      const content = h.nextElementSibling?.innerText?.trim();
      if (title) data.sections.push({ title, content: content || '' });
    });

    // Member count
    const memberEl = document.querySelector('[class*="member"], [class*="Member"]');
    if (memberEl) data.memberCount = memberEl.textContent?.trim();

    return data;
  });

  aboutData.url = aboutUrl;
  aboutData.scrapedAt = new Date().toISOString();

  save.saveJson('about', 'about', aboutData);
  logger.saved('about/about.json');

  // Build markdown version
  let md = `# ${aboutData.name || 'Community About'}\n\n`;
  if (aboutData.memberCount) md += `**Members:** ${aboutData.memberCount}\n\n`;
  if (aboutData.description) md += `## Description\n\n${aboutData.description}\n\n`;
  if (aboutData.rules) md += `## Rules\n\n${aboutData.rules}\n\n`;
  if (aboutData.sections.length > 0) {
    aboutData.sections.forEach(s => {
      md += `## ${s.title}\n\n${s.content}\n\n`;
    });
  }
  if (aboutData.links.length > 0) {
    md += `## Links\n\n`;
    aboutData.links.forEach(l => { md += `- [${l.text}](${l.url})\n`; });
  }
  md += `\n---\n*Scraped: ${aboutData.scrapedAt}*\n`;

  save.saveMarkdown('about', 'about', md);
  logger.saved('about/about.md');

  prog.about = 'complete';
  const progressMod = require('./utils/progress');
  progressMod.save(prog);

  console.log(`  ✓ About page scraped. ${aboutData.sections.length} sections, ${aboutData.links.length} links.\n`);
}

module.exports = { scrapeAbout };
