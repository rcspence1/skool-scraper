# Skool Scraper: instructions for Claude

The user wants to scrape a Skool community they are a member of. Assume they are not a developer. Do the setup for them and explain each step in one plain-English line.

## Sequence

1. Check Node.js 18+ is installed (`node -v`). Install it if missing.
2. Run `npm install` in this folder. This also downloads the Chromium browser.
3. Ask whether they want video transcripts. If yes, make sure `yt-dlp`, `ffmpeg` and `whisper` are installed (see README, Prerequisites). If no, skip this; the scraper turns transcription off by itself when they are missing.
4. Ask for their Skool community link, then run `npm start -- <link>`. Run it in the background or with a long timeout, because a full scrape can take hours.
5. Tell them: a browser window is opening, log in to Skool there, then leave the window alone. Login is detected automatically. Never ask for or handle their Skool password.
6. When it finishes, tell them where the output is (`output-<community>/`) and summarise what was captured from the final summary.

## Rules

- If it stops or errors, run the same command again. It resumes where it left off.
- Do not change `browser.headless` or lower the delays in `scraper/config.js`.
- Community posts are not part of the full run. Only run `npm run scrape:classroom` if the user asks for posts, and tell them it is experimental.
- Only scrape communities the user has access to with their own login.
