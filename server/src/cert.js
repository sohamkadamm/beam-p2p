import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.resolve(__dirname, '../.cert');

/**
 * HTTPS for testing on a local Wi-Fi network.
 * Uses SSL_KEY_PATH / SSL_CERT_PATH if given, otherwise creates a self-signed
 * certificate once and reuses it. (Online hosting like Render already provides HTTPS.)
 */
export async function loadOrCreateCert(lanIp, env) {
  if (env.SSL_KEY_PATH && env.SSL_CERT_PATH) {
    return { key: fs.readFileSync(env.SSL_KEY_PATH), cert: fs.readFileSync(env.SSL_CERT_PATH) };
  }
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  if (lanIp) altNames.push({ type: 7, ip: lanIp });

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Beam local' }], {
    days: 365,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  console.log('[beam] created a self-signed certificate for local HTTPS');
  return { key: pems.private, cert: pems.cert };
}
