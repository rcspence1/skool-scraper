const path = require('path');

module.exports = {
  // UPDATE THIS with your Skool community URL
  communityUrl: 'https://www.skool.com/your-community-here',

  // Derived paths
  get communitySlug() {
    return this.communityUrl.split('/').pop();
  },

  // Output
  outputDir: path.join(__dirname, '..', 'output'),
  sessionFile: path.join(__dirname, '..', 'output', '.session.json'),
  progressFile: path.join(__dirname, '..', 'output', 'progress.json'),

  // Video + Transcription
  // Set transcribe to false to only capture video URLs without downloading
  transcribe: true,      // download audio + Whisper transcribe during scrape
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
