import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVideoLink } from '../public/js/links.js';

test('plain https video links pass through unchanged', () => {
  assert.deepEqual(checkVideoLink(' https://cdn.example.com/movie.mp4 ', 'https:'), { url: 'https://cdn.example.com/movie.mp4' });
});

test('http links are refused on an https site (mixed content) with the https version suggested', () => {
  const r = checkVideoLink('http://files.example.com/a.mp4', 'https:');
  assert.match(r.error, /https:\/\/files\.example\.com\/a\.mp4/);
  assert.deepEqual(checkVideoLink('http://files.example.com/a.mp4', 'http:'), { url: 'http://files.example.com/a.mp4' }, 'fine on a local http server');
});

test('Dropbox share links become direct links', () => {
  const r = checkVideoLink('https://www.dropbox.com/scl/fi/abc123/movie.mp4?rlkey=xyz&dl=0', 'https:');
  assert.equal(r.url, 'https://www.dropbox.com/scl/fi/abc123/movie.mp4?rlkey=xyz&raw=1');
  assert.match(r.note, /Dropbox/);
  assert.equal(checkVideoLink('https://dropbox.com/s/k3y/film.mkv?dl=1', 'https:').url, 'https://dropbox.com/s/k3y/film.mkv?raw=1');
});

test('Google Drive, OneDrive and MEGA share pages get an explanation instead of a black screen', () => {
  for (const link of ['https://drive.google.com/file/d/1AbC/view?usp=sharing', 'https://1drv.ms/v/s!abc', 'https://mega.nz/file/xyz']) {
    assert.ok(checkVideoLink(link, 'https:').error, link);
  }
});

test('junk input is rejected clearly', () => {
  assert.match(checkVideoLink('not a link', 'https:').error, /valid link/);
  assert.match(checkVideoLink('ftp://x/y.mp4', 'https:').error, /http/);
});
