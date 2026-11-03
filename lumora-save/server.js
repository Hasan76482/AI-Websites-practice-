// Lumora Save server: serves the page and answers /api/info and /api/download using yt-dlp.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const ffmpeg = require('ffmpeg-static');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const YTDLP = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const PAGE = path.join(__dirname, 'public', 'index.html');
const INFO_TIMEOUT = 90e3;
const DOWNLOAD_TIMEOUT = 15 * 60e3;
const MAX_DOWNLOADS = 3;
const TRANSIENT = /unable to extract universal data|tls connect error/i;
const ALLOWED = ['instagram.com', 'instagr.am', 'youtube.com', 'youtu.be', 'tiktok.com', 'facebook.com', 'fb.watch', 'fb.com', 'linkedin.com', 'lnkd.in', 'snapchat.com'];
const BASE_ARGS = ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-warnings', '--socket-timeout', '30', '--js-runtimes', node:${process.execPath}, '--ffmpeg-location', ffmpeg];

let active = 0;

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new UserError('That doesn’t look like a valid link.');
  }
  const host = url.hostname.toLowerCase();
  const ok = /^https?:$/.test(url.protocol) && ALLOWED.some(d => host === d || host.endsWith('.' + d));
  if (!ok) throw new UserError('Paste a link from Instagram, YouTube, TikTok, Facebook, LinkedIn or Snapchat.');
  return url.href;
}

function friendlyError(stderr) {
  const s = stderr.toLowerCase();
  if (/ip address is blocked|geo.?restrict|not available (in|from) your (country|location|region)/.test(s)) return new UserError('This post is blocked in your region, so it can’t be fetched from this connection.', 422);
  if (/private|login required|log in|sign in|cookies|authentication|not available to|members-only/.test(s)) return new UserError('This post is private or needs a login, so it can’t be fetched.', 422);
  if (/age.?restrict|confirm your age|inappropriate/.test(s)) return new UserError('This video is age-restricted, so it can’t be fetched.', 422);
  if (/removed|deleted|does not exist|not found|404|unavailable/.test(s)) return new UserError('This video is unavailable. It may have been deleted.', 422);
  if (/unsupported url|no video|no formats|requested format/.test(s)) return new UserError('No downloadable video was found at that link.', 422);
  if (/429|rate.?limit|too many requests/.test(s)) return new UserError('The platform is limiting requests right now. Try again in a few minutes.', 503);
  return new UserError('Couldn’t fetch this video. Check the link, or try again in a moment.', 502);
}

// Runs yt-dlp without a shell. The caller aborts through signal when the client disconnects.
function run(args, timeout, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, [...BASE_ARGS, ...args], { windowsHide: true, timeout, signal });
    const out = [];
    let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err = (err + d).slice(-8000); });
    p.on('error', e => {
      if (e.code === 'ENOENT') return reject(new UserError('The downloader isn’t installed. Run "npm install" and restart.', 500));
      reject(e.name === 'AbortError' ? e : new UserError('The request took too long. Try again.', 504));
    });
    p.on('close', code => {
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
      console.error('yt-dlp failed:', err.trim());
      reject(Object.assign(friendlyError(err), { transient: TRANSIENT.test(err) }));
    });
  });
}

// TikTok intermittently serves a page without its data or drops the connection, and the same link works moments later.
async function runWithRetry(args, timeout, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(args, timeout, signal);
    } catch (e) {
      if (!e.transient || attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
}

function isSnapchat(url) {
  return /(^|\.)snapchat\.com$/i.test(new URL(url).hostname);
}

// yt-dlp can't parse Snapchat's current pages, but they publish the video in their public metadata.
async function snapchatInfo(url, signal) {
  const r = await fetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new UserError('This video is unavailable. It may have been deleted.', 422);
  const html = await r.text();
  const field = name => {
    const m = html.match(new RegExp("${name}":"((?:[^"\\\\]|\\\\.)*)"));
    return m ? JSON.parse("${m[1]}") : '';
  };
  const media = field('contentUrl');
  if (!media || !/(^|\.)sc-cdn\.net$/i.test(new URL(media).hostname)) throw new UserError('No downloadable video was found at that link.', 422);
  const seconds = field('duration').match(/^PT(?:(\d+)M)?(\d+)S$/);
  return {
    media,
    title: field('alternateName') ? Snapchat video by ${field('alternateName')} : 'Snapchat video',
    thumbnail: field('thumbnailUrl'),
    uploader: field('alternateName'),
    duration: seconds ? (+seconds[1] || 0) * 60 + +seconds[2] : 0,
  };
}

async function saveSnapchat(url, q, dir, signal) {
  const info = await snapchatInfo(url, signal);
  const base = info.title.replace(/[^\w @.-]/g, '_');
  const video = path.join(dir, ${base}.mp4);
  const r = await fetch(info.media, { signal });
  if (!r.ok) throw new UserError('Couldn’t fetch this video. Try again in a moment.', 502);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(video));
  if (q !== 'audio') return;

  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-y', '-i', video, '-vn', '-q:a', '0', path.join(dir, ${base}.mp3)], { windowsHide: true, stdio: 'ignore', signal });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new UserError('This video has no audio to extract.', 422))));
  });
  fs.rmSync(video);
}

function buildOptions(formats = []) {
  // Portrait reels report 1080x1920, so the shorter side is the "1080p" people expect.
  const sizes = new Set();
  for (const f of formats) {
    if (f.vcodec === 'none' || !f.height) continue;
    const size = f.width ? Math.min(f.width, f.height) : f.height;
    if (size >= 144) sizes.add(size);
  }
  const options = [...sizes].sort((a, b) => b - a).slice(0, 6).map(s => ({ label: ${s}p, q: String(s) }));
  if (!options.length) options.push({ label: 'Best quality', q: 'best' });
  options.push({ label: 'Audio only (MP3)', q: 'audio' });
  return options;
}

function downloadArgs(q) {
  if (q === 'audio') return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  if (q !== 'best' && !/^\d{3,4}$/.test(q)) throw new UserError('Unknown quality option.');
  const res = q === 'best' ? 'res' : res:${q};
  return ['-f', 'bv*+ba/b', '-S', ${res},vcodec:h264,acodec:m4a, '--merge-output-format', 'mp4'];
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => {
      body += d;
      if (body.length > 1e4) reject(new UserError('Request too large.', 413));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function abortOnDisconnect(res) {
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  return ctrl.signal;
}

async function handleInfo(req, res, reqUrl) {
  let videoUrl = '';
  if (req.method === 'POST') {
    if (!/application\/json/i.test(req.headers['content-type'] || '')) throw new UserError('Expected JSON.', 415);
    try {
      const body = JSON.parse(await readBody(req));
      videoUrl = body.url;
    } catch (e) {
      throw e instanceof UserError ? e : new UserError('Invalid request.');
    }
  } else {
    videoUrl = reqUrl.searchParams.get('url');
    if (!videoUrl) {
      return sendJson(res, 200, { message: 'Pass a ?url= parameter or use POST to fetch video info.' });
    }
  }

  const url = checkUrl(videoUrl);
  const signal = abortOnDisconnect(res);
  if (isSnapchat(url)) {
    const { media, ...info } = await snapchatInfo(url, signal);
    return sendJson(res, 200, { ...info, options: buildOptions() });
  }
  const out = await runWithRetry(['-J', '--', url], INFO_TIMEOUT, signal);
  const j = JSON.parse(out);
  sendJson(res, 200, {
    title: j.title || j.description?.slice(0, 80) || 'Untitled video',
    thumbnail: j.thumbnail || '',
    uploader: j.uploader || j.channel || '',
    duration: j.duration || 0,
    options: buildOptions(j.formats),
  });
}

async function handleDownload(reqUrl, res) {
  const url = checkUrl(reqUrl.searchParams.get('url'));
  const q = reqUrl.searchParams.get('q') || 'best';
  const args = downloadArgs(q);
  if (active >= MAX_DOWNLOADS) throw new UserError('The server is busy with other downloads. Try again shortly.', 503);

  active++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumora-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  try {
    const signal = abortOnDisconnect(res);
    if (isSnapchat(url)) await saveSnapchat(url, q, dir, signal);
    else await runWithRetry([...args, '--windows-filenames', '--no-part', '-P', dir, '-o', '%(title).80B [%(id)s].%(ext)s', '--', url], DOWNLOAD_TIMEOUT, signal);
    const files = fs.readdirSync(dir).map(name => ({ name, size: fs.statSync(path.join(dir, name)).size })).sort((a, b) => b.size - a.size);
    if (!files.length) throw new UserError('The download finished but produced no file. Try another quality.', 502);

    const { name, size } = files[0];
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': attachment; filename*=UTF-8''${encodeURIComponent(name)},
    });
    await new Promise(resolve => {
      const stream = fs.createReadStream(path.join(dir, name));
      res.on('close', () => { stream.destroy(); resolve(); });
      stream.on('error', () => { res.destroy(); resolve(); });
      stream.pipe(res);
    });
  } finally {
    active--;
    cleanup();
  }
}

module.exports = async (req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && reqUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(PAGE).pipe(res);
    }
    if ((req.method === 'POST' || req.method === 'GET') && reqUrl.pathname === '/api/info') return await handleInfo(req, res, reqUrl);
    if (req.method === 'GET' && reqUrl.pathname === '/api/download') return await handleDownload(reqUrl, res);
    sendJson(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e.name === 'AbortError' || res.destroyed) return;
    if (!(e instanceof UserError)) console.error(e);
    if (res.headersSent) return res.destroy();
    sendJson(res, e.status || 500, { error: e instanceof UserError ? e.message : 'Something went wrong. Try again.' });
  }
};
