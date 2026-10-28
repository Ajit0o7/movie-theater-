import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankCodecs } from '../public/js/codecs.js';
import { STREAM_PRESETS } from '../public/js/media.js';

const probe = (mime, { hw = false, smooth = true, supported = true } = {}) => ({ mime, supported, smooth, powerEfficient: hw });
const softwareOnly = [probe('video/AV1'), probe('video/VP9'), probe('video/H264'), probe('video/VP8')];

test('hardware AV1 wins on every preset', () => {
  const probes = [probe('video/AV1', { hw: true }), probe('video/VP9'), probe('video/H264', { hw: true }), probe('video/VP8')];
  for (const preset of Object.values(STREAM_PRESETS)) assert.equal(rankCodecs(probes, preset)[0], 'video/AV1');
});

test('Eco on a software-only machine uses the most efficient codec (AV1, then VP9)', () => {
  assert.deepEqual(rankCodecs(softwareOnly, STREAM_PRESETS.eco).slice(0, 3), ['video/AV1', 'video/VP9', 'video/H264']);
});

test('heavy presets avoid software AV1/VP9 so the encoder keeps up', () => {
  for (const id of ['cinema', 'max', 'smooth']) assert.equal(rankCodecs(softwareOnly, STREAM_PRESETS[id])[0], 'video/H264', id);
});

test('hardware H.264 beats software AV1 at 4K, and hardware VP9 beats it', () => {
  const probes = [probe('video/AV1'), probe('video/VP9', { hw: true }), probe('video/H264', { hw: true }), probe('video/VP8')];
  assert.deepEqual(rankCodecs(probes, STREAM_PRESETS.max).slice(0, 2), ['video/VP9', 'video/H264']);
});

test('unsupported or non-smooth codecs are skipped or demoted', () => {
  const probes = [probe('video/AV1', { supported: false }), probe('video/VP9', { smooth: false }), probe('video/H264'), probe('video/VP8')];
  const order = rankCodecs(probes, STREAM_PRESETS.eco);
  assert.equal(order.includes('video/AV1'), false);
  assert.equal(order[0], 'video/H264');
});

test('cinema presets hold resolution and cap at 30fps; audio is 160 kbps', async () => {
  for (const id of ['eco', 'cinema', 'max']) {
    assert.equal(STREAM_PRESETS[id].degradation, 'maintain-resolution');
    assert.equal(STREAM_PRESETS[id].fps, 30);
  }
  const { MOVIE_AUDIO_BITRATE, MOVIE_JITTER_BUFFER_MS } = await import('../public/js/rtc.js');
  assert.equal(MOVIE_AUDIO_BITRATE, 160_000);
  assert.equal(MOVIE_JITTER_BUFFER_MS, 800);
});
