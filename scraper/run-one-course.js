/**
 * Run the scraper on a single course by slug.
 * Usage: node scraper/run-one-course.js course-slug-here
 */
const { login } = require('./login');
const { scrapeCourses } = require('./courses');
const progress = require('./utils/progress');
const logger = require('./utils/logger');
const config = require('./config');

const targetSlug = process.argv[2];
if (!targetSlug) {
  console.log('Usage: node scraper/run-one-course.js <course-slug>');
  console.log('Example: node scraper/run-one-course.js sales-fundamentals-course');
  process.exit(1);
}

// Monkey-patch scrapeCourses to only run the target course
const originalScrapeCourses = require('./courses').scrapeCourses;

async function main() {
  console.log('\n' + '═'.repeat(55));
  console.log('  SKOOL SCRAPER — SINGLE COURSE');
  console.log(`  Target: ${targetSlug}`);
  console.log(`  Transcription: ${config.transcribe ? 'ON' : 'OFF'}`);
  console.log('═'.repeat(55) + '\n');

  logger.init();
  const prog = progress.load();

  // Clear progress for this course so it re-scrapes fresh
  delete prog.courses[targetSlug];

  let browser, context, page;

  try {
    const session = await login();
    browser = session.browser;
    context = session.context;
    page = session.page;

    // Navigate to classroom
    const classroomUrl = `${config.communityUrl}/classroom`;
    await page.goto(classroomUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Get all courses from __NEXT_DATA__
    const courses = await page.evaluate(() => {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return [];
      try {
        const data = JSON.parse(script.textContent);
        const allCourses = data?.props?.pageProps?.allCourses || [];
        const titleEls = document.querySelectorAll('[class*="CourseTitle"]');
        const titles = Array.from(titleEls).map(el => el.textContent.trim());

        return allCourses.map((c, i) => ({
          id: c.id,
          nameHash: c.name,
          rootId: c.rootId || c.name,
          title: titles[i] || c.metadata?.title || c.name || `Course ${i + 1}`,
          slug: (titles[i] || c.metadata?.title || c.name || `course-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60),
          numModules: c.metadata?.numModules || 0,
          description: c.metadata?.desc || '',
          state: c.state,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt
        }));
      } catch (e) { return []; }
    });

    // Find the target course
    const course = courses.find(c => c.slug === targetSlug);
    if (!course) {
      console.log(`\n❌ Course "${targetSlug}" not found.`);
      console.log(`\nAvailable courses:`);
      courses.forEach(c => console.log(`  - ${c.slug} (${c.title})`));
      return;
    }

    console.log(`\n📖 Found: ${course.title}`);
    console.log(`   Hash: ${course.nameHash}`);
    console.log(`   Modules: ${course.numModules || '?'}\n`);

    // Import scrapeCourse directly — it's not exported, so we need to
    // replicate the per-course logic from scrapeCourses
    const save = require('./utils/save');
    const rateLimit = require('./utils/rate-limit');
    const { checkAuth } = require('./login');

    // Navigate to the course
    const courseHash = course.nameHash || course.rootId;
    const courseUrl = `${config.communityUrl}/classroom/${courseHash}`;
    await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Verify course loaded
    let courseLoaded = await page.evaluate(() => {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return false;
      try {
        const data = JSON.parse(script.textContent);
        const course = data?.props?.pageProps?.course;
        return course && Array.isArray(course.children) && course.children.length > 0;
      } catch { return false; }
    });

    if (!courseLoaded) {
      console.log('⚠ Direct URL didn\'t load course, trying click from index...');
      await page.goto(`${config.communityUrl}/classroom`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      // Find and click the course
      let clicked = false;
      for (let pageNum = 0; pageNum < 5; pageNum++) {
        clicked = await page.evaluate((title) => {
          const wrappers = document.querySelectorAll('[class*="CourseLinkWrapper"], [class*="CourseWrapper"]');
          for (const w of wrappers) {
            const titleEl = w.querySelector('[class*="CourseTitle"]');
            if (titleEl && titleEl.textContent.trim() === title) {
              w.click();
              return true;
            }
          }
          return false;
        }, course.title);

        if (clicked) break;

        const hasNext = await page.evaluate(() => {
          const nextBtn = document.querySelector('[class*="Pagination"] button:last-child, [aria-label="Next"]');
          if (nextBtn && !nextBtn.disabled) { nextBtn.click(); return true; }
          return false;
        });
        if (!hasNext) break;
        await page.waitForTimeout(3000);
      }

      if (clicked) {
        try { await page.waitForURL(/\/classroom\//, { timeout: 10000 }); } catch {}
        await page.waitForTimeout(3000);
        const newUrl = page.url();
        if (newUrl.includes('/classroom/') && newUrl !== `${config.communityUrl}/classroom`) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(5000);
        }
        courseLoaded = await page.evaluate(() => {
          const script = document.querySelector('script#__NEXT_DATA__');
          if (!script) return false;
          try {
            const data = JSON.parse(script.textContent);
            const c = data?.props?.pageProps?.course;
            return c && Array.isArray(c.children) && c.children.length > 0;
          } catch { return false; }
        });
      }
    }

    if (!courseLoaded) {
      console.log('❌ Could not load course page. Check login and try again.');
      return;
    }

    // Extract lessons
    const lessons = await page.evaluate((hash) => {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return [];
      try {
        const data = JSON.parse(script.textContent);
        const courseObj = data?.props?.pageProps?.course;
        if (!courseObj || !Array.isArray(courseObj.children)) return [];

        const lessons = [];
        for (const mod of courseObj.children) {
          const modInfo = mod.course || {};
          const modTitle = modInfo.metadata?.title || '';
          const modChildren = mod.children || [];

          if (modChildren.length === 0) {
            if (modInfo.id) {
              lessons.push({
                id: modInfo.id, nameHash: modInfo.name || '',
                title: modTitle || `Module ${lessons.length + 1}`,
                moduleTitle: null, href: `/${hash}?md=${modInfo.id}`
              });
            }
            continue;
          }

          for (const lesson of modChildren) {
            const li = lesson.course || {};
            lessons.push({
              id: li.id || '', nameHash: li.name || '',
              title: li.metadata?.title || `Lesson ${lessons.length + 1}`,
              moduleTitle: modTitle,
              href: li.id ? `/${hash}?md=${li.id}` : ''
            });
          }
        }
        return lessons;
      } catch { return []; }
    }, courseHash);

    console.log(`📋 ${lessons.length} lessons found\n`);

    // List all lessons grouped by module
    let currentModule = null;
    lessons.forEach((l, i) => {
      if (l.moduleTitle !== currentModule) {
        currentModule = l.moduleTitle;
        if (currentModule) console.log(`\n  📁 ${currentModule}`);
      }
      console.log(`     ${i + 1}. ${l.title}`);
    });
    console.log('');

    // Now scrape each lesson using the same logic as courses.js scrapeLesson
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const slug = targetSlug;

    const courseData = {
      title: course.title, slug, id: course.id, url: page.url(),
      lessons, totalLessons: lessons.length, scrapedAt: new Date().toISOString()
    };
    save.saveJson(`courses/${slug}`, 'course', courseData);

    let videosFound = 0, transcribed = 0, filesFound = 0, textLessons = 0;

    for (let i = 0; i < lessons.length; i++) {
      const lesson = lessons[i];
      const lessonKey = lesson.id || `lesson-${i + 1}`;

      if (progress.isLessonDone(prog, slug, lessonKey)) {
        console.log(`  ⏭ ${i + 1}. ${lesson.title} (done)`);
        continue;
      }

      console.log(`\n  📝 ${i + 1}/${lessons.length}. ${lesson.title}`);

      // Set up network interception
      const capturedVideos = [];
      const videoRequestHandler = (request) => {
        const url = request.url();
        if (url.includes('player.vimeo.com') || url.includes('vimeo.com/video') || url.includes('vimeo.com/api'))
          capturedVideos.push({ platform: 'vimeo', url });
        if (url.includes('youtube.com/embed') || url.includes('youtube.com/watch') || url.includes('youtu.be'))
          capturedVideos.push({ platform: 'youtube', url });
        if (url.includes('loom.com'))
          capturedVideos.push({ platform: 'loom', url });
      };
      page.on('request', videoRequestHandler);

      // Navigate to lesson
      let navigated = false;
      if (lesson.href) {
        const fullUrl = `${config.communityUrl}/classroom${lesson.href}`;
        try {
          await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          navigated = true;
        } catch (e) {
          console.log(`      ⚠ Direct nav failed: ${e.message}`);
        }
      }

      if (!navigated) {
        console.log(`      ⚠ Could not navigate to lesson`);
        page.removeListener('request', videoRequestHandler);
        continue;
      }

      await page.waitForTimeout(5000);
      await checkAuth(page);

      // Click PlaybackButton for lazy-loaded videos
      const hasVideoPlayer = await page.evaluate(() => {
        return !!document.querySelector('[class*="PlaybackButton"], [class*="VideoWrapper"], [class*="VideoPlayer"]');
      });

      if (hasVideoPlayer) {
        try {
          const playBtn = await page.$('[class*="PlaybackButton"]');
          if (playBtn) {
            await playBtn.click();
          } else {
            const wrapper = await page.$('[class*="VideoWrapper"]');
            if (wrapper) await wrapper.click();
          }
          await page.waitForTimeout(6000);
        } catch {}
      }

      // Extract lesson content
      const lessonData = await page.evaluate((meta) => {
        const data = {
          title: meta.title, module: meta.moduleTitle || '',
          url: window.location.href, content: '', description: '',
          videos: [], videoUrl: null, links: [], files: [], comments: []
        };

        const h1 = document.querySelector('h1');
        if (h1) data.title = h1.textContent.trim();

        // Videos from iframes
        document.querySelectorAll('iframe').forEach(iframe => {
          const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
          if (!src || src.includes('stripe.com')) return;

          let platform = null, videoId = null;
          if (src.includes('vimeo.com')) {
            platform = 'vimeo';
            const m = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
            if (m) videoId = m[1];
          }
          if (src.includes('youtube.com') || src.includes('youtu.be')) {
            platform = 'youtube';
            const m = src.match(/(?:embed\/|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            if (m) videoId = m[1];
          }
          if (src.includes('loom.com')) {
            platform = 'loom';
            const m = src.match(/loom\.com\/(?:share|embed)\/([a-f0-9]+)/);
            if (m) videoId = m[1];
          }

          if (platform) {
            const downloadUrl = platform === 'vimeo' && videoId ? `https://player.vimeo.com/video/${videoId}` :
                               platform === 'youtube' && videoId ? `https://www.youtube.com/watch?v=${videoId}` :
                               platform === 'loom' && videoId ? `https://www.loom.com/share/${videoId}` : src;
            data.videos.push({ platform, videoId, embedUrl: src, downloadUrl });
            if (!data.videoUrl) data.videoUrl = src;
          }
        });

        // Direct video elements
        document.querySelectorAll('video source, video').forEach(v => {
          const src = v.getAttribute('src');
          if (src) {
            data.videos.push({ platform: 'direct', videoId: null, embedUrl: src, downloadUrl: src });
            if (!data.videoUrl) data.videoUrl = src;
          }
        });

        // Main content
        const contentSelectors = [
          '[class*="MainContent"]', '[class*="CourseContent"]',
          '[class*="LessonContent"]', '[class*="lesson-content"]',
          '[class*="PostBody"]', '[class*="post-body"]',
          '.ql-editor', '[class*="RichText"]',
          '[class*="content"]', 'article', 'main'
        ];
        for (const sel of contentSelectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText.trim().length > 30) {
            data.content = el.innerText.trim();
            data.description = data.content.substring(0, 200);
            el.querySelectorAll('a').forEach(a => {
              const href = a.getAttribute('href');
              const text = a.textContent?.trim();
              if (href && !href.startsWith('#') && !href.includes('skool.com')) {
                data.links.push({ url: href, text: text || href });
              }
            });
            break;
          }
        }

        // File attachments — multiple detection strategies
        const fileUrls = new Set();

        // Strategy 1: Standard file links (PDF, Google Docs/Sheets/Drive)
        document.querySelectorAll('a[href*=".pdf"], a[href*="download"], a[href*="drive.google"], a[href*="docs.google"], a[href*="sheets.google"]').forEach(a => {
          const href = a.getAttribute('href');
          if (href && !fileUrls.has(href)) {
            fileUrls.add(href);
            data.files.push({ url: href, name: a.textContent?.trim() || 'file' });
          }
        });

        // Strategy 2: Skool attachment containers — look for resource/file sections
        document.querySelectorAll('[class*="Attachment"], [class*="attachment"], [class*="Resource"], [class*="resource"], [class*="FileCard"], [class*="file-card"]').forEach(el => {
          const link = el.querySelector('a');
          if (link) {
            const href = link.getAttribute('href');
            if (href && !fileUrls.has(href)) {
              fileUrls.add(href);
              data.files.push({ url: href, name: link.textContent?.trim() || el.textContent?.trim() || 'file' });
            }
          } else {
            // Attachment without a direct link — capture the text info
            const text = el.textContent?.trim();
            if (text && text.length > 2 && text.length < 200) {
              data.files.push({ url: null, name: text, note: 'detected-no-link' });
            }
          }
        });

        // Strategy 3: Look for links near "Resources", "Download", "Template" text
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const text = el.textContent?.trim().toLowerCase();
          if (!text) continue;
          if (el.children.length > 5) continue; // skip large containers
          if (text.includes('resource') || text.includes('template') || text.includes('download') || text.includes('worksheet') || text.includes('script')) {
            const nearbyLinks = el.querySelectorAll('a');
            for (const a of nearbyLinks) {
              const href = a.getAttribute('href');
              if (href && !fileUrls.has(href) && !href.includes('skool.com') && !href.includes('#')) {
                fileUrls.add(href);
                data.files.push({ url: href, name: a.textContent?.trim() || 'resource' });
              }
            }
            // Also check for clickable elements that might trigger downloads
            const buttons = el.querySelectorAll('button, [role="button"], [class*="download" i]');
            for (const btn of buttons) {
              const btnText = btn.textContent?.trim();
              if (btnText && btnText.length < 100) {
                data.files.push({ url: null, name: btnText, note: 'button-detected' });
              }
            }
          }
        }

        // Strategy 4: Any Google Docs/Sheets/Drive links anywhere in the page
        document.querySelectorAll('a').forEach(a => {
          const href = a.getAttribute('href') || '';
          if ((href.includes('docs.google.com') || href.includes('sheets.google.com') || href.includes('drive.google.com')) && !fileUrls.has(href)) {
            fileUrls.add(href);
            data.files.push({ url: href, name: a.textContent?.trim() || 'Google Doc' });
          }
        });

        // Strategy 5: Skool PDF/file attachments — icon + link text
        // Skool uses a styled component with an icon (PDF badge) and a clickable link
        document.querySelectorAll('a').forEach(a => {
          const href = a.getAttribute('href') || '';
          if (fileUrls.has(href)) return;
          // Check if this link is near a PDF icon or resource section
          const parent = a.closest('[class*="Attachment"], [class*="attachment"]') ||
                         a.parentElement?.closest('[class*="Resource"], [class*="resource"]') ||
                         a.parentElement;
          if (!parent) return;
          // Check for PDF icon image or SVG near the link
          const hasIcon = parent.querySelector('img[src*="pdf"], img[alt*="pdf"], svg, [class*="icon" i], [class*="Icon"]');
          // Check if the link text suggests a file
          const text = a.textContent?.trim().toLowerCase() || '';
          const isFile = text.includes('template') || text.includes('script') || text.includes('worksheet') ||
                         text.includes('tracker') || text.includes('sheet') || text.includes('guide') ||
                         text.includes('checklist') || text.includes('pdf') || text.includes('download') ||
                         text.includes('book') || text.includes('resource') || text.includes('framework');
          if (href && (hasIcon || isFile) && !href.includes('/classroom')) {
            fileUrls.add(href);
            data.files.push({ url: href, name: a.textContent?.trim() || 'file' });
          }
        });

        // Strategy 6: Skool's specific attachment pattern — clickable elements with file-like names
        // that might use onClick handlers instead of href
        const contentArea = document.querySelector('[class*="MainContent"], [class*="CourseContent"], [class*="LessonContent"], .ql-editor, article, main');
        if (contentArea) {
          const allLinks = contentArea.querySelectorAll('a');
          for (const a of allLinks) {
            const href = a.getAttribute('href') || '';
            if (!href || fileUrls.has(href)) continue;
            // Skool internal file downloads often use /api/ or blob URLs
            if (href.includes('/api/') || href.includes('blob:') || href.includes('storage.googleapis') || href.includes('amazonaws.com') || href.endsWith('.pdf')) {
              fileUrls.add(href);
              data.files.push({ url: href, name: a.textContent?.trim() || 'file' });
            }
          }
        }

        // Comments
        const commentEls = document.querySelectorAll('[class*="comment" i]:not([class*="input" i]):not([class*="form" i])');
        commentEls.forEach(el => {
          const author = el.querySelector('[class*="author" i], [class*="name" i], [class*="user" i]')?.textContent?.trim();
          const text = el.querySelector('[class*="body" i], [class*="text" i], p')?.textContent?.trim();
          const date = el.querySelector('[class*="date" i], [class*="time" i], time')?.textContent?.trim();
          if (text && text.length > 5) {
            data.comments.push({ author: author || 'Unknown', text, date: date || '' });
          }
        });

        return data;
      }, { title: lesson.title, moduleTitle: lesson.moduleTitle });

      page.removeListener('request', videoRequestHandler);

      // Extract video URLs from links found in text body (Loom, YouTube, Vimeo links in content)
      if (lessonData.links && lessonData.links.length > 0) {
        const existingVideoIds = new Set(lessonData.videos.map(v => v.videoId).filter(Boolean));
        for (const link of lessonData.links) {
          const url = link.url || '';
          let platform = null, videoId = null, downloadUrl = null;

          if (url.includes('loom.com/share/') || url.includes('loom.com/embed/')) {
            platform = 'loom';
            const m = url.match(/loom\.com\/(?:share|embed)\/([a-f0-9]+)/);
            if (m) { videoId = m[1]; downloadUrl = `https://www.loom.com/share/${videoId}`; }
          } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
            platform = 'youtube';
            const m = url.match(/(?:embed\/|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            if (m) { videoId = m[1]; downloadUrl = `https://www.youtube.com/watch?v=${videoId}`; }
          } else if (url.includes('vimeo.com')) {
            platform = 'vimeo';
            const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
            if (m) { videoId = m[1]; downloadUrl = `https://player.vimeo.com/video/${videoId}`; }
          }

          if (platform && videoId && !existingVideoIds.has(videoId)) {
            existingVideoIds.add(videoId);
            lessonData.videos.push({
              platform, videoId, embedUrl: url, downloadUrl,
              source: 'text-link'
            });
            console.log(`      🔗 Found ${platform} link in text: ${videoId}`);
          }
        }
      }

      // Merge network-intercepted videos
      if (capturedVideos.length > 0) {
        const existingIds = new Set(lessonData.videos.map(v => v.videoId).filter(Boolean));
        for (const netVideo of capturedVideos) {
          let videoId = null;
          if (netVideo.platform === 'vimeo') {
            const m = netVideo.url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
            if (m) videoId = m[1];
          } else if (netVideo.platform === 'youtube') {
            const m = netVideo.url.match(/(?:embed\/|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            if (m) videoId = m[1];
          }
          if (videoId && !existingIds.has(videoId)) {
            existingIds.add(videoId);
            lessonData.videos.push({
              platform: netVideo.platform, videoId, embedUrl: netVideo.url,
              downloadUrl: netVideo.platform === 'vimeo' ? `https://player.vimeo.com/video/${videoId}` :
                           netVideo.platform === 'youtube' ? `https://www.youtube.com/watch?v=${videoId}` : netVideo.url,
              source: 'network-intercept'
            });
          }
        }
      }

      // Save lesson
      const num = i + 1;
      const paddedNum = String(num).padStart(2, '0');
      const filename = `${paddedNum}-${lessonData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60)}`;

      // Download + transcribe videos
      if (config.transcribe) {
        for (const video of lessonData.videos) {
          if (!video.videoId) continue;
          try {
            const mediaDir = path.join(config.outputDir, 'courses', slug, 'media');
            if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

            const basename = `${filename}-${video.platform}-${video.videoId}`;
            const audioFile = path.join(mediaDir, `${basename}.mp3`);
            const transcriptFile = path.join(mediaDir, `${basename}-transcript.txt`);

            if (fs.existsSync(transcriptFile)) {
              video.transcript = fs.readFileSync(transcriptFile, 'utf-8');
              video.audioFile = audioFile;
              video.transcriptFile = transcriptFile;
              console.log(`      ✓ Already transcribed (${video.transcript.length} chars)`);
              transcribed++;
              continue;
            }

            // Download audio-only
            const tempAudio = path.join(mediaDir, `${basename}-raw.mp4`);
            if (!fs.existsSync(tempAudio) && !fs.existsSync(audioFile)) {
              const dlUrl = video.downloadUrl;
              console.log(`      ⬇ Downloading audio: ${video.platform} [${video.videoId}]...`);
              execSync(
                `yt-dlp --impersonate chrome --referer "https://www.skool.com/" ` +
                `-f "bestaudio" -o "${tempAudio}" "${dlUrl}"`,
                { stdio: 'pipe', timeout: 300000 }
              );
            }

            // Convert to mp3
            if (!fs.existsSync(audioFile) && fs.existsSync(tempAudio)) {
              console.log(`      🔄 Converting to mp3...`);
              execSync(
                `ffmpeg -y -i "${tempAudio}" -vn -acodec libmp3lame -q:a 4 "${audioFile}"`,
                { stdio: 'pipe', timeout: 120000 }
              );
              try { fs.unlinkSync(tempAudio); } catch {}
            }

            if (!fs.existsSync(audioFile)) {
              console.log(`      ⚠ No audio file produced`);
              continue;
            }

            // Transcribe
            const model = config.whisperModel || 'base';
            console.log(`      🎙 Transcribing with Whisper (${model})...`);
            execSync(
              `whisper "${audioFile}" --model ${model} --output_dir "${mediaDir}" --output_format txt --language English`,
              { stdio: 'pipe', timeout: 3600000 }
            );

            const whisperOutput = path.join(mediaDir, `${basename}.txt`);
            if (fs.existsSync(whisperOutput) && whisperOutput !== transcriptFile) {
              fs.renameSync(whisperOutput, transcriptFile);
            }

            if (fs.existsSync(transcriptFile)) {
              video.transcript = fs.readFileSync(transcriptFile, 'utf-8');
              video.audioFile = audioFile;
              video.transcriptFile = transcriptFile;
              console.log(`      ✓ Transcribed — ${video.transcript.length} chars`);
              transcribed++;
            }
          } catch (e) {
            console.log(`      ⚠ Transcription failed for ${video.videoId}: ${e.message}`);
          }
        }
      }

      // Download file attachments
      if (lessonData.files.length > 0) {
        const filesDir = path.join(config.outputDir, 'courses', slug, 'files');
        if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

        for (const file of lessonData.files) {
          if (!file.url) {
            console.log(`      ⚠ Detected resource "${file.name}" but no download link found (${file.note || 'manual check needed'})`);
            continue;
          }
          try {
            const safeName = `${paddedNum}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 80)}`;

            // Handle Google Docs/Sheets — export as PDF
            let downloadUrl = file.url;
            let ext = '';
            if (downloadUrl.includes('docs.google.com/spreadsheets')) {
              // Export Google Sheets as both PDF and CSV
              const sheetId = downloadUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
              if (sheetId) {
                // Download CSV
                const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
                const csvPath = path.join(filesDir, `${safeName}.csv`);
                if (!fs.existsSync(csvPath)) {
                  console.log(`      📥 Exporting Google Sheet as CSV: ${file.name}...`);
                  try {
                    execSync(`curl -L -o "${csvPath}" "${csvUrl}"`, { stdio: 'pipe', timeout: 30000 });
                    console.log(`      ✓ Saved CSV: ${safeName}.csv`);
                    filesFound++;
                  } catch (e) { console.log(`      ⚠ CSV export failed: ${e.message}`); }
                }
                // Download PDF
                const pdfUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=pdf`;
                const pdfPath = path.join(filesDir, `${safeName}.pdf`);
                if (!fs.existsSync(pdfPath)) {
                  console.log(`      📥 Exporting Google Sheet as PDF: ${file.name}...`);
                  try {
                    execSync(`curl -L -o "${pdfPath}" "${pdfUrl}"`, { stdio: 'pipe', timeout: 30000 });
                    console.log(`      ✓ Saved PDF: ${safeName}.pdf`);
                    filesFound++;
                  } catch (e) { console.log(`      ⚠ PDF export failed: ${e.message}`); }
                }
                continue;
              }
            } else if (downloadUrl.includes('docs.google.com/document')) {
              const docId = downloadUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
              if (docId) {
                downloadUrl = `https://docs.google.com/document/d/${docId}/export?format=pdf`;
                ext = '.pdf';
              }
            } else if (downloadUrl.includes('drive.google.com')) {
              const fileId = downloadUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] || downloadUrl.match(/id=([a-zA-Z0-9_-]+)/)?.[1];
              if (fileId) {
                downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
              }
            }

            const filePath = path.join(filesDir, `${safeName}${ext}`);
            if (fs.existsSync(filePath)) {
              console.log(`      ✓ Already downloaded: ${safeName}${ext}`);
              filesFound++;
              continue;
            }
            console.log(`      📥 Downloading: ${file.name}...`);

            // Use curl for external URLs, page.request for same-domain
            if (downloadUrl.startsWith('http')) {
              execSync(`curl -L -o "${filePath}" "${downloadUrl}"`, { stdio: 'pipe', timeout: 60000 });
            } else {
              const response = await page.request.get(downloadUrl);
              const buffer = await response.body();
              fs.writeFileSync(filePath, buffer);
            }

            if (fs.existsSync(filePath)) {
              const size = fs.statSync(filePath).size;
              console.log(`      ✓ Saved: ${safeName}${ext} (${(size / 1024).toFixed(0)} KB)`);
              filesFound++;
            }
          } catch (e) {
            console.log(`      ⚠ Download failed: ${file.name} — ${e.message}`);
          }
        }
      }

      save.saveJson(`courses/${slug}/lessons`, filename, lessonData);
      save.saveMarkdown(`courses/${slug}/lessons`, filename, save.lessonToMarkdown(lessonData));

      // Stats
      if (lessonData.videos.length > 0) videosFound += lessonData.videos.length;
      if (lessonData.content) textLessons++;

      if (lessonData.videos.length > 0) {
        for (const v of lessonData.videos) {
          if (!v.transcript) {
            console.log(`      🎥 ${v.platform} [${v.videoId}]: ${v.downloadUrl.substring(0, 70)}`);
          }
        }
      }
      if (lessonData.files.length > 0) console.log(`      📎 ${lessonData.files.length} file(s)`);
      if (lessonData.content) console.log(`      📄 ${lessonData.content.length} chars text`);

      progress.markLessonDone(prog, slug, lessonKey);
      await rateLimit.wait(page);
    }

    // Summary
    console.log('\n' + '═'.repeat(55));
    console.log('  SINGLE COURSE SCRAPE COMPLETE');
    console.log('═'.repeat(55));
    console.log(`  Course: ${course.title}`);
    console.log(`  Lessons: ${lessons.length}`);
    console.log(`  Videos found: ${videosFound}`);
    console.log(`  Transcribed: ${transcribed}`);
    console.log(`  Files downloaded: ${filesFound}`);
    console.log(`  Text lessons: ${textLessons}`);
    console.log(`  Output: ${config.outputDir}/courses/${slug}/`);
    console.log('═'.repeat(55) + '\n');

  } catch (e) {
    console.error('\n❌ Scrape failed:', e.message);
    console.error('   Run again to resume.\n');
    progress.save(prog);
  } finally {
    if (browser) {
      console.log('  Closing browser...');
      await browser.close();
    }
  }
}

main();
