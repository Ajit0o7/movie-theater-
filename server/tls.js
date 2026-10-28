// Self-signed HTTPS for LAN use. Browsers only allow camera, microphone and screen capture
// on https:// or localhost, so a friend opening http://192.168.x.x would get none of them.
//
// The certificate covers localhost and every LAN IPv4 address of this machine. It is cached
// in .cert/ so the "proceed anyway" exception the browser remembers keeps working across
// restarts, and regenerated only when the machine's addresses change or it nears expiry.

import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID_DAYS = 365;
const RENEW_BEFORE_MS = 14 * 24 * 60 * 60 * 1000;

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function covers(certPem, hosts) {
  try {
    const cert = new X509Certificate(certPem);
    if (new Date(cert.validTo).getTime() - Date.now() < RENEW_BEFORE_MS) return false;
    // Exact entries: a substring test would let "IP Address:192.168.1.2" match ".20".
    const san = new Set((cert.subjectAltName ?? '').split(/,\s*/));
    return hosts.every((h) => san.has(/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP Address:${h}` : `DNS:${h}`));
  } catch {
    return false;
  }
}

export async function loadOrCreateCert(dir, hosts = ['localhost', '127.0.0.1', ...lanAddresses()]) {
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const cert = fs.readFileSync(certFile, 'utf8');
    if (covers(cert, hosts)) return { cert, key: fs.readFileSync(keyFile, 'utf8'), created: false };
  }
  const { generate } = await import('selfsigned');
  const altNames = hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h }));
  const pems = await generate([{ name: 'commonName', value: '4K Virtual Cinema (local)' }], {
    days: VALID_DAYS,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private, created: true };
}
