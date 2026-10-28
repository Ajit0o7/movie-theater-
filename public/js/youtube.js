// YouTube support: link parsing + an adapter that makes the IFrame Player API look like the
// subset of HTMLVideoElement the sync engine steers (currentTime, paused, play(), events...).
//
// YouTube's own controls are disabled; a click shield sits over the iframe so every
// play/pause/seek goes through our HUD and therefore through room sync.

const ID = /^[\w-]{11}$/;

/** Returns { videoId, start } for any common YouTube URL form, or null. */
export function parseYouTubeUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let videoId = null;
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, first, second] = url.pathname.split('/');
    if (first === 'watch') videoId = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live', 'v', 'e'].includes(first)) videoId = second;
  }
  if (!videoId || !ID.test(videoId)) return null;
  return { videoId, start: parseStart(url.searchParams.get('t') ?? url.searchParams.get('start')) };
}

function parseStart(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

let apiPromise = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('Could not load the YouTube player. Check your connection or ad blocker.'));
    };
    document.head.append(script);
  });
  return apiPromise;
}

const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

const ERRORS = {
  2: 'That YouTube link is invalid.',
  5: 'This YouTube video can’t be played in an embedded player.',
  100: 'This YouTube video was removed or is private.',
  101: 'The owner of this YouTube video doesn’t allow it to be played on other sites.',
  150: 'The owner of this YouTube video doesn’t allow it to be played on other sites.',
};

export class YouTubeVideo extends EventTarget {
  supportsRateNudge = false;

  constructor(host, videoId) {
    super();
    this.videoId = videoId;
    this.host = host;
    this.yt = null;
    this.ready = false;
    this.state = S.UNSTARTED;
    this.wantPlaying = false;
    this.seekingUntil = 0;
    this.volumeValue = 1;
    this.readySent = false;
    this.durationSent = false;
    this.destroyed = false;

    const mount = document.createElement('div');
    host.replaceChildren(mount);
    this.whenReady = loadApi().then(
      (YT) =>
        new Promise((resolve) => {
          if (this.destroyed) return;
          this.yt = new YT.Player(mount, {
            videoId,
            width: '100%',
            height: '100%',
            host: 'https://www.youtube-nocookie.com',
            playerVars: {
              controls: 0,
              disablekb: 1,
              fs: 0,
              rel: 0,
              iv_load_policy: 3,
              modestbranding: 1,
              playsinline: 1,
              origin: location.origin,
            },
            events: {
              onReady: () => {
                this.ready = true;
                this.yt.setVolume(Math.round(this.volumeValue * 100));
                resolve(this);
                this.#checkMeta();
              },
              onStateChange: (e) => this.#onState(e.data),
              onError: (e) => this.#emit('error', { message: ERRORS[e.data] ?? 'YouTube playback error.' }),
              onPlaybackQualityChange: () => this.#emit('qualitychange'),
            },
          });
        }),
    );
    this.whenReady.catch((err) => this.#emit('error', { message: err.message }));
    this.pollTimer = setInterval(() => this.#checkMeta(), 500);
  }

  get readyState() {
    if (!this.ready) return 0;
    if (this.state === S.BUFFERING || this.seeking) return 2;
    return this.duration > 0 ? 4 : 1;
  }

  get seeking() {
    return performance.now() < this.seekingUntil;
  }

  get currentTime() {
    return this.ready ? this.yt.getCurrentTime() || 0 : 0;
  }

  set currentTime(t) {
    if (!this.ready) return;
    this.seekingUntil = performance.now() + 1200;
    this.yt.seekTo(Math.max(0, t), true);
  }

  get duration() {
    const d = this.ready ? this.yt.getDuration() : 0;
    return d > 0 ? d : NaN;
  }

  get paused() {
    return !this.wantPlaying;
  }

  get playbackRate() {
    return 1;
  }

  set playbackRate(_rate) {
    /* YouTube only supports coarse rates; sync never nudges it */
  }

  get volume() {
    return this.volumeValue;
  }

  set volume(v) {
    this.volumeValue = v;
    if (this.ready) this.yt.setVolume(Math.round(v * 100));
  }

  get buffered() {
    const end = this.ready ? (this.yt.getVideoLoadedFraction() || 0) * (this.duration || 0) : 0;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }

  get title() {
    return this.ready ? this.yt.getVideoData?.()?.title || '' : '';
  }

  get quality() {
    return this.ready ? this.yt.getPlaybackQuality?.() || '' : '';
  }

  /** Resolves when playback actually starts; rejects NotAllowedError when autoplay is blocked. */
  play() {
    this.wantPlaying = true;
    if (!this.ready) return this.whenReady.then(() => this.play());
    this.yt.playVideo();
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        if (!this.wantPlaying || this.state === S.PLAYING || this.state === S.BUFFERING) return resolve();
        if (performance.now() - started > 2500) {
          this.wantPlaying = false;
          return reject(new DOMException('Autoplay was blocked', 'NotAllowedError'));
        }
        setTimeout(check, 150);
      };
      check();
    });
  }

  pause() {
    this.wantPlaying = false;
    if (this.ready) this.yt.pauseVideo();
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pollTimer);
    try {
      this.yt?.destroy();
    } catch {
      /* already gone */
    }
    this.host.replaceChildren();
  }

  #onState(state) {
    this.state = state;
    // seekTo() on a cued video starts playback; keep the room's paused state authoritative.
    if (state === S.PLAYING && !this.wantPlaying) this.yt.pauseVideo();
    if (state === S.PLAYING || state === S.PAUSED) this.seekingUntil = 0;
    if (state === S.ENDED) {
      this.wantPlaying = false;
      this.#emit('ended');
    }
    this.#checkMeta();
  }

  /**
   * Fires 'loadedmetadata' once the player is ready (so sync can seek a late joiner even
   * though YouTube reports no duration until playback starts) and again once the duration
   * becomes known.
   */
  #checkMeta() {
    if (!this.ready) return;
    if (!this.readySent) {
      this.readySent = true;
      this.#emit('loadedmetadata');
    }
    if (!this.durationSent && this.duration > 0) {
      this.durationSent = true;
      this.#emit('loadedmetadata');
    }
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

const QUALITY_LABELS = { highres: '8K', hd2880: '5K', hd2160: '4K', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p' };
export const youtubeQualityLabel = (q) => QUALITY_LABELS[q] ?? '';
