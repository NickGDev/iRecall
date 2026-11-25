// Pack the extension as CRX3 (pinned key -> stable ID) and write the update
// feed Chrome's ExtensionInstallForcelist policy fetches.
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, unlinkSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
// Key must live outside the extension dir (Chrome refuses otherwise). Stable
// key -> stable extension ID; gitignored since whoever holds it can sign
// updates the force-install policy auto-installs.
const keyPath = path.join(root, 'keys', 'recall-key.pem');
const publicDir = path.join(root, 'server', 'public');
const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(chromeBin)) {
  console.error('Google Chrome not found at ' + chromeBin);
  process.exit(1);
}

// Stable signing key: keeps the extension ID constant across repacks.
if (!existsSync(keyPath)) {
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('generated new signing key ->', keyPath);
}
// Durable guarantee even for a pre-existing 0644 key from an old checkout.
chmodSync(keyPath, 0o600);

// CRX3 extension ID = first 32 hex chars of SHA256(SPKI DER), mapped to a-p.
const hex = createHash('sha256').update(createPublicKey(readFileSync(keyPath, 'utf8')).export({ type: 'spki', format: 'der' })).digest('hex');
const id = hex.slice(0, 32).split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

console.log('packing CRX with Chrome...');
const res = spawnSync(chromeBin, ['--pack-extension=' + extDir, '--pack-extension-key=' + keyPath, '--no-first-run'], {
  stdio: 'pipe',
});
// Chrome writes the CRX as a sibling of the packed directory.
const crxOut = path.join(extDir, '..', 'extension.crx');
if (!existsSync(crxOut)) {
  console.error('Chrome did not produce a CRX. stderr:', res.stderr?.toString().slice(0, 400));
  process.exit(1);
}

mkdirSync(publicDir, { recursive: true });
copyFileSync(crxOut, path.join(publicDir, 'recall.crx'));
unlinkSync(crxOut);

const version = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8')).version;
const updates = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${id}" status="ok">
    <updatecheck codebase="http://127.0.0.1:8787/recall.crx" version="${version}" />
  </app>
</gupdate>
`;
writeFileSync(path.join(publicDir, 'updates.xml'), updates);

console.log('extension id:', id);
console.log('wrote server/public/recall.crx + updates.xml (version ' + version + ')');
