# 🎬 4K Virtual Cinema

A zero-install watch-party web app, inspired by [Kosmi](https://app.kosmi.io/) but designed for actually watching movies:

- **Edge-to-edge playback**: the movie fills the viewport. There is no mock room around it, and the controls fade out when you stop moving the mouse. Fullscreen applies to the whole app, so cameras, chat and reactions stay on top.
- **Two-way control**: anyone in the room can play, pause or seek, and the change applies for everyone, with a toast saying who did it.
- **Draggable webcams**: drag a camera anywhere (60fps `translate3d`), switch it between S, M and L, or shrink it to a badge. The tile of whoever is speaking glows. Each viewer's layout is remembered.
- **4K streaming**: screen and tab capture up to 3840×2160 at 60fps. The movie video sender is raised to **20 Mbps** with VP9 preferred and `maintain-resolution`.
- **Separate audio paths**: movie audio is sent as Opus stereo at 510 kbps with echo cancellation, noise suppression and AGC turned **off**. Voice uses its own track with all of those **on**. The mixer has separate Movie and Voice volume sliders.
- **Translucent chat drawer**: it slides over the movie instead of shrinking it, and messages that arrive while it's closed show up as toasts.
- **Floating reactions**: 🍿 ❤️ 😂 👏 😱 🔥 😭 👀 drift up the screen for everyone.
- **Ambilight**: the letterbox bars glow with colours sampled from the edges of the picture.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

Open the page, enter your name and click **Start a theater**, then send the invite link (🔗 chip, top right).

> Browsers allow camera, microphone and screen capture only on `https://` or `localhost`. To use it across the internet, deploy behind HTTPS (see **Deploying**).

## Four ways to watch

| Mode | How it works | Quality | Who can control |
| --- | --- | --- | --- |
| **Video link** | Everyone's player loads the same direct `.mp4`/`.webm` URL | Whatever the file is, true 4K included. Nothing is re-encoded | Everyone |
| **Same file everywhere** | Everyone opens their own copy of the same file. Only play/pause/seek messages are sent | Full original quality, no video over the network | Everyone |
| **Stream a file** | The host's `<video>` is captured (`captureStream()`) and sent over WebRTC | Up to 20 Mbps per viewer | Everyone (guests' clicks drive the host's player) |
| **Share screen / tab** | `getDisplayMedia` at 3840×2160 / 60fps, with stereo tab audio | Up to 20 Mbps per viewer | Live, so there's no seeking |

Tips:
- When sharing, choose a **browser tab** and tick **Share tab audio**. That gives the cleanest audio.
- DRM-protected sites (Netflix, Disney+, etc.) show a black frame in screen capture. This is a browser restriction, not a bug.
- For the best 4K experience, use **Video link** or **Same file everywhere**. They don't depend on the host's upload speed.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / pause (for everyone) |
| `←` `→` / `J` `L` | Seek −10s / +10s |
| `F` | Fullscreen |
| `C` | Chat |
| `M` / `V` | Mic / camera |
| `R`, `1`–`8` | Reaction tray / send reaction |
| `I` | Stream stats (resolution, fps, bitrate, sync drift) |

Double-click a camera to change its size. Double-click the movie to go fullscreen.

## Architecture

```
server/
  index.js     Express + Socket.io: static files, room API, signaling relay, sync, chat
  rooms.js     Pure room state (playback clock, participants, chat), unit-tested
public/
  index.html   Landing page
  room.html    Theater
  js/room.js       Page controller: wires everything together
  js/rtc.js        Mesh WebRTC: perfect negotiation, 4 fixed media slots, bitrate & Opus stereo
  js/sync.js       Two-way sync engine + NTP-style clock offset
  js/cameras.js    Draggable camera tiles, speaking detection
  js/chat.js       Slide-over chat & people list
  js/reactions.js  Floating emoji particles
  js/ambilight.js  Edge colour sampling
  js/media.js      Capture constraints (4K display, voice vs. movie audio)
```

**Sync model.** The server holds the authoritative playback clock as `{ playing, time, serverTime }`. Clients estimate their offset from server time with ping round-trips, extrapolate the expected position, and steer toward it. They seek on large drift and nudge `playbackRate` ±5% on small drift. UI actions are sent as *intents* (`PLAY`/`PAUSE`/`SEEK`) rather than inferred from `<video>` events, so applying a remote change never echoes back to the server.

**Media model.** Each pair of participants shares one `RTCPeerConnection` (a full mesh, capped at 8 people). Local media lives in four slots (`camVideo`, `micAudio`, `movieVideo`, `movieAudio`) grouped into a *camera* stream and a *movie* stream. Toggling the camera or changing the movie uses `replaceTrack()` and doesn't renegotiate. Each client announces its stream IDs over Socket.io, so receivers know which incoming stream is a webcam and which is the movie.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `STUN_URLS` | Google STUN | Comma-separated STUN URLs |
| `TURN_URLS` | — | Comma-separated TURN URLs (needed behind strict NATs/firewalls) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | TURN credentials |

## Deploying

Any Node 18+ host with WebSocket support works (Render, Fly.io, Railway, a VPS behind Caddy or nginx). Serve it over HTTPS. For friends on mobile networks or corporate Wi-Fi, also run a TURN server (for example coturn) and set the `TURN_*` variables, otherwise some peers won't be able to connect.

**Bandwidth:** "Stream a file" and "Share screen" send one copy per viewer from the host, so 3 viewers at 20 Mbps need about 60 Mbps of upload. The browser's congestion control backs off automatically when the link can't keep up.

## Development

```bash
npm run dev    # restart the server on file changes
npm test       # unit tests (room logic) + Socket.io integration tests
```
