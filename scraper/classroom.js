const config = require('./config');
const { scrollToBottom } = require('./utils/scroll');
const rateLimit = require('./utils/rate-limit');
const progress = require('./utils/progress');
const save = require('./utils/save');
const { checkAuth } = require('./login');

/**
 * Scrape all community/classroom posts with full comment threads.
 */
async function scrapeClassroom(page, prog) {
  console.log('\n💬 SCRAPING CLASSROOM POSTS\n');

  // Navigate to community feed
  await page.goto(config.communityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await checkAuth(page);

  // Check for category/filter tabs (Skool communities often have categories)
  const categories = await page.evaluate(() => {
    const cats = [];
    const tabEls = document.querySelectorAll(
      '[class*="category"], [class*="tab"], [class*="filter"], ' +
      'nav a, [role="tab"], [class*="Tag"]'
    );
    tabEls.forEach(el => {
      const text = el.textContent?.trim();
      const href = el.getAttribute('href');
      if (text && text.length < 50 && !cats.find(c => c.name === text)) {
        cats.push({ name: text, href: href || null });
      }
    });
    return cats;
  });

  if (categories.length > 0) {
    console.log(`  Found ${categories.length} categories: ${categories.map(c => c.name).join(', ')}`);
    save.saveJson('posts', 'categories', categories);
  }

  // Scroll to load all posts
  console.log('  Scrolling to load all posts...');
  const scrollCount = await scrollToBottom(page);
  console.log(`  Completed ${scrollCount} scroll(s)`);

  // Extract all post links
  const postLinks = await page.evaluate(() => {
    const links = [];
    const seen = new Set();

    // Skool post links typically contain the community slug and a post ID
    document.querySelectorAll('a').forEach(el => {
      const href = el.getAttribute('href') || '';
      // Match post URLs - they typically look like /community-name/post-id
      if (href.match(/\/[^/]+\/[a-zA-Z0-9]+$/) && !href.includes('/classroom') &&
          !href.includes('/about') && !href.includes('/members') &&
          !href.includes('/settings') && !href.includes('/login')) {
        if (!seen.has(href)) {
          seen.add(href);

          // Try to get preview info
          const card = el.closest('[class*="post"], [class*="Post"], [class*="card"], [class*="Card"], article');
          const title = card?.querySelector('h2, h3, [class*="title"]')?.textContent?.trim();
          const author = card?.querySelector('[class*="author"], [class*="name"], [class*="user"]')?.textContent?.trim();
          const date = card?.querySelector('[class*="date"], [class*="time"], time')?.textContent?.trim();
          const preview = card?.querySelector('[class*="body"], [class*="text"], p')?.textContent?.trim()?.substring(0, 100);

          links.push({ url: href, title, author, date, preview });
        }
      }
    });

    return links;
  });

  console.log(`  Found ${postLinks.length} post(s)\n`);
  prog.posts.totalFound = postLinks.length;
  progress.save(prog);

  save.saveJson('posts', 'index', {
    totalPosts: postLinks.length,
    posts: postLinks,
    scrapedAt: new Date().toISOString()
  });

  // Scrape each post
  for (let i = 0; i < postLinks.length; i++) {
    const post = postLinks[i];
    const postId = post.url.split('/').pop();

    if (progress.isPostDone(prog, postId)) {
      console.log(`  ⏭ ${i + 1}/${postLinks.length} ${post.title || postId} (done)`);
      continue;
    }

    console.log(`  📝 ${i + 1}/${postLinks.length} ${post.title || postId}`);
    await scrapePost(page, post, postId, prog);
    await rateLimit.wait(page);

    // Periodic auth check
    if (i > 0 && i % 20 === 0) {
      await checkAuth(page);
    }
  }

  console.log('\n✓ All classroom posts scraped.\n');
}

async function scrapePost(page, postMeta, postId, prog) {
  const postUrl = postMeta.url.startsWith('http') ? postMeta.url : `https://www.skool.com${postMeta.url}`;

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`    ⚠ Failed to load: ${e.message}`);
    return;
  }

  // Scroll to load all comments
  await scrollToBottom(page, { maxScrolls: 100 });

  // Expand "View replies" buttons if present
  let expandedReplies = 0;
  while (true) {
    const replyBtn = await page.$('button:has-text("reply"), button:has-text("Reply"), button:has-text("replies"), [class*="view-replies"]');
    if (!replyBtn) break;
    try {
      await replyBtn.click();
      await page.waitForTimeout(1500);
      expandedReplies++;
      if (expandedReplies > 50) break; // safety limit
    } catch {
      break;
    }
  }

  // Extract full post data
  const postData = await page.evaluate(() => {
    const data = {
      title: '',
      author: '',
      date: '',
      body: '',
      likes: 0,
      category: '',
      comments: [],
      links: [],
      files: []
    };

    // Title
    const h1 = document.querySelector('h1, [class*="post-title"], [class*="PostTitle"]');
    if (h1) data.title = h1.textContent.trim();

    // Author
    const authorEl = document.querySelector('[class*="author"], [class*="Author"], [class*="poster-name"]');
    if (authorEl) data.author = authorEl.textContent.trim();

    // Date
    const dateEl = document.querySelector('[class*="post-date"], [class*="timestamp"], time, [class*="Date"]');
    if (dateEl) data.date = dateEl.textContent?.trim() || dateEl.getAttribute('datetime') || '';

    // Body
    const bodySelectors = [
      '[class*="post-body"]', '[class*="PostBody"]',
      '[class*="post-content"]', '[class*="PostContent"]',
      '.ql-editor', 'article', '[class*="content"]'
    ];
    for (const sel of bodySelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 10) {
        data.body = el.innerText.trim();

        // Links in body
        el.querySelectorAll('a').forEach(a => {
          const href = a.getAttribute('href');
          if (href && !href.startsWith('#')) {
            data.links.push({ url: href, text: a.textContent?.trim() || href });
          }
        });
        break;
      }
    }

    // Likes/reactions
    const likeEl = document.querySelector('[class*="like-count"], [class*="LikeCount"], [class*="reaction"]');
    if (likeEl) {
      const num = parseInt(likeEl.textContent?.replace(/\D/g, ''));
      if (!isNaN(num)) data.likes = num;
    }

    // Category/tag
    const catEl = document.querySelector('[class*="category"], [class*="tag"], [class*="badge"]');
    if (catEl) data.category = catEl.textContent?.trim();

    // Comments
    const commentContainers = document.querySelectorAll(
      '[class*="comment"]:not([class*="comment-input"]):not([class*="comment-form"]), ' +
      '[class*="Comment"]:not([class*="CommentInput"]):not([class*="CommentForm"])'
    );

    const processedTexts = new Set();
    commentContainers.forEach(el => {
      const text = el.querySelector('[class*="body"], [class*="text"], [class*="content"], p')?.innerText?.trim();
      if (!text || processedTexts.has(text)) return;
      processedTexts.add(text);

      const author = el.querySelector('[class*="author"], [class*="name"], [class*="user"]')?.textContent?.trim() || 'Unknown';
      const date = el.querySelector('[class*="date"], [class*="time"], time')?.textContent?.trim() || '';

      // Check for reply nesting
      const isReply = el.closest('[class*="reply"], [class*="Reply"], [class*="nested"]') !== null;

      if (!isReply) {
        const comment = { author, text, date, replies: [] };

        // Find replies within this comment's container
        const replyEls = el.querySelectorAll('[class*="reply"], [class*="Reply"]');
        replyEls.forEach(r => {
          const rText = r.querySelector('[class*="body"], [class*="text"], p')?.innerText?.trim();
          const rAuthor = r.querySelector('[class*="author"], [class*="name"]')?.textContent?.trim();
          const rDate = r.querySelector('[class*="date"], time')?.textContent?.trim();
          if (rText && !processedTexts.has(rText)) {
            processedTexts.add(rText);
            comment.replies.push({ author: rAuthor || 'Unknown', text: rText, date: rDate || '' });
          }
        });

        data.comments.push(comment);
      }
    });

    // File attachments
    document.querySelectorAll('a[href*=".pdf"], a[href*="download"], a[href*="drive.google"]').forEach(a => {
      data.files.push({ url: a.getAttribute('href'), name: a.textContent?.trim() || 'file' });
    });

    return data;
  });

  // Use metadata as fallback
  postData.title = postData.title || postMeta.title || postId;
  postData.author = postData.author || postMeta.author || 'Unknown';
  postData.date = postData.date || postMeta.date || '';
  postData.id = postId;

  // Save
  save.saveJson('posts', postId, postData);
  save.saveMarkdown('posts', postId, save.postToMarkdown(postData));

  if (postData.comments.length > 0) {
    console.log(`    💬 ${postData.comments.length} comment(s)`);
  }
  if (postData.files.length > 0) {
    console.log(`    📎 ${postData.files.length} file(s)`);
  }

  progress.markPostDone(prog, postId);
}

module.exports = { scrapeClassroom };
