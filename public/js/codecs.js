// Movie codec selection: the most efficient codec this device can encode in real time.
//
// Compression efficiency, best first: AV1 ≈ 30% better than VP9, VP9 ≈ 30–40% better than
// H.264. That matters most on slow connections. But an encoder that can't keep up drops
// frames, which looks far worse than extra compression artefacts. So:
//   1. A hardware encoder (powerEfficient) always wins, most efficient first.
//   2. Software AV1/VP9 is used only for light presets (≤ 1080p30); in a mesh it runs once
//      per viewer, so heavier presets would saturate the CPU.
//   3. Otherwise H.264, the cheapest software encoder.

export const EFFICIENCY = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
export const SAFE_DEFAULT_ORDER = ['video/H264', 'video/VP9', 'video/AV1', 'video/VP8'];
const LIGHT_PIXEL_RATE = 1920 * 1080 * 30;

/**
 * Pure ranking policy.
 * @param probes [{ mime, supported, smooth, powerEfficient }]
 * @param preset { width, height, fps }
 * @returns mime types, best first
 */
export function rankCodecs(probes, preset) {
  const light = preset.width * preset.height * preset.fps <= LIGHT_PIXEL_RATE;
  const tier = (p) => {
    if (p.powerEfficient) return 0;
    if (light && p.smooth && p.mime !== 'video/VP8') return 1;
    if (p.mime === 'video/H264') return 2;
    return 3;
  };
  const efficiency = (p) => EFFICIENCY.indexOf(p.mime);
  return probes
    .filter((p) => p.supported)
    .sort((a, b) => tier(a) - tier(b) || efficiency(a) - efficiency(b))
    .map((p) => p.mime);
}

const cache = new Map();

/** Asks the browser which encoders are supported / smooth / hardware for this preset. */
export function probeEncoders(preset) {
  const key = `${preset.width}x${preset.height}@${preset.fps}:${preset.bitrate}`;
  if (!cache.has(key)) cache.set(key, runProbe(preset));
  return cache.get(key);
}

async function runProbe(preset) {
  const available = globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs.map((c) => c.mimeType.toLowerCase()) ?? [];
  return Promise.all(
    EFFICIENCY.map(async (mime) => {
      if (!available.includes(mime.toLowerCase())) return { mime, supported: false };
      try {
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: { contentType: mime, width: preset.width, height: preset.height, bitrate: preset.bitrate, framerate: preset.fps },
        });
        return { mime, supported: info.supported, smooth: info.smooth, powerEfficient: info.powerEfficient };
      } catch {
        // No WebRTC encodingInfo in this browser: assume software, and don't bet on AV1.
        return { mime, supported: true, smooth: mime !== 'video/AV1', powerEfficient: false };
      }
    }),
  );
}

export async function movieCodecOrder(preset) {
  try {
    const order = rankCodecs(await probeEncoders(preset), preset);
    return order.length ? order : SAFE_DEFAULT_ORDER;
  } catch {
    return SAFE_DEFAULT_ORDER;
  }
}
