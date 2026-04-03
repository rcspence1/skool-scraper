const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Save structured data as JSON
 */
function saveJson(subdir, filename, data) {
  const dir = path.join(config.outputDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename.endsWith('.json') ? filename : `${filename}.json`);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

/**
 * Save content as markdown
 */
function saveMarkdown(subdir, filename, content) {
  const dir = path.join(config.outputDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename.endsWith('.md') ? filename : `${filename}.md`);
  fs.writeFileSync(filepath, content);
  return filepath;
}

/**
 * Save raw HTML snapshot
 */
async function saveHtml(page, name) {
  const dir = path.join(config.outputDir, 'raw');
  fs.mkdirSync(dir, { recursive: true });
  const html = await page.content();
  const filepath = path.join(dir, `${name}.html`);
  fs.writeFileSync(filepath, html);
  return filepath;
}

/**
 * Download a file from a URL
 */
async function downloadFile(page, url, filename) {
  const dir = path.join(config.outputDir, 'files');
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);

  try {
    const response = await page.request.get(url);
    const buffer = await response.body();
    fs.writeFileSync(filepath, buffer);
    console.log(`  📥 Downloaded: ${filename}`);
    return filepath;
  } catch (e) {
    console.log(`  ⚠ Failed to download ${filename}: ${e.message}`);
    return null;
  }
}

/**
 * Convert lesson data to readable markdown
 */
function lessonToMarkdown(lesson) {
  let md = `# ${lesson.title}\n\n`;
  if (lesson.module) md += `**Module:** ${lesson.module}\n\n`;
  if (lesson.description) md += `${lesson.description}\n\n`;

  // Rich video data with transcripts
  if (lesson.videos && lesson.videos.length > 0) {
    md += `## Videos\n\n`;
    lesson.videos.forEach(v => {
      const idStr = v.videoId ? ` (ID: ${v.videoId})` : '';
      md += `- **${v.platform}**${idStr}: ${v.downloadUrl}\n`;
    });
    md += '\n';

    // Include transcripts inline in the markdown
    const transcribed = lesson.videos.filter(v => v.transcript);
    if (transcribed.length > 0) {
      md += `## Transcript\n\n`;
      transcribed.forEach((v, i) => {
        if (transcribed.length > 1) md += `### Video ${i + 1} (${v.platform})\n\n`;
        md += `${v.transcript}\n\n`;
      });
    }
  } else if (lesson.videoUrl) {
    md += `**Video:** ${lesson.videoUrl}\n\n`;
  }

  if (lesson.content) md += `---\n\n${lesson.content}\n\n`;
  if (lesson.links && lesson.links.length > 0) {
    md += `## Links\n\n`;
    lesson.links.forEach(link => { md += `- [${link.text || link.url}](${link.url})\n`; });
    md += '\n';
  }
  if (lesson.files && lesson.files.length > 0) {
    md += `## Attached Files\n\n`;
    lesson.files.forEach(f => { md += `- ${f.name}: ${f.url}\n`; });
    md += '\n';
  }
  md += `---\n*Scraped: ${new Date().toISOString()}*\n`;
  return md;
}

/**
 * Convert a post + comments to readable markdown
 */
function postToMarkdown(post) {
  let md = `# ${post.title || 'Untitled Post'}\n\n`;
  md += `**Author:** ${post.author || 'Unknown'}\n`;
  md += `**Date:** ${post.date || 'Unknown'}\n`;
  if (post.likes) md += `**Likes:** ${post.likes}\n`;
  if (post.category) md += `**Category:** ${post.category}\n`;
  md += `\n---\n\n${post.body || ''}\n\n`;

  if (post.comments && post.comments.length > 0) {
    md += `## Comments (${post.comments.length})\n\n`;
    post.comments.forEach((comment, i) => {
      md += `### ${comment.author || 'Unknown'} — ${comment.date || ''}\n\n`;
      md += `${comment.text || ''}\n\n`;
      if (comment.replies && comment.replies.length > 0) {
        comment.replies.forEach(reply => {
          md += `> **${reply.author || 'Unknown'}** (${reply.date || ''}): ${reply.text || ''}\n\n`;
        });
      }
    });
  }

  md += `---\n*Scraped: ${new Date().toISOString()}*\n`;
  return md;
}

module.exports = { saveJson, saveMarkdown, saveHtml, downloadFile, lessonToMarkdown, postToMarkdown };
