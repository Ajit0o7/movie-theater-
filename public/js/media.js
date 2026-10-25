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

/** 4K / 60fps capture with unfiltered stereo tab audio. */
export async function capture4KDisplay() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: 3840, max: 3840 },
      height: { ideal: 2160, max: 2160 },
      frameRate: { ideal: 60, max: 60 },
    },
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
