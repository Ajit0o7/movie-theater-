# 🎬 4K Virtual Cinema

A zero-install watch-party web app, inspired by [Kosmi](https://app.kosmi.io/) but designed for actually watching movies:

- **Edge-to-edge playback**: the movie fills the viewport. There is no mock room around it, and the controls fade out when you stop moving the mouse. Fullscreen applies to the whole app, so cameras, chat and reactions stay on top.
- **Two-way control**: anyone in the room can play, pause or seek, and the change applies for everyone, with a toast saying who did it.
- **Shared, draggable webcams**: drag a camera anywhere (60fps `translate3d`), switch it between S, M and L, or shrink it to a badge, and it moves and resizes the same way **on everyone's screen**. Anyone can arrange anyone's tile, the last change wins, and late joiners see the current layout. Positions are stored as fractions of the free screen space, so a tile left in the bottom-right corner is in the bottom-right corner on every screen, whatever its size. The tile of whoever is speaking glows.
- **YouTube**: paste any YouTube link (`watch`, `youtu.be`, `shorts`, `live`, with `?t=` start times). Everyone plays it in sync through the official embedded player.
- **Sharp on slow internet**: screen/tab capture and file streaming have quality presets: **Eco** 1080p at 2.5 Mbps (the default, works on 2–5 Mbps), **Cinema** 1440p at 5 Mbps, **Max** 4K at 10 Mbps, and **Smooth** 1080p60 for sports and games. The cinema presets never drop resolution. The most efficient codec the device can encode smoothly is chosen automatically (AV1 > VP9 > H.264). Viewers keep an 800 ms buffer that absorbs network hiccups, and movie audio is Opus stereo at 160 kbps.
- **Separate audio paths**: movie audio is sent as Opus stereo at 160 kbps with echo cancellation, noise suppression and AGC turned **off**. Voice uses its own track with all of those **on**. The mixer has separate Movie and Voice volume sliders.
- **Translucent chat drawer**: it slides over the movie instead of shrinking it, and messages that arrive while it's closed show up as toasts.
- **Floating reactions**: 🍿 ❤️ 😂 👏 😱 🔥 😭 👀 drift up the screen for everyone.
- **Ambilight**: the letterbox bars glow with colours sampled from the edges of the picture.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

Open the page, enter your name and click **Start a theater**, then send the invite link (🔗 chip, top right).

## Watching with friends

Browsers allow camera, microphone and screen sharing only on `https://` addresses or on `localhost`. A plain `http://192.168.x.x` link still lets a friend watch and chat, but their camera and mic stay off (the app says so on the join screen).

**Same Wi-Fi.** Start the server in HTTPS mode:

```bash
npm run start:https
```

It prints a link for every network address, such as `https://192.168.1.20:3000`. Send that link to your friends. The certificate is self-signed, so each device shows a warning once: choose **Advanced → Proceed**. The certificate is saved in `.cert/` and covers all of this machine's LAN addresses, so the warning doesn't come back after a restart.

**Different networks (over the internet).** Your `localhost` isn't reachable from outside. Either deploy the server (see **Deploying**) or open a free HTTPS tunnel to it. For example, with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):

```bash
npm start
cloudflared tunnel --url http://localhost:3000   # prints an https://….trycloudflare.com link to share
```

If a friend's camera connects but no video arrives, one of you is behind a strict network. Set up a TURN relay (next section).

### TURN relay (needed for mobile data and strict Wi-Fi)

Video and voice go directly between browsers. Mobile data (carrier-grade NAT), campus, hotel and office networks often block that, and then only a **TURN relay** can connect people. Without one, the app shows "Couldn't connect to …" for those friends. A free relay takes a few minutes to set up. Pick **one** option and set its environment variables (on Render: *Service → Environment*):

| Option | Variables | Notes |
| --- | --- | --- |
| **Cloudflare** (recommended) | `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | In the Cloudflare dashboard, open *Realtime → TURN Server*, create a TURN key, and copy its ID and API token. Has a free monthly allowance. |
| **Metered** or any credentials URL | `TURN_CREDENTIALS_URL` | e.g. `https://<your-app>.metered.live/api/v1/turn/credentials?apiKey=<key>` from the Metered dashboard. Has a free monthly allowance. |
| **Your own server** (coturn) | `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Fixed credentials. |

With Cloudflare or a credentials URL, the server fetches **short-lived** credentials (24 h), caches them and refreshes them before they expire, so your API token never reaches the browser. If the provider is down, people on normal networks still connect directly. The startup log shows which relay is active.

> The provider integrations accept every response shape these APIs are known to return, and are covered by tests with simulated responses. They haven't been tested against the live services from the development environment. If the log says `TURN credentials … failed`, check the key and token.

## Four ways to watch

| Mode | How it works | Quality | Who can control |
| --- | --- | --- | --- |
| **Video link** | Everyone's player loads the same direct `.mp4`/`.webm` URL | Whatever the file is, true 4K included. Nothing is re-encoded | Everyone |
| **YouTube link** | Everyone embeds the same video with YouTube's player. Its controls are hidden so the room HUD is the only remote | YouTube picks the resolution per viewer, up to 4K on large screens | Everyone |
| **Same file everywhere** | Everyone opens their own copy of the same file. Only play/pause/seek messages are sent | Full original quality, no video over the network | Everyone |
| **Stream a file** | The host's `<video>` is captured (`captureStream()`) and sent over WebRTC | Quality preset (Eco 1080p up to Max 4K) | Everyone (guests' clicks drive the host's player) |
| **Share screen / tab** | `getDisplayMedia` at the preset's size, with stereo tab audio | Quality preset (Eco 1080p up to Max 4K) | Live, so there's no seeking |

Tips:
- When sharing, choose a **browser tab** and tick **Share tab audio**. That gives the cleanest audio.
- DRM-protected sites (Netflix, Disney+, etc.) show a black frame in screen capture. This is a browser restriction, not a bug.
- For the best 4K experience, use **Video link** or **Same file everywhere**. They don't depend on the host's upload speed.
- YouTube videos whose owner has disabled embedding can't be played, and YouTube may show ads to each viewer separately. The room re-syncs everyone once an ad ends.

### Picking a quality preset

| Preset | Resolution | Bitrate cap (per viewer) | Use when |
| --- | --- | --- | --- |
| **Eco** (default) | 1080p, film frame rate | 2.5 Mbps | Upload is around 2–5 Mbps |
| **Cinema** | 1440p, film frame rate | 5 Mbps | Good connection |
| **Max** | 4K, film frame rate | 10 Mbps | Fast connection and a hardware encoder |
| **Smooth** | 1080p at 60fps | 8 Mbps | Sports, games, other true 60fps content |

The host uploads one copy per viewer, so with two friends, Eco needs about 5 Mbps of upload. Press **I** while sharing to see the *Upload estimate*, the codec, and whether the encoder is hardware or software. It also suggests Eco when the connection is below the current preset.

**How the cinema presets stay sharp.** They cap capture at 30fps. Film is 24fps, and tab capture only sends a frame when the picture changes, so every real movie frame still gets through and each one gets the whole bit budget. They also use `maintain-resolution`: when bandwidth dips, WebRTC compresses a little harder instead of falling back to a blurry 360p. The video track is still hinted as `motion`. A `detail` hint would switch Chrome's encoder into screencast mode, which is built for slides and gets choppy on film.

**Codec choice.** The browser is asked (`mediaCapabilities`) what it can encode. A hardware AV1, VP9 or H.264 encoder always wins, most efficient first. Without one, Eco uses software AV1 (about 50% fewer bits than H.264 for the same picture), while the heavier presets use H.264 so the CPU keeps up. The codec is pinned on the sender, AV1/VP9 get L1T2 temporal layers for loss resilience, and switching presets mid-share re-picks the codec without interrupting it.

### If a share or stream stutters

1. Pick **Eco**. It can be changed during a share.
2. Press **I**. *Encoder … (software)* together with a heavy preset means the CPU can't keep up: use Eco, or enable hardware acceleration in the browser settings. *Dropped / freezes* rising on a viewer points to their network or decoder.
3. With 3 or more viewers, stay on Eco, or have everyone use *Video link* or *Same file everywhere*, which send no video from the host.

## Limits, and what the app does about them

Some limits come from browsers or networks and can't be removed by a web app. The app detects each one and tells people what to do, instead of failing silently.

| Situation | Why | What the app does |
| --- | --- | --- |
| Friends on mobile data, campus, hotel or office Wi-Fi can't connect | These networks block direct browser-to-browser connections | Uses a TURN relay when one is configured (see **TURN relay**); otherwise explains the cause in the error message. |
| Streaming a file or screen to many people stutters | Every viewer gets a separate copy from the host's upload and CPU (peer-to-peer mesh) | Each viewer's share shrinks as the room grows (for example, Cinema to 5 people uses about 10 Mbps instead of 25), and so do webcams. The host gets a warning from 3 viewers up. For big groups, *Video link* and *Same file everywhere* send no video from the host. A media server (SFU) would remove the limit, but it's a separate service this app doesn't include. |
| A file plays silently or without a picture | Browsers can't decode Dolby (AC-3/E-AC-3), DTS and often HEVC | Detects it a few seconds in and shows a one-line `ffmpeg` fix: `ffmpeg -i in.mkv -c:v copy -c:a aac -b:a 192k out.mp4` for the audio, or re-encode with `-c:v libx264` for HEVC. |
| Safari can't *Stream a file* | WebKit has no `captureStream()` | Says so and suggests *Same file everywhere*, or hosting from Chrome, Edge or Firefox. |
| No screen sharing on phones | Mobile browsers don't support screen capture | The option is hidden on phones. |
| Volume sliders do nothing on iPhone/iPad | iOS ignores media volume; only the side buttons change it | The sliders still mute at 0, and the mixer explains this. |
| The host's Wi-Fi drops or laptop sleeps | The connection breaks | A *Stream a file* or *Share screen* source is kept for 60 seconds. When the same tab reconnects, the stream resumes for everyone. Closing the tab still ends it straight away. |
| Shared screen or window has no sound | Browsers only share sound from a tab (or the whole screen on Windows) | Explains which to share. |
| Netflix, Disney+ and similar show black when shared | DRM blocks capture | Noted on the *Share screen* card. |
| A YouTube video won't embed, or YouTube is blocked | The owner disabled embedding, or an ad blocker blocks `youtube.com` | Specific messages for each; for blocked embeds, suggests sharing a YouTube tab. |
| A pasted link doesn't play | An `http://` link on an `https://` site, a share page instead of a file, or a host without seeking support | Refuses `http://` on `https://` with the https version suggested, converts Dropbox share links, explains Google Drive/OneDrive/MEGA, and warns when seeking won't work. |
| A viewer's internet is slower than the video (for example 0.7 Mbps for a 1.1 Mbps file) | It can't download fast enough to play in real time; no sync trick changes that | Detects it after about 20 s of watching (30% or more of the time spent buffering), stops wasting downloaded video on frequent jumps (one catch-up every 20 s instead of every 4 s), and tells that viewer and the rest of the room why. In a test this cut buffering time by about a third. A smaller file, or *Same file everywhere*, is the real fix. |
| A Bluetooth headset dies mid-call | The mic track ends | Switches to the system's default mic (or turns the mic off) and says so. |

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
  js/codecs.js     Picks AV1/VP9/H.264 from what the device encodes smoothly (unit-tested policy)
  js/youtube.js    YouTube link parsing + IFrame API adapter that looks like a <video> to sync
  js/ambilight.js  Glow from a tiny stretched canvas (no pixel readback, no blur filter)
  js/media.js      Capture constraints (4K display, voice vs. movie audio)
```

**Sync model.** The server holds the authoritative playback clock as `{ playing, time, serverTime }`. Clients estimate their offset from server time with ping round-trips, extrapolate the expected position, and steer toward it. Under 0.25 s of drift is ignored. Up to 1.5 s is closed by nudging `playbackRate` ±5%. Beyond that, a viewer who is *behind* jumps ahead (aiming past the target by their measured seek delay, never past the end). A viewer who is *ahead* pauses for the gap instead of seeking back, which would discard buffered video. UI actions are sent as *intents* (`PLAY`/`PAUSE`/`SEEK`) rather than inferred from `<video>` events, so applying a remote change never echoes back to the server.

**Media model.** Each pair of participants shares one `RTCPeerConnection` (a full mesh, capped at 8 people). Local media lives in four slots (`camVideo`, `micAudio`, `movieVideo`, `movieAudio`) grouped into a *camera* stream and a *movie* stream. Toggling the camera or changing the movie uses `replaceTrack()` and doesn't renegotiate. Each client announces its stream IDs over Socket.io, so receivers know which incoming stream is a webcam and which is the movie.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` or `--port` | `3000` | HTTP port. Portable form: `npm start -- --port 3001`. In PowerShell: `$env:PORT=3001; npm start` |
| `STUN_URLS` | Google STUN | Comma-separated STUN URLs |
| `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_API_TOKEN` | — | TURN relay through Cloudflare, with short-lived credentials (see **TURN relay**) |
| `TURN_CREDENTIALS_URL` | — | URL returning ICE servers as JSON (e.g. Metered) |
| `TURN_URLS` | — | Comma-separated fixed TURN URLs (e.g. your own coturn) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | Credentials for `TURN_URLS` |
| `HOST` | `0.0.0.0` | Interface to listen on |

## Deploying

Any Node 18+ host with WebSocket support works (Render, Fly.io, Railway, a VPS behind Caddy or nginx). Serve it over HTTPS. For friends on mobile networks or corporate Wi-Fi, configure a TURN relay (see **TURN relay**), otherwise some people won't be able to connect.

**Bandwidth:** "Stream a file" and "Share screen" send one copy per viewer from the host, so 3 viewers on Eco (2.5 Mbps) need about 7.5 Mbps of upload, or 30 Mbps on Max. The browser's congestion control backs off automatically when the link can't keep up.

## Development

```bash
npm run dev    # restart the server on file changes
npm test       # unit tests (room logic) + Socket.io integration tests
```
