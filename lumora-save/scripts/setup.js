// Downloads the official yt-dlp binary into bin/ and verifies its published SHA-256 checksum.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform];
const BIN_DIR = path.join(__dirname, '..', 'bin');
const TARGET = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

async function get(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw Error(`${url} returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  if (!ASSET) throw Error(`No yt-dlp build for ${process.platform}`);
  if (fs.existsSync(TARGET) && !process.argv.includes('--force')) return console.log('yt-dlp already installed.');

  console.log(`Downloading ${ASSET} from the official yt-dlp release...`);
  const [bin, sums] = await Promise.all([get(RELEASE + ASSET), get(RELEASE + 'SHA2-256SUMS')]);

  const line = sums.toString().split('\n').find(l => l.trim().endsWith(' ' + ASSET));
  if (!line) throw Error(`No checksum published for ${ASSET}`);
  const actual = crypto.createHash('sha256').update(bin).digest('hex');
  if (actual !== line.trim().split(/\s+/)[0]) throw Error('Checksum mismatch, refusing to install yt-dlp.');

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(TARGET, bin, { mode: 0o755 });
  console.log(`yt-dlp installed and verified (${(bin.length / 1048576).toFixed(1)} MB).`);
})().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
