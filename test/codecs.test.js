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

test('mesh budget: full quality for 1–2 viewers, shared upload and lower resolution beyond', async () => {
  const { meshBudget } = await import('../public/js/rtc.js');
  const cinema = STREAM_PRESETS.cinema; // 1440p, 5 Mbps
  assert.deepEqual(
    [1, 2].map((n) => meshBudget(cinema, n).movieBitrate),
    [5_000_000, 5_000_000],
  );
  const five = meshBudget(cinema, 5);
  assert.equal(five.movieBitrate, 2_000_000, 'two full copies shared by five');
  assert.equal(five.movieHeight, 1080);
  assert.ok(five.movieBitrate * 5 <= cinema.bitrate * 2 + 1, 'total stays near two full copies');
  assert.equal(meshBudget(STREAM_PRESETS.eco, 7).movieBitrate, 1_200_000, 'never below a watchable floor');
  assert.equal(meshBudget(STREAM_PRESETS.max, 7).movieHeight, 720);
  assert.equal(meshBudget(STREAM_PRESETS.eco, 1).movieHeight, 1080, 'never above the preset');

  assert.equal(meshBudget(cinema, 1).cameraBitrate, 1_200_000);
  assert.equal(meshBudget(cinema, 7).cameraBitrate, Math.round(2_400_000 / 7));
  assert.equal(meshBudget(cinema, 7).cameraHeight, 360);
  // The example from the report: Cinema to 5 viewers plus webcams was ~31 Mbps of upload.
  const total = (five.movieBitrate + five.cameraBitrate) * 5;
  assert.ok(total <= 13_000_000, `now about ${(total / 1e6).toFixed(1)} Mbps`);
});

test('a squeezed webcam steps down in resolution before it freezes, and climbs back with headroom', async () => {
  const { cameraHeightFor, cameraStepDown } = await import('../public/js/rtc.js');
  assert.equal(cameraHeightFor(1_000_000, 720), 720);
  assert.equal(cameraHeightFor(500_000, 720), 480);
  assert.equal(cameraHeightFor(250_000, 720), 360);
  assert.equal(cameraHeightFor(90_000, 720), 240, 'starved: a tiny picture keeps moving');
  assert.equal(cameraHeightFor(1_000_000, 480), 480, 'never above the room budget');
  // Back up only with 30% headroom over the step's need (700 kbps for 720p), so it doesn't flap.
  assert.equal(cameraHeightFor(750_000, 720, 480), 480);
  assert.equal(cameraHeightFor(950_000, 720, 480), 720);
  assert.equal(cameraHeightFor(undefined, 720, 360), 360, 'no stat in this browser: leave it');
  assert.deepEqual([720, 480, 360, 240].map(cameraStepDown), [480, 360, 240, 240]);
});
