import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseYouTubeUrl } from '../public/js/youtube.js';

test('parses every common YouTube link form', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PL123&index=2`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abcdef`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) {
    assert.equal(parseYouTubeUrl(url)?.videoId, id, url);
  }
});

test('reads start times', () => {
  assert.equal(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=90').start, 90);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s').start, 3723);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').start, 0);
});

test('rejects non-YouTube and malformed links', () => {
  assert.equal(parseYouTubeUrl('https://example.com/movie.mp4'), null);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=short'), null);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/@channel'), null);
  assert.equal(parseYouTubeUrl('not a url'), null);
  assert.equal(parseYouTubeUrl('https://evil.com/watch?v=dQw4w9WgXcQ'), null);
});
