# Skool Scraper

Universal course scraper for any Skool community.

Extracts courses, lessons, video transcripts, PDFs, Google Docs/Sheets, file attachments, community posts, and about pages from any Skool community you have access to. Uses a real browser session (Playwright) with your own login, so it works with any community you're a member of -- including paid/private ones. All transcription happens locally with OpenAI Whisper (no data sent anywhere).

---

## What It Captures

- **Course structure** -- modules and lessons in order
- **Lesson text content** -- full lesson body text
- **Video URLs** -- Vimeo, YouTube, and Loom detection via iframes + network interception
- **Audio download + transcription** -- downloads audio-only via yt-dlp, transcribes locally with Whisper
- **PDF/file attachments** -- Skool-hosted files downloaded via authenticated API
- **Google Sheets** -- exported as CSV
- **Google Docs** -- exported as PDF
- **Loom links** -- detected from lesson resources and text content
- **Community posts** -- full post body, comments, replies, likes, categories
- **About page** -- community description, rules, links, member count
- **Comments on lessons** -- extracted from each lesson page

---

## Prerequisites

Install these before running the scraper. All commands are for macOS.

### 1. Node.js 18+

```bash
brew install node
```

### 2. Playwright

Installed automatically via `npm install`. After that, install the Chromium browser:

```bash
npx playwright install chromium
```

### 3. yt-dlp (optional -- for video audio download)

```bash
brew install yt-dlp
```

### 4. ffmpeg (optional -- for audio conversion)

```bash
brew install ffmpeg
```

### 5. Whisper (optional -- for transcription)

```bash
pip3 install openai-whisper
```

> **Note:** yt-dlp, ffmpeg, and Whisper are only needed if `transcribe` is set to `true` in config.js. If you only want video URLs without downloading/transcribing, set `transcribe: false`.

---

## Quick Start

1. **Clone the repo**

   ```bash
   git clone https://github.com/YOUR-USERNAME/skool-scraper.git
   cd skool-scraper
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Install Chromium for Playwright**

   ```bash
   npx playwright install chromium
   ```

4. **Set your target community**

   Edit `scraper/config.js` and change the `communityUrl`:

   ```js
   communityUrl: 'https://www.skool.com/your-community-here',
   ```

5. **Run the scraper**

   ```bash
   npm run scrape
   ```

6. **Log in** -- A Chrome browser window opens. Log in to your Skool account. The scraper detects login automatically (no need to press Enter or do anything else).

7. **Wait** -- The scraper navigates through every course, lesson, and post automatically. Progress is shown in the terminal.

8. **Output** -- Everything is saved to the `output/` directory.

---

## Configuration

All settings are in `scraper/config.js`:

| Option | Default | Description |
|--------|---------|-------------|
| `communityUrl` | `'https://www.skool.com/your-community-here'` | The Skool community to scrape. Change this to your target. |
| `transcribe` | `true` | Set to `false` to skip video download and transcription (only captures URLs). |
| `whisperModel` | `'base'` | Whisper model size: `tiny` (fastest, least accurate), `base` (good balance), `small`, `medium`, `large` (slowest, most accurate). |
| `delays.min` | `2000` | Minimum delay between page loads (ms). |
| `delays.max` | `4000` | Maximum delay between page loads (ms). |
| `delays.backoff` | `10000` | Wait time when rate-limited (ms). |
| `browser.headless` | `false` | Must be `false` for manual login. Do not change. |
| `browser.slowMo` | `100` | Slow down browser actions (ms). Helps stability. |

---

## Commands

```bash
# Full scrape -- all courses, posts, about page, and files
npm run scrape

# Only courses and lessons
npm run scrape:courses

# Only community posts
npm run scrape:classroom

# Only the about page
npm run scrape:about

# Only file downloads (run after courses/classroom to find files)
npm run scrape:files

# Scrape a single course by slug
npm run scrape:course -- course-slug-here
# or directly:
node scraper/run-one-course.js course-slug-here
```

---

## Output Structure

```
output/
├── courses/
│   └── course-name/
│       ├── course.json              # Course metadata + lesson list
│       ├── lessons/
│       │   ├── 01-lesson-title.json  # Full lesson data (text, videos, files, comments)
│       │   ├── 01-lesson-title.md    # Human-readable markdown with inline transcripts
│       │   └── ...
│       ├── media/
│       │   ├── 01-lesson-title-vimeo-12345.mp3           # Downloaded audio
│       │   ├── 01-lesson-title-vimeo-12345-transcript.txt # Whisper transcript
│       │   └── ...
│       └── files/
│           ├── 01-document-name.pdf   # Downloaded PDFs and exported docs
│           └── ...
├── classroom/
│   └── posts.json
├── about/
│   └── about.json
├── raw/                              # Raw HTML snapshots (for debugging)
├── files/                            # Standalone file downloads
├── scrape-log.txt                    # Timestamped activity log
└── progress.json                     # Resumability tracker
```

---

## How It Works

### Login

Opens a real Chrome browser (never headless). Navigates to `skool.com/login` and waits for you to log in manually. Login is detected automatically by polling the URL every 3 seconds -- when the URL moves away from `/login`, the scraper knows you're authenticated. Session cookies are saved to disk so you only need to log in once. If the session expires mid-scrape, the scraper pauses and waits for you to re-login in the browser window.

### Course Discovery

Navigates to `/classroom` and extracts the course list from Skool's `__NEXT_DATA__` JSON payload (server-side rendered data embedded in a `<script>` tag). This is more reliable than DOM scraping because it contains structured data with course IDs, hashes, and metadata. Falls back to DOM scraping if `__NEXT_DATA__` doesn't contain the expected fields.

### Lesson Extraction

Reads the full course tree from `__NEXT_DATA__` at `pageProps.course.children` (modules) with nested `.children` (lessons). Each lesson has an ID, title, and resource metadata. Navigates to each lesson via direct URL (`/classroom/{courseHash}?md={lessonId}`). If direct navigation fails, falls back to clicking from the classroom index with pagination support.

### Video Capture

Clicks Skool's `PlaybackButton` to trigger lazy-loaded video iframes. Detects Vimeo, YouTube, and Loom via iframe `src` attributes plus network request interception (catches requests to `player.vimeo.com`, `youtube.com/embed`, `loom.com`). Also scans lesson text content for video links. Downloads audio-only via yt-dlp to save disk space.

### Transcription

Uses OpenAI Whisper locally -- no API calls, no data sent anywhere. Audio is converted to MP3 via ffmpeg, then transcribed. Timeout is set to 60 minutes per video to handle long recordings. Transcripts are embedded in the lesson JSON and saved as separate `.txt` files.

### PDF/File Downloads

Skool stores file attachments as resources in `__NEXT_DATA__` metadata, not as standard HTML links. The scraper extracts `file_id` from the metadata, calls `POST api2.skool.com/files/{file_id}/download-url` to get a time-limited signed download URL, then downloads the file. Google Sheets are exported as CSV, Google Docs as PDF, and Google Drive files are downloaded directly.

### Bot Detection Avoidance

- Real Chrome with a standard user agent (not headless, not Puppeteer)
- Randomized 2--5 second delays between every page load and action
- Human-like mouse movement with multiple intermediate steps before clicks
- Human-like scrolling in small increments with randomized pauses
- Single tab, sequential navigation (no parallel requests)
- Auto-pause with 30-second backoff when rate limits (429/403) are detected
- Session persistence via saved cookies

### Resumability

Progress is tracked in `progress.json`. Every completed lesson and post is recorded. If the scraper crashes, gets rate-limited, or you stop it manually, run the same command again and it picks up exactly where it left off. Already-scraped lessons are skipped automatically.

---

## Known Skool Patterns

Technical reference for developers who want to understand or extend the scraper.

**Data extraction:**
- `__NEXT_DATA__` script tag contains `pageProps.allCourses[]` for the course list
- `pageProps.course.children[]` contains modules; each module's `.children[]` contains lessons
- Each item has `.course.id`, `.course.name` (URL hash), `.course.metadata.title`
- Resources are in `metadata.resources` -- a JSON string containing `file_id`/`link` fields

**URL patterns:**
- Lesson URL: `/classroom/{courseHash}?md={lessonId}`
- File download API: `POST api2.skool.com/files/{file_id}/download-url?expire=28800`
- Signed file URLs: `files.skool.com/f/{hash}/{hash}?Expires=...&Signature=...`

**DOM patterns:**
- Videos lazy-loaded behind `PlaybackButton` -- must click to trigger iframe injection
- Styled-components class patterns: `CourseModuleWrapper`, `MenuItemTitle`, `VideoWrapper`, `MainContent`, `ResourceWrapper`, `ResourceLabel`, `CourseLinkWrapper`, `CourseTitle`
- Client-side navigation (React) doesn't update `__NEXT_DATA__` -- a full page reload is needed after clicking into a course to get fresh server-rendered data

---

## Troubleshooting

**"No lessons found"**
The course page may need a reload for `__NEXT_DATA__` to populate with the course tree. The scraper handles this automatically with retry logic (tries direct URL first, then click-from-index with reload). If it still happens, try running the single-course command: `npm run scrape:course -- course-slug`.

**"Whisper timeout"**
Long videos (45+ minutes) can take a while to transcribe. The timeout is set to 60 minutes. If it still fails, try `whisperModel: 'tiny'` in config.js for faster (but less accurate) transcription.

**"Session expired"**
The scraper auto-detects this when the URL redirects to `/login`. It pauses and displays a message telling you to log in again in the browser window. After you log in, it continues automatically and saves the refreshed session.

**"Rate limited"**
The scraper auto-pauses for 30 seconds when it receives a 429 or 403 response. If rate limiting persists, increase the `delays.min` and `delays.max` values in config.js (e.g., `min: 4000, max: 8000`).

**Videos not captured**
Make sure the video actually plays when you click it manually in a normal browser. Some lessons use external embeds or custom players that may need different handling. The scraper captures Vimeo, YouTube, and Loom. Other platforms would need custom support.

**PDFs not downloading**
Skool-hosted files require authentication. The scraper uses your session cookies automatically. External links (Google Docs/Sheets) may require you to be logged into Google in the same browser profile. If a Google Doc is private/restricted, the export will fail.

**"Could not load course page"**
Some communities have many courses and paginate them. The scraper tries up to 5 pages of pagination. If your target course is deeper, try the single-course command with the exact slug.

---

## License

MIT
