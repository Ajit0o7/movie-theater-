// Media capture. Voice and movie audio use opposite processing:
// voice gets echo cancellation and noise suppression; movie audio gets none of it, in stereo.

export async function getCameraTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
  });
  return stream.getVideoTracks()[0];
}

export async function getMicTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const track = stream.getAudioTracks()[0];
  if (track) track.contentHint = 'speech';
  return track;
}

export function canShareScreen() {
  return Boolean(navigator.mediaDevices?.getDisplayMedia);
}

/**
 * Streaming presets for "Stream a file" and "Share screen".
 *
 * The cinema presets cap capture at 30fps. Film is 24fps and tab capture only emits a frame
 * when the picture changes, so every real movie frame still gets through (a 24fps cap
 * would drop some whenever frame timing wobbles), while 60fps UI animation can't eat into
 * the budget. They use 'maintain-resolution': when bandwidth dips, WebRTC compresses harder
 * or skips a frame but never falls back to a blurry low resolution. Bitrates are caps;
 * congestion control still adapts below them.
 *
 * Smooth (1080p60, 'maintain-framerate') is for content that is really 60fps: sports, games.
 */
export const STREAM_PRESETS = {
  eco: { label: 'Eco', detail: '1080p · 2.5 Mbps', note: 'Slow internet', width: 1920, height: 1080, fps: 30, bitrate: 2_500_000, degradation: 'maintain-resolution' },
  cinema: { label: 'Cinema', detail: '1440p · 5 Mbps', note: 'Good internet', width: 2560, height: 1440, fps: 30, bitrate: 5_000_000, degradation: 'maintain-resolution' },
  max: { label: 'Max', detail: '4K · 10 Mbps', note: 'Fast internet', width: 3840, height: 2160, fps: 30, bitrate: 10_000_000, degradation: 'maintain-resolution' },
  smooth: { label: 'Smooth', detail: '1080p60 · 8 Mbps', note: 'Sports & games', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000, degradation: 'maintain-framerate' },
};
export const DEFAULT_PRESET = 'eco';

function displayVideoConstraints(preset) {
  return {
    width: { ideal: preset.width, max: preset.width },
    height: { ideal: preset.height, max: preset.height },
    frameRate: { ideal: preset.fps, max: preset.fps },
  };
}

/** Re-targets a live screen capture when the quality preset changes mid-share. */
export function applyDisplayPreset(track, preset) {
  return track?.applyConstraints(displayVideoConstraints(preset)).catch(() => {});
}

/** Screen/tab capture (up to 4K60 depending on preset) with unfiltered stereo tab audio. */
export async function captureDisplay(preset = STREAM_PRESETS[DEFAULT_PRESET]) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: displayVideoConstraints(preset),
    audio: {
      autoGainControl: false,
      echoCancellation: false, // keeps the soundtrack from being treated as echo
      noiseSuppression: false, // keeps bass, score and effects intact
      channelCount: 2,
      sampleRate: 48000,
      suppressLocalAudioPlayback: false,
    },
    // Chrome hints: offer tabs first, don't offer this tab (hall of mirrors), allow switching.
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
  });
  const video = stream.getVideoTracks()[0];
  // 'motion', not 'detail': on a screen capture, 'detail' (or no hint) puts Chrome's encoder in
  // screencast mode, which is tuned for slides and gets choppy on film (Google Meet's
  // "Optimize for video clips" switches to 'motion' for the same reason). Resolution is held
  // by the preset's degradationPreference instead.
  if (video) video.contentHint = 'motion';
  const audio = stream.getAudioTracks()[0];
  if (audio) audio.contentHint = 'music';
  return stream;
}

/**
 * Captures a playing <video> element as a MediaStream (used to stream a local file).
 * Firefox's mozCaptureStream silences the element itself, so `needsMonitor` tells the
 * caller to play the captured audio back locally.
 */
export function captureElement(video) {
  if (video.captureStream) return { stream: video.captureStream(), needsMonitor: false };
  if (video.mozCaptureStream) return { stream: video.mozCaptureStream(), needsMonitor: true };
  return null;
}

export function canCaptureElement() {
  const v = document.createElement('video');
  return Boolean(v.captureStream || v.mozCaptureStream);
}

export function resolutionLabel(height) {
  if (!height) return '';
  if (height >= 2000) return '4K';
  if (height >= 1400) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  return `${height}p`;
}
