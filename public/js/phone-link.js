// The computer's side of a phone pairing: asks the server for the QR code, runs the phone's
// commands with this tab's own controls (so a phone can do exactly what its owner can), keeps
// the phone's screen up to date, and receives the phone's camera over a direct WebRTC link.

const STATE_EVERY_MS = 1000;

export class PhoneLink {
  /**
   * @param {object} o
   * @param {(cmd: string, value: unknown) => void} o.run         a validated command from a phone
   * @param {() => object} o.getState                             the player, for the phones' screens
   * @param {() => RTCIceServer[]} o.getIceServers
   * @param {(track: MediaStreamTrack, facing: string, phoneId: string) => void} o.onCamera
   * @param {(phoneId: string) => void} o.onCameraEnd
   * @param {(facing: string) => void} o.onCameraFacing
   * @param {(phones: number, change: 'joined'|'left'|null) => void} o.onPhones
   */
  constructor(o) {
    Object.assign(this, o);
    this.socket = null;
    this.phones = 0;
    this.cameras = new Map(); // phoneId -> { pc, chain }
    this.timer = null;
    this.soon = null;
  }

  /** Per connection: `on` registers a socket handler that is removed when the session ends. */
  bind(socket, on) {
    this.socket = socket;
    on('remote:status', ({ phones, joined, left }) => {
      this.phones = phones;
      if (left) this.#closeCamera(left);
      this.onPhones(phones, joined ? 'joined' : left ? 'left' : null);
      this.#schedule();
      this.pushSoon();
    });
    on('remote:command', ({ cmd, value }) => {
      this.run(cmd, value);
      this.pushSoon();
    });
    on('remote:signal', ({ from, data }) => this.#onSignal(from, data));
  }

  pair() {
    return new Promise((resolve) => {
      if (!this.socket?.connected) return resolve({ error: 'Not connected to the room.' });
      this.socket.emit('remote:pair', { origin: location.origin }, resolve);
    });
  }

  unpair() {
    for (const id of [...this.cameras.keys()]) this.#closeCamera(id);
    this.socket?.emit('remote:unpair');
    this.phones = 0;
    this.#schedule();
    this.onPhones(0, null);
  }

  /** Sends the player state to the phones now-ish (a command's effect arrives a moment later). */
  pushSoon() {
    if (!this.phones) return;
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.#push(), 250);
  }

  /** The computer turned its camera off: end the phone's camera link and tell the phone. */
  stopCamera(phoneId) {
    this.socket?.emit('remote:signal', { to: phoneId, data: { stop: true } });
    this.#closeCamera(phoneId, { silent: true });
  }

  #schedule() {
    clearInterval(this.timer);
    this.timer = this.phones ? setInterval(() => this.#push(), STATE_EVERY_MS) : null;
  }

  #push() {
    if (this.phones && this.socket?.connected) this.socket.emit('remote:state', this.getState());
  }

  #onSignal(phoneId, data) {
    if (!data || typeof data !== 'object') return;
    if (data.description?.type === 'offer') this.#openCamera(phoneId, data.facing);
    const cam = this.cameras.get(phoneId);
    if (data.stop) return this.#closeCamera(phoneId);
    if (data.facing && !data.description) this.onCameraFacing(data.facing);
    if (!cam) return;
    // In order: a candidate must not overtake the offer it belongs to.
    cam.chain = cam.chain
      .then(async () => {
        if (data.description) {
          await cam.pc.setRemoteDescription(data.description);
          await cam.pc.setLocalDescription(await cam.pc.createAnswer());
          this.socket.emit('remote:signal', { to: phoneId, data: { description: cam.pc.localDescription } });
        } else if (data.candidate) {
          await cam.pc.addIceCandidate(data.candidate).catch(() => {});
        }
      })
      .catch((err) => console.warn('[phone] camera signaling', err));
  }

  #openCamera(phoneId, facing = 'user') {
    this.#closeCamera(phoneId, { silent: true }); // a new offer replaces the old link
    const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
    const cam = { pc, chain: Promise.resolve(), track: null };
    this.cameras.set(phoneId, cam);
    pc.onicecandidate = ({ candidate }) => candidate && this.socket.emit('remote:signal', { to: phoneId, data: { candidate } });
    pc.ontrack = ({ track }) => {
      if (track.kind !== 'video' || this.cameras.get(phoneId) !== cam) return;
      cam.track = track;
      this.onCamera(track, facing, phoneId);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.cameras.get(phoneId) === cam) this.#closeCamera(phoneId);
    };
  }

  #closeCamera(phoneId, { silent = false } = {}) {
    const cam = this.cameras.get(phoneId);
    if (!cam) return;
    this.cameras.delete(phoneId);
    cam.pc.close();
    if (cam.track && !silent) this.onCameraEnd(phoneId);
  }
}
