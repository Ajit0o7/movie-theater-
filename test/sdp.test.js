import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enableOpusStereo } from '../public/js/rtc.js';

const audio = (mid) => [`m=audio 9 UDP/TLS/RTP/SAVPF 111 63`, `a=mid:${mid}`, 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtpmap:63 red/48000/2'];
const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', ...audio('0'), 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', 'a=rtpmap:96 VP8/90000', ...audio('2'), ''].join('\r\n');

test('stereo is enabled on every audio m-section (mic and movie), video untouched', () => {
  const out = enableOpusStereo(sdp);
  const fmtps = out.match(/a=fmtp:111 [^\r\n]*/g);
  assert.equal(fmtps.length, 2);
  for (const line of fmtps) {
    assert.match(line, /stereo=1/);
    assert.match(line, /sprop-stereo=1/);
    assert.match(line, /maxaveragebitrate=160000/);
    assert.match(line, /minptime=10/);
  }
  assert.ok(out.includes('a=rtpmap:96 VP8/90000'));
  assert.equal(out.split('\r\n').length, sdp.split('\r\n').length, 'no lines lost or added');
});

test('adds an fmtp line when an audio section has none, and is idempotent', () => {
  const bare = sdp.replace(/a=fmtp:111 [^\r\n]*\r\n/g, '');
  const once = enableOpusStereo(bare);
  assert.equal(once.match(/a=fmtp:111 /g).length, 2);
  assert.equal(enableOpusStereo(once), once);
});
