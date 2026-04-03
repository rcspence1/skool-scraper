const fs = require('fs');
const path = require('path');
const config = require('./config');
const save = require('./utils/save');
const logger = require('./utils/logger');
const { randomDelay } = require('./utils/stealth');
const progress = require('./utils/progress');

/**
 * Scan all scraped content for downloadable files (PDFs, docs, etc.)
 * and download them. Run this AFTER courses and classroom are scraped.
 */
async function scrapeFiles(page, prog) {
  console.log('\n📎 DOWNLOADING FILES\n');

  const outputDir = config.outputDir;
  const allFiles = [];

  // Scan course lessons for files
  const coursesDir = path.join(outputDir, 'courses');
  if (fs.existsSync(coursesDir)) {
    scanJsonFiles(coursesDir, allFiles);
  }

  // Scan posts for files
  const postsDir = path.join(outputDir, 'posts');
  if (fs.existsSync(postsDir)) {
    scanJsonFiles(postsDir, allFiles);
  }

  // Deduplicate by URL
  const seen = new Set();
  const uniqueFiles = allFiles.filter(f => {
    if (seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });

  console.log(`  Found ${uniqueFiles.length} unique file(s) to download\n`);
  prog.files.totalFound = uniqueFiles.length;
  progress.save(prog);

  let downloaded = 0;
  for (const file of uniqueFiles) {
    // Skip already downloaded
    if (prog.files.completed.includes(file.url)) {
      console.log(`  ⏭ ${file.name} (already downloaded)`);
      continue;
    }

    try {
      // Clean filename
      let filename = file.name || file.url.split('/').pop() || 'unknown-file';
      filename = filename.replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 100);

      // Add date prefix
      const datePrefix = new Date().toISOString().split('T')[0];
      if (!filename.startsWith('20')) {
        filename = `${datePrefix}-${filename}`;
      }

      const result = await save.downloadFile(page, file.url, filename);
      if (result) {
        logger.downloaded(filename, file.url);
        prog.files.completed.push(file.url);
        downloaded++;
      }
    } catch (e) {
      logger.error(`Failed to download: ${file.name}`, e.message);
    }

    // Human-like delay between downloads
    await page.waitForTimeout(randomDelay(1500, 3500));
  }

  prog.files.downloaded = downloaded;
  progress.save(prog);

  console.log(`\n  ✓ Downloaded ${downloaded}/${uniqueFiles.length} file(s).\n`);
}

/**
 * Recursively scan JSON files for file references
 */
function scanJsonFiles(dir, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanJsonFiles(fullPath, results);
    } else if (entry.name.endsWith('.json') && entry.name !== 'index.json' && entry.name !== 'categories.json') {
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (data.files && Array.isArray(data.files)) {
          data.files.forEach(f => {
            if (f.url) results.push({ url: f.url, name: f.name || 'file', source: fullPath });
          });
        }
        if (data.links && Array.isArray(data.links)) {
          data.links.forEach(l => {
            if (l.url && (l.url.includes('.pdf') || l.url.includes('drive.google') || l.url.includes('download'))) {
              results.push({ url: l.url, name: l.text || 'file', source: fullPath });
            }
          });
        }
      } catch (e) {
        // Skip malformed JSON
      }
    }
  }
}

module.exports = { scrapeFiles };
