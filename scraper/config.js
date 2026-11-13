const fs = require('fs');
const path = require('path');

// The community is normally chosen by `npm start` (it asks, then remembers it in
// .community-url). You can also hard-code it on the communityUrl line below.
function savedCommunityUrl() {
  if (process.env.SKOOL_COMMUNITY_URL) return process.env.SKOOL_COMMUNITY_URL;
  try {
    const saved = fs.readFileSync(path.join(__dirname, '..', '.community-url'), 'utf-8').trim();
    if (saved) return saved;
  } catch {}
  return null;
}

module.exports = {
  // Your Skool community URL (set automatically by `npm start`)
  communityUrl: savedCommunityUrl() || 'https://www.skool.com/YOUR-COMMUNITY-HERE',

  // Derived paths
  get communitySlug() {
    return this.communityUrl.split('/').pop();
  },

  // Output — automatically uses community name as folder
  get outputDir() {
    return path.join(__dirname, '..', `output-${this.communitySlug}`);
  },
  sessionFile: path.join(__dirname, '..', '.session.json'),
  get progressFile() {
    return path.join(this.outputDir, 'progress.json');
  },

  // Video + Transcription
  // Set transcribe to false to only capture video URLs without downloading
  // (`npm start` switches this off automatically if yt-dlp, ffmpeg or Whisper is missing)
  transcribe: !process.env.SKOOL_NO_TRANSCRIBE,  // download audio + Whisper transcribe during scrape
  whisperModel: 'base',  // tiny | base | small | medium | large

  // Rate limiting (milliseconds)
  delays: {
    min: 2000,       // minimum wait between page loads
    max: 4000,       // maximum wait between page loads
    backoff: 10000,  // wait time when rate-limited
    backoffDuration: 300000  // how long to stay in backoff mode (5 min)
  },

  // Scroll settings
  scroll: {
    waitBetween: 1500,   // ms between scroll attempts
    maxStuck: 3,         // consecutive no-change scrolls before declaring done
    maxScrolls: 500      // safety limit
  },

  // Browser
  browser: {
    headless: false,     // must be false for manual login
    slowMo: 100          // slow down actions slightly for stability
  }
};
