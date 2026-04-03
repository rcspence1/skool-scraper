const fs = require('fs');
const config = require('../config');

function load() {
  try {
    if (fs.existsSync(config.progressFile)) {
      return JSON.parse(fs.readFileSync(config.progressFile, 'utf-8'));
    }
  } catch (e) {
    console.log('⚠ Could not load progress file, starting fresh');
  }
  return {
    community: config.communitySlug,
    started: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    courses: {},
    posts: { totalFound: 0, scraped: 0, lastPostId: null, completed: [] },
    about: 'pending',
    files: { totalFound: 0, downloaded: 0, completed: [] }
  };
}

function save(progress) {
  progress.lastUpdated = new Date().toISOString();
  fs.writeFileSync(config.progressFile, JSON.stringify(progress, null, 2));
}

function isLessonDone(progress, courseSlug, lessonId) {
  return progress.courses?.[courseSlug]?.lessons?.[lessonId] === 'complete';
}

function markLessonDone(progress, courseSlug, lessonId) {
  if (!progress.courses[courseSlug]) {
    progress.courses[courseSlug] = { status: 'in-progress', lessons: {} };
  }
  progress.courses[courseSlug].lessons[lessonId] = 'complete';
  save(progress);
}

function markCourseDone(progress, courseSlug) {
  if (!progress.courses[courseSlug]) {
    progress.courses[courseSlug] = { status: 'complete', lessons: {} };
  }
  progress.courses[courseSlug].status = 'complete';
  save(progress);
}

function isPostDone(progress, postId) {
  return progress.posts.completed.includes(postId);
}

function markPostDone(progress, postId) {
  if (!progress.posts.completed.includes(postId)) {
    progress.posts.completed.push(postId);
    progress.posts.scraped = progress.posts.completed.length;
  }
  save(progress);
}

module.exports = { load, save, isLessonDone, markLessonDone, markCourseDone, isPostDone, markPostDone };
