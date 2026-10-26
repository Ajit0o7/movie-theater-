import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadOrCreateCert } from '../server/tls.js';

test('self-signed cert covers the LAN IPs, is cached, and is regenerated when an address changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinema-cert-'));
  try {
    const first = await loadOrCreateCert(dir, ['localhost', '127.0.0.1', '192.168.1.20']);
    assert.equal(first.created, true);
    const san = new X509Certificate(first.cert).subjectAltName;
    assert.match(san, /DNS:localhost/);
    assert.match(san, /IP Address:192\.168\.1\.20/);

    const again = await loadOrCreateCert(dir, ['localhost', '127.0.0.1', '192.168.1.20']);
    assert.equal(again.created, false, 'reuses the cached cert so the browser exception keeps working');
    assert.equal(again.cert, first.cert);

    const moved = await loadOrCreateCert(dir, ['localhost', '127.0.0.1', '10.0.0.7']);
    assert.equal(moved.created, true, 'new Wi-Fi address -> new cert');
    assert.match(new X509Certificate(moved.cert).subjectAltName, /IP Address:10\.0\.0\.7/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
