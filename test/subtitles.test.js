import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeCues, cleanCueText, decodeSubtitleBytes, parseSubtitles } from '../public/js/subtitles.js';

test('parses SRT with CRLF, BOM, comma milliseconds and multi-line cues', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there.\r\nSecond line\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\n<i>Whispering</i>\r\n';
  assert.deepEqual(parseSubtitles(srt), [
    { start: 1, end: 3.5, text: 'Hello there.\nSecond line' },
    { start: 62.25, end: 64, text: '<i>Whispering</i>' },
  ]);
});

test('parses WebVTT: header, NOTE/STYLE blocks, cue ids, settings, short timestamps', () => {
  const vtt = `WEBVTT - film

NOTE translated by someone

STYLE
::cue { color: lime }

intro
00:05.5 --> 00:07.000 align:start position:10%
<v Narrator>Long ago…</v>

1:00:00.000 --> 1:00:02.000
Late cue`;
  assert.deepEqual(parseSubtitles(vtt), [
    { start: 5.5, end: 7, text: 'Long ago…' },
    { start: 3600, end: 3602, text: 'Late cue' },
  ]);
});

test('cleans markup: keeps i/b/u, strips fonts, ASS overrides, HTML and decodes entities', () => {
  assert.equal(cleanCueText('{\\an8}<font color="#ff0">Top &amp; yellow</font>'), 'Top & yellow');
  assert.equal(cleanCueText('<B>Bold</B> and <u class="x">under</u>'), '<b>Bold</b> and <u>under</u>');
  assert.equal(cleanCueText('<img src=x onerror=alert(1)>Hi<script>bad()</script>'), 'Hibad()');
  assert.equal(cleanCueText('one<br>two<br/>three'), 'one\ntwo\nthree');
});

test('skips broken cues and sorts out-of-order files', () => {
  const srt = '2\n00:00:05,000 --> 00:00:06,000\nB\n\n1\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:09,000 --> 00:00:08,000\nbackwards\n\n4\nno timing\n';
  assert.deepEqual(parseSubtitles(srt).map((c) => c.text), ['A', 'B']);
});

test('finds the cues showing at a time, including overlapping ones', () => {
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:10,000\nLong\n\n2\n00:00:04,000 --> 00:00:05,000\nShort\n\n3\n00:00:20,000 --> 00:00:21,000\nLater\n');
  const maxLen = 9;
  assert.deepEqual(activeCues(cues, 0.5, maxLen), []);
  assert.deepEqual(activeCues(cues, 4.5, maxLen).map((c) => c.text), ['Long', 'Short']);
  assert.deepEqual(activeCues(cues, 9.99, maxLen).map((c) => c.text), ['Long']);
  assert.deepEqual(activeCues(cues, 15, maxLen), []);
  assert.deepEqual(activeCues(cues, 20.5, maxLen).map((c) => c.text), ['Later']);
});

test('decodes UTF-8, and falls back to Windows-1252 for legacy files', () => {
  assert.equal(decodeSubtitleBytes(new TextEncoder().encode('Café')), 'Café');
  assert.equal(decodeSubtitleBytes(new Uint8Array([0x43, 0x61, 0x66, 0xe9])), 'Café');
});
