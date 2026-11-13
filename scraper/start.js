/**
 * One-command launcher.
 *
 *   npm start
 *   npm start -- https://www.skool.com/your-community
 *
 * 1. Works out which community to scrape (command line, saved from last time, or asks).
 * 2. Checks the optional transcription tools and switches transcription off if any are missing.
 * 3. Hands over to the main scraper, which opens the browser for login and scrapes everything.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const URL_FILE = path.join(__dirname, '..', '.community-url');

/** Turn anything the user pastes into https://www.skool.com/<community> (or null). */
function normaliseUrl(input) {
  if (!input) return null;
  let text = String(input).trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) {
    text = text.includes('skool.com') ? `https://${text}` : `https://www.skool.com/${text}`;
  }
  try {
    const url = new URL(text);
    if (!/(^|\.)skool\.com$/i.test(url.hostname)) return null;
    const slug = url.pathname.split('/').filter(Boolean)[0];
    if (!slug || /^your-community/i.test(slug)) return null;
    return `https://www.skool.com/${slug}`;
  } catch {
    return null;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function isInstalled(tool) {
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${tool}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function resolveCommunityUrl() {
  // 1. Passed on the command line
  const fromArg = process.argv.slice(2).map(normaliseUrl).find(Boolean);
  if (fromArg) return fromArg;

  // 2. Saved from a previous run
  if (fs.existsSync(URL_FILE)) {
    const saved = normaliseUrl(fs.readFileSync(URL_FILE, 'utf-8'));
    if (saved) return saved;
  }

  // 3. Set by hand in config.js
  const fromConfig = normaliseUrl(require('./config').communityUrl);
  if (fromConfig) return fromConfig;

  // 4. Ask
  if (!process.stdin.isTTY) {
    console.error('\nNo Skool community set. Run:  npm start -- https://www.skool.com/your-community\n');
    process.exit(1);
  }
  for (;;) {
    const answer = await ask('\nPaste your Skool community link (e.g. https://www.skool.com/my-community): ');
    const url = normaliseUrl(answer);
    if (url) return url;
    console.log('  That does not look like a Skool community link. Try again.');
  }
}

async function start() {
  const url = await resolveCommunityUrl();
  fs.writeFileSync(URL_FILE, url + '\n');
  process.env.SKOOL_COMMUNITY_URL = url;

  const missing = ['yt-dlp', 'ffmpeg', 'whisper'].filter(tool => !isInstalled(tool));
  if (missing.length > 0) {
    process.env.SKOOL_NO_TRANSCRIBE = '1';
    console.log(`\n  Note: video transcription is OFF (not installed: ${missing.join(', ')}).`);
    console.log('  Everything else is still scraped, including the video links.');
    console.log('  To get transcripts, install the tools listed in the README and run again.');
  }

  // Loaded only now, so every file sees the community chosen above.
  require('./index.js');
}

if (require.main === module) {
  start();
}

module.exports = { normaliseUrl };
