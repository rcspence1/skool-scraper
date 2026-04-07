const config = require('./config');
const rateLimit = require('./utils/rate-limit');
const progress = require('./utils/progress');
const save = require('./utils/save');
const logger = require('./utils/logger');
const { checkAuth } = require('./login');
const { randomDelay } = require('./utils/stealth');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Scrape all courses from the Classroom.
 * Uses Skool's __NEXT_DATA__ JSON payload for reliable course discovery,
 * then clicks through each course and lesson to extract content.
 */
async function scrapeCourses(page, prog) {
  console.log('\n📚 SCRAPING COURSES (CLASSROOM)\n');

  // Navigate to classroom
  const classroomUrl = `${config.communityUrl}/classroom`;
  await page.goto(classroomUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  await checkAuth(page);
  await save.saveHtml(page, 'classroom-index');

  // STRATEGY 1: Extract course list from __NEXT_DATA__ JSON
  let courses = await extractCoursesFromNextData(page);

  // STRATEGY 2: If __NEXT_DATA__ doesn't have titles, fall back to DOM scraping
  if (courses.length === 0) {
    courses = await extractCoursesFromDOM(page);
  }

  console.log(`  Found ${courses.length} course(s)\n`);
  if (courses.length === 0) {
    console.log('  ⚠ No courses found. The classroom may require different selectors.');
    console.log('  Saving raw HTML for inspection.\n');
    return;
  }

  save.saveJson('courses', 'index', { courses, scrapedAt: new Date().toISOString() });

  // Scrape each course by clicking into it
  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const slug = course.slug || course.id || `course-${i + 1}`;

    if (prog.courses[slug]?.status === 'complete') {
      console.log(`  ⏭ ${i + 1}/${courses.length} ${course.title} (already complete)`);
      continue;
    }

    console.log(`\n  📖 ${i + 1}/${courses.length}: ${course.title}`);
    await scrapeCourse(page, course, slug, i, prog);
    progress.markCourseDone(prog, slug);
    await rateLimit.wait(page);
  }

  console.log('\n✓ All courses scraped.\n');
}

/**
 * Extract course list from Skool's __NEXT_DATA__ JSON payload.
 * This is the most reliable method — Skool embeds all page data in a script tag.
 */
async function extractCoursesFromNextData(page) {
  const courses = await page.evaluate(() => {
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script) return [];

    try {
      const data = JSON.parse(script.textContent);
      const allCourses = data?.props?.pageProps?.allCourses || [];

      // Get course titles from the visible DOM since __NEXT_DATA__ uses hashed names
      const titleEls = document.querySelectorAll('[class*="CourseTitle"]');
      const titles = Array.from(titleEls).map(el => el.textContent.trim());

      return allCourses.map((c, i) => ({
        id: c.id,
        nameHash: c.name,  // short hash used in URLs: /classroom/{nameHash}
        rootId: c.rootId || c.name,
        title: titles[i] || c.metadata?.title || c.name || `Course ${i + 1}`,
        slug: (titles[i] || c.metadata?.title || c.name || `course-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60),
        numModules: c.metadata?.numModules || 0,
        description: c.metadata?.desc || '',
        state: c.state,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }));
    } catch (e) {
      return [];
    }
  });

  return courses;
}

/**
 * Fallback: extract courses from DOM elements
 */
async function extractCoursesFromDOM(page) {
  return await page.evaluate(() => {
    const courses = [];
    const wrappers = document.querySelectorAll('[class*="CourseLinkWrapper"], [class*="CourseWrapper"]');

    wrappers.forEach((wrapper, i) => {
      const titleEl = wrapper.querySelector('[class*="CourseTitle"]');
      const descEl = wrapper.querySelector('[class*="CourseDescription"]');
      const title = titleEl?.textContent?.trim() || `Course ${i + 1}`;

      courses.push({
        id: `dom-${i}`,
        title,
        description: descEl?.textContent?.trim() || '',
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60),
        index: i
      });
    });

    return courses;
  });
}

/**
 * Scrape a single course by navigating directly via URL.
 * Skool URL pattern: /classroom/{nameHash}
 *
 * Skool uses client-side routing — after navigating to /classroom/{hash},
 * we must wait for __NEXT_DATA__ to populate with the course tree.
 * The course data lives at pageProps.course.children (modules) with
 * nested children (lessons).
 */
async function scrapeCourse(page, course, slug, courseIndex, prog) {
  const courseHash = course.nameHash || course.rootId;
  const courseUrl = `${config.communityUrl}/classroom/${courseHash}`;

  // Navigate to the course page via direct URL
  await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Verify we landed on the course page (not the classroom index).
  // Skool should redirect to /classroom/{hash}?md={firstLessonId}
  let courseLoaded = await page.evaluate(() => {
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script) return false;
    try {
      const data = JSON.parse(script.textContent);
      // Course page has pageProps.course with children (modules/lessons)
      const course = data?.props?.pageProps?.course;
      return course && Array.isArray(course.children) && course.children.length > 0;
    } catch { return false; }
  });

  // If direct URL didn't load the course, try clicking from classroom index.
  // The classroom is paginated — we need to scroll/paginate to find the course.
  if (!courseLoaded) {
    console.log(`    ⚠ Direct URL didn't load course page, trying click from index...`);
    await page.goto(`${config.communityUrl}/classroom`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Scroll through pages to find and click the course
    let clicked = false;
    for (let pageNum = 0; pageNum < 5; pageNum++) {
      // Try to find and click the course on the current page
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

      // Try next pagination page
      const hasNext = await page.evaluate(() => {
        const nextBtn = document.querySelector('[class*="Pagination"] button:last-child, [aria-label="Next"]');
        if (nextBtn && !nextBtn.disabled) {
          nextBtn.click();
          return true;
        }
        return false;
      });

      if (!hasNext) break;
      await page.waitForTimeout(3000);
    }

    if (clicked) {
      // Wait for the page URL to change (React client-side navigation)
      try {
        await page.waitForURL(/\/classroom\//, { timeout: 10000 });
      } catch {}
      await page.waitForTimeout(3000);

      // After client-side navigation, __NEXT_DATA__ won't update.
      // Reload the page to get a fresh server-side render with course data.
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
          const course = data?.props?.pageProps?.course;
          return course && Array.isArray(course.children) && course.children.length > 0;
        } catch { return false; }
      });
    }
  }

  await checkAuth(page);
  await save.saveHtml(page, `course-${slug}`);
  logger.visit(page.url());

  // Extract lesson list from __NEXT_DATA__ course tree
  const lessons = await extractLessonsFromPage(page, courseHash);
  console.log(`    ${lessons.length} lesson(s) found`);

  if (lessons.length === 0) {
    console.log(`    ⚠ No lessons found for "${course.title}". Expected ${course.numModules || '?'} modules.`);
    console.log(`    Page URL: ${page.url()}`);
    logger.warn(`0 lessons found for ${course.title} at ${page.url()}`);
  }

  const courseData = {
    title: course.title,
    slug,
    id: course.id,
    url: page.url(),
    lessons,
    totalLessons: lessons.length,
    scrapedAt: new Date().toISOString()
  };
  save.saveJson(`courses/${slug}`, 'course', courseData);

  // Scrape each lesson by clicking through the sidebar
  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i];
    const lessonKey = lesson.id || `lesson-${i + 1}`;

    if (progress.isLessonDone(prog, slug, lessonKey)) {
      console.log(`    ⏭ ${i + 1}. ${lesson.title} (done)`);
      continue;
    }

    console.log(`    📝 ${i + 1}/${lessons.length}. ${lesson.title}`);
    await scrapeLesson(page, lesson, slug, i, prog);
    await rateLimit.wait(page);
  }
}

/**
 * Extract lesson list from the current course page using __NEXT_DATA__.
 *
 * Skool's data structure:
 *   pageProps.course.children[] = modules (sections)
 *     each module.course = { id, name, metadata: { title } }
 *     each module.children[] = lessons
 *       each lesson.course = { id, name, metadata: { title } }
 *
 * Lesson URL: /classroom/{courseHash}?md={lesson.course.id}
 */
async function extractLessonsFromPage(page, courseHash) {
  // Primary: extract from __NEXT_DATA__ course tree
  let lessons = await page.evaluate((hash) => {
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script) return [];

    try {
      const data = JSON.parse(script.textContent);
      const courseObj = data?.props?.pageProps?.course;
      if (!courseObj || !Array.isArray(courseObj.children)) return [];

      const lessons = [];
      const modules = courseObj.children;

      for (const mod of modules) {
        const modInfo = mod.course || {};
        const modTitle = modInfo.metadata?.title || '';
        const modChildren = mod.children || [];

        if (modChildren.length === 0) {
          // Module with no children — it IS the lesson (single-item module)
          if (modInfo.id) {
            let modResources = [];
            try {
              const rawRes = modInfo.metadata?.resources;
              if (typeof rawRes === 'string') modResources = JSON.parse(rawRes);
              else if (Array.isArray(rawRes)) modResources = rawRes;
            } catch {}

            lessons.push({
              id: modInfo.id,
              nameHash: modInfo.name || '',
              title: modTitle || `Module ${lessons.length + 1}`,
              moduleTitle: null,
              href: `/${hash}?md=${modInfo.id}`,
              resources: modResources
            });
          }
          continue;
        }

        // Module with children — each child is a lesson
        for (const lesson of modChildren) {
          const lessonInfo = lesson.course || {};
          const lessonTitle = lessonInfo.metadata?.title || `Lesson ${lessons.length + 1}`;
          const lessonId = lessonInfo.id || '';

          // Parse resources from metadata
          let resources = [];
          try {
            const rawRes = lessonInfo.metadata?.resources;
            if (typeof rawRes === 'string') resources = JSON.parse(rawRes);
            else if (Array.isArray(rawRes)) resources = rawRes;
          } catch {}

          lessons.push({
            id: lessonId,
            nameHash: lessonInfo.name || '',
            title: lessonTitle,
            moduleTitle: modTitle,
            href: lessonId ? `/${hash}?md=${lessonId}` : '',
            resources: resources
          });
        }
      }

      return lessons;
    } catch (e) {
      return [];
    }
  }, courseHash);

  // Fallback: extract from DOM sidebar (MenuItemTitle elements)
  if (lessons.length === 0) {
    lessons = await page.evaluate((hash) => {
      const items = [];
      const seen = new Set();

      // Skool's course sidebar uses MenuItemTitle for lessons, ModuleTitle for sections
      const lessonEls = document.querySelectorAll(
        '[class*="MenuItemTitle"], [class*="MenuItemTitleWrapper"] a, ' +
        'a[href*="/classroom/"][href*="?md="]'
      );

      lessonEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (!text || text.length < 2 || text.length > 200 || seen.has(text)) return;
        seen.add(text);

        // Try to get href from the element or its parent link
        const link = el.closest('a') || el.querySelector('a');
        const href = link?.getAttribute('href') || '';

        // Extract lesson ID from ?md= param
        const mdMatch = href.match(/[?&]md=([a-f0-9]+)/);
        const lessonId = mdMatch ? mdMatch[1] : '';

        // Find parent module title
        const moduleEl = el.closest('[class*="CourseModule"], [class*="ModuleBody"]');
        const moduleTitle = moduleEl?.closest('[class*="CourseModuleWrapper"]')
          ?.querySelector('[class*="ModuleTitle"]')?.textContent?.trim() || '';

        items.push({
          id: lessonId || `dom-lesson-${items.length}`,
          title: text,
          href: href || (lessonId ? `/${hash}?md=${lessonId}` : ''),
          moduleTitle: moduleTitle || null
        });
      });

      return items;
    }, courseHash);
  }

  return lessons;
}

/**
 * Scrape a single lesson by clicking it in the sidebar.
 */
async function scrapeLesson(page, lesson, courseSlug, lessonIndex, prog) {
  // Set up network interception for video URLs (including Skool-native MP4/HLS)
  const capturedVideos = [];
  const videoRequestHandler = (request) => {
    const url = request.url();
    if (url.includes('player.vimeo.com') || url.includes('vimeo.com/video') || url.includes('vimeo.com/api')) {
      capturedVideos.push({ platform: 'vimeo', url });
    }
    if (url.includes('youtube.com/embed') || url.includes('youtube.com/watch') || url.includes('youtu.be')) {
      capturedVideos.push({ platform: 'youtube', url });
    }
    if (url.includes('loom.com')) {
      capturedVideos.push({ platform: 'loom', url });
    }
    // Skool-native HLS streams (Mux via video.skool.com)
    if (url.includes('stream.video.skool.com') && url.includes('.m3u8')) {
      const pbMatch = url.match(/stream\.video\.skool\.com\/([a-zA-Z0-9]+)\.m3u8/);
      capturedVideos.push({
        platform: 'mux',
        url,
        playbackId: pbMatch ? pbMatch[1] : null
      });
    }
    // Direct MP4 downloads from Skool/cloud CDNs
    if (url.includes('.mp4') && !url.includes('favicon') && !url.includes('.js') &&
        !url.includes('thumbnail') && !url.includes('image.video') &&
        (url.includes('skool.com') || url.includes('cloudfront') || url.includes('amazonaws') ||
         url.includes('mux.com') || url.includes('cdn'))) {
      capturedVideos.push({ platform: 'skool-native', url });
    }
  };
  page.on('request', videoRequestHandler);

  let navigated = false;

  // Strategy 1: Direct URL using lesson.href (format: /{courseHash}?md={lessonId})
  if (lesson.href) {
    const fullUrl = `${config.communityUrl}/classroom${lesson.href}`;
    try {
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      navigated = true;
      logger.visit(fullUrl);
    } catch (e) {
      logger.error(`Direct nav failed for ${lesson.title}`, e.message);
    }
  }

  // Strategy 2: Click the lesson in the sidebar
  if (!navigated) {
    try {
      const clicked = await page.evaluate((title) => {
        // Try MenuItemTitle elements first (Skool's sidebar)
        const menuItems = document.querySelectorAll('[class*="MenuItemTitle"]');
        for (const el of menuItems) {
          if (el.textContent?.trim() === title) {
            el.click();
            return true;
          }
        }
        // Fallback: any clickable element
        const allEls = document.querySelectorAll('a, [role="button"]');
        for (const el of allEls) {
          if (el.textContent?.trim() === title) {
            el.click();
            return true;
          }
        }
        return false;
      }, lesson.title);

      if (clicked) {
        navigated = true;
        await page.waitForTimeout(5000);
        logger.visit(page.url());
      }
    } catch (e) {
      logger.error(`Click failed for ${lesson.title}`, e.message);
    }
  }

  if (!navigated) {
    console.log(`      ⚠ Could not navigate to lesson`);
    page.removeListener('request', videoRequestHandler);
    return;
  }

  await page.waitForTimeout(5000);
  await checkAuth(page);

  // Check __NEXT_DATA__ for video metadata on the lesson page
  // Skool stores video data in renderData.video (Mux playback) and
  // renderData.course.children[].children[].course.metadata (videoLink for Vimeo, videoId for Mux)
  const nextDataVideo = await page.evaluate(() => {
    try {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return null;
      const data = JSON.parse(script.textContent);
      const pageProps = data?.props?.pageProps || {};

      // Primary: renderData.video — has playbackId + playbackToken for the CURRENT lesson
      const renderData = pageProps.renderData || {};
      if (renderData.video && renderData.video.playbackId) {
        return {
          type: 'mux',
          playbackId: renderData.video.playbackId,
          playbackToken: renderData.video.playbackToken || null,
          duration: renderData.video.duration || null,
          customDomain: 'video.skool.com'
        };
      }

      // Fallback: check current lesson's metadata for videoLink (Vimeo/YouTube/Loom)
      // The current lesson is identified by the URL's md= parameter
      const urlParams = new URLSearchParams(window.location.search);
      const currentLessonId = urlParams.get('md');
      if (currentLessonId && renderData.course?.children) {
        for (const module of renderData.course.children) {
          for (const lesson of (module.children || [])) {
            const meta = lesson?.course?.metadata || {};
            const lessonId = lesson?.course?.id;
            if (lessonId === currentLessonId || meta.videoId || meta.videoLink) {
              if (meta.videoLink) {
                return { type: 'external', url: meta.videoLink };
              }
              if (meta.videoId) {
                return { type: 'skool-video-id', videoId: meta.videoId };
              }
            }
          }
        }
      }

      // Legacy fallback
      const course = pageProps.course || {};
      const metadata = course.metadata || {};
      if (metadata.videoUrl) return { type: 'external', url: metadata.videoUrl };
      if (metadata.muxPlaybackId) return { type: 'mux', playbackId: metadata.muxPlaybackId };

      return null;
    } catch { return null; }
  });

  if (nextDataVideo) {
    if (nextDataVideo.type === 'mux' && nextDataVideo.playbackId) {
      // Construct the HLS stream URL using Skool's custom domain
      const domain = nextDataVideo.customDomain || 'video.skool.com';
      const tokenParam = nextDataVideo.playbackToken ? `?token=${nextDataVideo.playbackToken}` : '';
      const streamUrl = `https://stream.${domain}/${nextDataVideo.playbackId}.m3u8${tokenParam}`;
      capturedVideos.push({
        platform: 'mux',
        url: streamUrl,
        playbackId: nextDataVideo.playbackId,
        playbackToken: nextDataVideo.playbackToken,
        duration: nextDataVideo.duration
      });
      console.log(`      🎬 Mux video found: playbackId=${nextDataVideo.playbackId.substring(0, 20)}...`);
    } else if (nextDataVideo.type === 'external' && nextDataVideo.url) {
      capturedVideos.push({ platform: 'skool-native', url: nextDataVideo.url });
      console.log(`      🎬 External video found: ${nextDataVideo.url.substring(0, 80)}`);
    }
  }

  // Skool lazy-loads videos behind a PlaybackButton.
  // Click it to trigger the Vimeo/YouTube/Loom iframe OR Skool-native video player.
  // Click play button to trigger video loading (needed for iframe-based and Mux videos)
  const hasVideoPlayer = await page.evaluate(() => {
    return !!document.querySelector('[class*="PlaybackButton"], [class*="MuxThumbnail"], [class*="VideoWrapper"], [class*="VideoPlayer"], [class*="video-player"], video, [class*="MuxPlayer"], [class*="mux-player"]');
  });

  if (hasVideoPlayer) {
    try {
      // Try multiple click targets — MuxThumbnailWrapper is what Skool-native communities use
      const clickTargets = [
        '[class*="PlaybackButton"]',
        '[class*="MuxThumbnailWrapper"]',
        '[class*="MuxThumbnail"]',
        '[class*="VideoWrapper"]',
        '[class*="VideoPlayer"]',
        '[class*="video-player"]',
        '[class*="MuxPlayer"]',
        '[class*="mux-player"]'
      ];
      let clicked = false;
      for (const sel of clickTargets) {
        const el = await page.$(sel);
        if (el) {
          // Use JS click for reliability (Playwright click can timeout on overlays)
          await page.evaluate(s => document.querySelector(s)?.click(), sel);
          clicked = true;
          console.log(`      ▶ Clicked: ${sel}`);
          break;
        }
      }
      // Wait for the video iframe/element to load
      await page.waitForTimeout(8000);

      // After clicking, check for Mux player element with playback-id
      const postClickVideo = await page.evaluate(() => {
        // Check for Mux player (appears after clicking MuxThumbnailWrapper)
        const mux = document.querySelector('mux-player');
        if (mux) {
          const playbackId = mux.getAttribute('playback-id') || mux.getAttribute('data-playback-id');
          const customDomain = mux.getAttribute('custom-domain');
          if (playbackId) {
            return { type: 'mux', playbackId, customDomain };
          }
        }
        // Fallback: check for video elements
        const video = document.querySelector('video');
        if (video) {
          const src = video.getAttribute('src') || video.currentSrc;
          if (src && !src.startsWith('blob:')) return { type: 'direct', url: src };
        }
        return null;
      });

      if (postClickVideo && postClickVideo.type === 'mux') {
        // Only add if we don't already have this playback ID from __NEXT_DATA__
        const alreadyHave = capturedVideos.some(v => v.playbackId === postClickVideo.playbackId);
        if (!alreadyHave) {
          const domain = postClickVideo.customDomain || 'video.skool.com';
          capturedVideos.push({
            platform: 'mux',
            url: `https://stream.${domain}/${postClickVideo.playbackId}.m3u8`,
            playbackId: postClickVideo.playbackId
          });
        }
      } else if (postClickVideo && postClickVideo.type === 'direct') {
        capturedVideos.push({ platform: 'skool-native', url: postClickVideo.url });
      }
    } catch (e) {
      // Non-fatal — video might still be capturable from DOM
    }
  }

  // Extract lesson content
  const lessonData = await page.evaluate((meta) => {
    const data = {
      title: meta.title,
      module: meta.moduleTitle || '',
      url: window.location.href,
      content: '',
      description: '',
      videos: [],
      videoUrl: null,
      links: [],
      files: [],
      comments: []
    };

    // Title from page
    const h1 = document.querySelector('h1');
    if (h1) data.title = h1.textContent.trim();

    // Videos — iframes (loaded after play button click)
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
      if (!src || src.includes('stripe.com')) return;

      let platform = null, videoId = null;
      if (src.includes('vimeo.com')) {
        platform = 'vimeo';
        const match = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
        if (match) videoId = match[1];
      }
      if (src.includes('youtube.com') || src.includes('youtu.be')) {
        platform = 'youtube';
        const match = src.match(/(?:embed\/|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (match) videoId = match[1];
      }
      if (src.includes('loom.com')) {
        platform = 'loom';
        const match = src.match(/loom\.com\/(?:share|embed)\/([a-f0-9]+)/);
        if (match) videoId = match[1];
      }

      if (platform) {
        const downloadUrl = platform === 'vimeo' && videoId ? `https://player.vimeo.com/video/${videoId}` :
                           platform === 'youtube' && videoId ? `https://www.youtube.com/watch?v=${videoId}` :
                           platform === 'loom' && videoId ? `https://www.loom.com/share/${videoId}` : src;
        data.videos.push({ platform, videoId, embedUrl: src, downloadUrl });
        if (!data.videoUrl) data.videoUrl = src;
      }
    });

    // Direct video elements (including Skool-native uploads)
    document.querySelectorAll('video source, video').forEach(v => {
      const src = v.getAttribute('src') || v.currentSrc;
      if (src && !src.startsWith('blob:')) {
        data.videos.push({ platform: 'direct', videoId: null, embedUrl: src, downloadUrl: src });
        if (!data.videoUrl) data.videoUrl = src;
      }
    });

    // Mux player (Skool uses Mux for native video hosting via video.skool.com proxy)
    // Get playback token from __NEXT_DATA__ for authenticated stream access
    let muxPlaybackToken = null;
    try {
      const ndScript = document.querySelector('script#__NEXT_DATA__');
      if (ndScript) {
        const nd = JSON.parse(ndScript.textContent);
        const rv = nd?.props?.pageProps?.renderData?.video;
        if (rv?.playbackToken) muxPlaybackToken = rv.playbackToken;
      }
    } catch {}

    document.querySelectorAll('mux-player, [class*="MuxPlayer"], [class*="mux-player"]').forEach(mux => {
      const playbackId = mux.getAttribute('playback-id') || mux.getAttribute('data-playback-id');
      const customDomain = mux.getAttribute('custom-domain') || 'video.skool.com';
      if (playbackId) {
        const tokenParam = muxPlaybackToken ? `?token=${muxPlaybackToken}` : '';
        const streamUrl = `https://stream.${customDomain}/${playbackId}.m3u8${tokenParam}`;
        data.videos.push({ platform: 'mux', videoId: playbackId, playbackId, embedUrl: streamUrl, downloadUrl: streamUrl });
        if (!data.videoUrl) data.videoUrl = streamUrl;
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

    // File attachments from DOM (links to PDFs, Google Docs, etc.)
    document.querySelectorAll('a[href*=".pdf"], a[href*="download"], a[href*="drive.google"], a[href*="docs.google"]').forEach(a => {
      data.files.push({ url: a.getAttribute('href'), name: a.textContent?.trim() || 'file', source: 'dom-link' });
    });

    // Resources from __NEXT_DATA__ (passed in via meta.resources)
    if (meta.resources && Array.isArray(meta.resources)) {
      for (const res of meta.resources) {
        if (res.file_id || res.fileId) {
          // Skool-hosted file (PDF etc.) — will be downloaded via API after page.evaluate
          data.files.push({
            name: res.title || res.file_name || res.fileName || 'file',
            fileName: res.file_name || res.fileName || '',
            fileId: res.file_id || res.fileId || '',
            contentType: res.file_content_type || res.fileContentType || '',
            source: 'skool-resource'
          });
        } else if (res.link) {
          // External link resource (Google Docs/Sheets, Loom, etc.)
          data.files.push({
            url: res.link,
            name: res.title || 'resource',
            source: 'skool-resource-link'
          });
          // Also add Loom links as downloadable videos
          if (res.link.includes('loom.com')) {
            const loomMatch = res.link.match(/loom\.com\/(?:share|embed)\/([a-f0-9]+)/);
            if (loomMatch) {
              data.videos.push({
                platform: 'loom', videoId: loomMatch[1],
                embedUrl: res.link, downloadUrl: res.link,
                source: 'skool-resource-link'
              });
            }
          }
        }
      }
    }

    // Comments on the lesson
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
  }, { title: lesson.title, moduleTitle: lesson.moduleTitle, resources: lesson.resources || [] });

  // Remove network listener
  page.removeListener('request', videoRequestHandler);

  // Merge network-intercepted videos (Vimeo, YouTube, Loom, Skool-native, Mux)
  if (capturedVideos.length > 0) {
    const existingUrls = new Set(lessonData.videos.map(v => v.downloadUrl || v.embedUrl).filter(Boolean));
    const existingIds = new Set(lessonData.videos.map(v => v.videoId).filter(Boolean));
    for (const netVideo of capturedVideos) {
      let videoId = null;
      let downloadUrl = netVideo.url;
      if (netVideo.platform === 'vimeo') {
        const match = netVideo.url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
        if (match) { videoId = match[1]; downloadUrl = `https://player.vimeo.com/video/${videoId}`; }
      } else if (netVideo.platform === 'youtube') {
        const match = netVideo.url.match(/(?:embed\/|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (match) { videoId = match[1]; downloadUrl = `https://www.youtube.com/watch?v=${videoId}`; }
      } else if (netVideo.platform === 'mux') {
        videoId = netVideo.playbackId || null;
        downloadUrl = netVideo.url; // Full HLS URL with token
      } else if (netVideo.platform === 'skool-native') {
        // Extract a usable ID from URL for dedup
        const muxMatch = netVideo.url.match(/stream\.(?:mux\.com|video\.skool\.com)\/([a-zA-Z0-9]+)/);
        if (muxMatch) { videoId = muxMatch[1]; downloadUrl = netVideo.url; }
        else videoId = netVideo.url.split('/').pop().split('?')[0].split('.')[0];
      }

      // Deduplicate — but upgrade tokenless URLs with tokenful ones
      if (existingUrls.has(netVideo.url) || existingUrls.has(downloadUrl)) continue;
      if (videoId && existingIds.has(videoId)) {
        // If existing entry has no token but new one does, upgrade it
        if (netVideo.platform === 'mux' && downloadUrl.includes('token=')) {
          const existing = lessonData.videos.find(v => v.videoId === videoId || v.playbackId === videoId);
          if (existing && !existing.downloadUrl?.includes('token=')) {
            existing.downloadUrl = downloadUrl;
            existing.embedUrl = netVideo.url;
            existing.playbackToken = netVideo.playbackToken;
          }
        }
        continue;
      }

      if (videoId) existingIds.add(videoId);
      existingUrls.add(downloadUrl);

      lessonData.videos.push({
        platform: netVideo.platform, videoId,
        playbackId: netVideo.playbackId || videoId,
        playbackToken: netVideo.playbackToken || null,
        embedUrl: netVideo.url,
        downloadUrl,
        source: 'network-intercept'
      });
    }
  }

  // Download Skool-hosted resource files (PDFs etc.) via API
  for (const file of lessonData.files) {
    if (file.source === 'skool-resource' && file.fileId) {
      try {
        // Get signed download URL from Skool API
        const resp = await page.request.post(
          `https://api2.skool.com/files/${file.fileId}/download-url?expire=28800`,
          { headers: { 'content-type': 'application/json' } }
        );
        if (resp.ok()) {
          const body = await resp.text();
          // Response might be JSON with url field or plain URL
          let downloadUrl;
          try {
            const json = JSON.parse(body);
            downloadUrl = json.url || json.download_url || json.downloadUrl || body;
          } catch {
            downloadUrl = body.trim().replace(/^"|"$/g, '');
          }
          if (downloadUrl && downloadUrl.startsWith('http')) {
            file.url = downloadUrl;
            console.log(`      📥 Got download URL for "${file.name}": ${downloadUrl.substring(0, 80)}...`);
          }
        } else {
          console.log(`      ⚠ Could not get download URL for "${file.name}" (${resp.status()})`);
        }
      } catch (e) {
        console.log(`      ⚠ Failed to get download URL for "${file.name}": ${e.message}`);
      }
    }
  }

  // Download resource files to disk
  const num = lessonIndex + 1;
  const paddedNum = String(num).padStart(2, '0');
  const filename = `${paddedNum}-${lessonData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60)}`;

  for (const file of lessonData.files) {
    if (!file.url) continue;
    try {
      const filesDir = path.join(config.outputDir, 'courses', courseSlug, 'files');
      if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

      let saveName = file.fileName || file.name || 'file';
      saveName = `${paddedNum}-${saveName.replace(/[^a-zA-Z0-9._-]/g, '-')}`;

      const filePath = path.join(filesDir, saveName);
      if (fs.existsSync(filePath)) {
        console.log(`      📎 "${file.name}" already downloaded`);
        file.localPath = filePath;
        continue;
      }

      if (file.url.includes('docs.google.com/spreadsheets')) {
        // Google Sheets — download as CSV
        const csvUrl = file.url.replace(/\/edit.*$/, '/export?format=csv');
        const csvResp = await page.request.get(csvUrl);
        if (csvResp.ok()) {
          const csvPath = filePath.replace(/\.[^.]+$/, '') + '.csv';
          fs.writeFileSync(csvPath, await csvResp.body());
          file.localPath = csvPath;
          console.log(`      📊 Downloaded Google Sheet "${file.name}" as CSV`);
        }
      } else if (file.url.includes('docs.google.com/document')) {
        // Google Docs — download as PDF
        const pdfUrl = file.url.replace(/\/edit.*$/, '/export?format=pdf');
        const pdfResp = await page.request.get(pdfUrl);
        if (pdfResp.ok()) {
          const pdfPath = filePath.replace(/\.[^.]+$/, '') + '.pdf';
          fs.writeFileSync(pdfPath, await pdfResp.body());
          file.localPath = pdfPath;
          console.log(`      📄 Downloaded Google Doc "${file.name}" as PDF`);
        }
      } else {
        // Direct download (Skool files, external URLs)
        const resp = await page.request.get(file.url);
        if (resp.ok()) {
          fs.writeFileSync(filePath, await resp.body());
          file.localPath = filePath;
          console.log(`      📎 Downloaded "${file.name}" (${(await resp.body()).length} bytes)`);
        }
      }
    } catch (e) {
      console.log(`      ⚠ Failed to download "${file.name}": ${e.message}`);
    }
  }

  // Download audio + transcribe each video (if enabled)
  if (config.transcribe) {
    for (const video of lessonData.videos) {
      if (!video.videoId) continue;
      try {
        const result = downloadAndTranscribe(video, courseSlug, filename);
        if (result) {
          video.audioFile = result.audioFile;
          video.transcriptFile = result.transcriptFile;
          video.transcript = result.transcript;
          console.log(`      🎙 Transcribed ${video.platform} [${video.videoId}] — ${result.transcript.length} chars`);
        }
      } catch (e) {
        console.log(`      ⚠ Transcription failed for ${video.videoId}: ${e.message}`);
        logger.error(`Transcription failed: ${video.videoId}`, e.message);
      }
    }
  }

  save.saveJson(`courses/${courseSlug}/lessons`, filename, lessonData);
  save.saveMarkdown(`courses/${courseSlug}/lessons`, filename, save.lessonToMarkdown(lessonData));
  logger.saved(`courses/${courseSlug}/lessons/${filename}`);

  // Log what we found
  if (lessonData.videos.length > 0) {
    for (const v of lessonData.videos) {
      if (!v.transcript) {
        const idStr = v.videoId ? ` [${v.videoId}]` : '';
        console.log(`      🎥 ${v.platform}${idStr}: ${v.downloadUrl.substring(0, 70)}`);
      }
    }
  }
  if (lessonData.files.length > 0) {
    console.log(`      📎 ${lessonData.files.length} file(s)`);
  }
  if (lessonData.comments.length > 0) {
    console.log(`      💬 ${lessonData.comments.length} comment(s)`);
  }
  if (lessonData.content) {
    console.log(`      📄 ${lessonData.content.length} chars of text content`);
  }

  progress.markLessonDone(prog, courseSlug, lesson.id || `lesson-${num}`);
}

/**
 * Download audio from a video and transcribe with Whisper.
 * Downloads audio-only to save disk space.
 * Returns { audioFile, transcriptFile, transcript } or null on failure.
 */
function downloadAndTranscribe(video, courseSlug, lessonFilename) {
  const mediaDir = path.join(config.outputDir, 'courses', courseSlug, 'media');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

  const videoIdentifier = video.videoId || video.playbackId || 'unknown';
  const basename = `${lessonFilename}-${video.platform}-${videoIdentifier}`;
  const audioFile = path.join(mediaDir, `${basename}.mp3`);
  const transcriptFile = path.join(mediaDir, `${basename}-transcript.txt`);

  // Skip if already transcribed
  if (fs.existsSync(transcriptFile)) {
    const transcript = fs.readFileSync(transcriptFile, 'utf-8');
    return { audioFile, transcriptFile, transcript };
  }

  // Download audio-only
  const tempAudio = path.join(mediaDir, `${basename}-raw.mp4`);
  if (!fs.existsSync(tempAudio) && !fs.existsSync(audioFile)) {
    const dlUrl = video.downloadUrl || `https://player.vimeo.com/video/${video.videoId}`;

    if (video.platform === 'mux') {
      // Mux uses HLS (.m3u8) — yt-dlp handles this natively
      // The stream URL includes a signed token from Skool's __NEXT_DATA__
      try {
        execSync(
          `yt-dlp --no-check-certificates --referer "https://www.skool.com/" ` +
          `-f "bestaudio" -o "${tempAudio}" "${dlUrl}"`,
          { stdio: 'pipe', timeout: 300000 }
        );
      } catch (e) {
        // Fallback: try with ffmpeg directly for HLS streams
        try {
          execSync(
            `ffmpeg -y -i "${dlUrl}" -vn -acodec libmp3lame -q:a 4 "${audioFile}"`,
            { stdio: 'pipe', timeout: 300000 }
          );
        } catch (e2) {
          console.log(`      ⚠ Mux download failed: ${e2.message?.substring(0, 100)}`);
        }
      }
    } else if (video.platform === 'skool-native' || video.platform === 'direct') {
      // Direct MP4 downloads
      try {
        execSync(
          `curl -L -o "${tempAudio}" "${dlUrl}"`,
          { stdio: 'pipe', timeout: 300000 }
        );
      } catch (e) {
        execSync(
          `yt-dlp --impersonate chrome --referer "https://www.skool.com/" ` +
          `-f "bestaudio" -o "${tempAudio}" "${dlUrl}"`,
          { stdio: 'pipe', timeout: 300000 }
        );
      }
    } else {
      execSync(
        `yt-dlp --impersonate chrome --referer "https://www.skool.com/" ` +
        `-f "bestaudio" -o "${tempAudio}" "${dlUrl}"`,
        { stdio: 'pipe', timeout: 300000 }
      );
    }
  }

  // Convert to mp3
  if (!fs.existsSync(audioFile)) {
    const inputFile = fs.existsSync(tempAudio) ? tempAudio : audioFile;
    if (fs.existsSync(tempAudio)) {
      execSync(
        `ffmpeg -y -i "${tempAudio}" -vn -acodec libmp3lame -q:a 4 "${audioFile}"`,
        { stdio: 'pipe', timeout: 120000 }
      );
      // Clean up temp file
      try { fs.unlinkSync(tempAudio); } catch {}
    }
  }

  if (!fs.existsSync(audioFile)) {
    return null;
  }

  // Transcribe with Whisper
  const model = config.whisperModel || 'base';
  execSync(
    `whisper "${audioFile}" --model ${model} --output_dir "${mediaDir}" --output_format txt --language English`,
    { stdio: 'pipe', timeout: 3600000 }
  );

  // Whisper names output after the input file
  const whisperOutput = path.join(mediaDir, `${basename}.txt`);
  if (fs.existsSync(whisperOutput) && whisperOutput !== transcriptFile) {
    fs.renameSync(whisperOutput, transcriptFile);
  }

  if (fs.existsSync(transcriptFile)) {
    const transcript = fs.readFileSync(transcriptFile, 'utf-8');
    return { audioFile, transcriptFile, transcript };
  }

  return null;
}

module.exports = { scrapeCourses };
