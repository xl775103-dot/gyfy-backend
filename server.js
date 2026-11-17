const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const dns = require('dns').promises;
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Borrowed ideas (see IMPROVEMENTS.md):
// - XCRDownloader: rotate YouTube player clients on failure instead of one fixed set.
// - MeTube: cap concurrent parse jobs so one batch can't swamp the 0.25-CPU container.
// - XCRDownloader relay: block /api/proxy from fetching private/internal addresses (SSRF guard).
const YT_CLIENT_CHAIN = ['android,ios,web', 'android_vr,web_safari', 'tv,android,web'];
const MAX_CONCURRENT_PARSE = 3;
let inFlightParses = 0;

function isYoutubeUrl(url) {
  return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(url).hostname);
}

// Human-readable error, à la XCRDownloader's error humanizer: don't hide the cause
// behind a generic "解析失败" when yt-dlp actually told us what went wrong.
function classifyYtDlpError(stderr, err) {
  const s = (stderr || '') + ' ' + (err && err.message ? err.message : '');
  if (/timed out|timeout|ETIMEDOUT|killed/i.test(s)) return '解析超时，请稍后再试';
  if (/HTTP Error 403|Forbidden|Sign in to confirm|not a bot|confirm you.?re not a bot/i.test(s))
    return '平台拒绝访问（可能触发反机器人校验），请稍后再试';
  if (/No video formats|no formats|Requested format is not available/i.test(s))
    return '该视频未找到可用格式（可能需登录或受地区限制）';
  if (/Unsupported URL|No video id|is not a valid URL/i.test(s)) return '不支持的链接';
  if (/Private video|Video unavailable|This video is no longer/i.test(s)) return '该视频不可用（可能已删除或设为私享）';
  return '解析失败，请检查链接';
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 169 && p[1] === 254 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad-protocol');
  const { address } = await dns.lookup(u.hostname);
  if (isPrivateIp(address)) throw new Error('private-address');
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function httpHead(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'HEAD', headers: headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpHead(res.headers.location, headers).then(resolve, reject);
      }
      resolve({ status: res.statusCode, url: res.responseUrl || url, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

async function parseDouyin(inputUrl) {
  // Resolve short URL to get the actual video page
  const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
  const resp = await httpGet(inputUrl, { 'User-Agent': UA });
  const html = resp.body.replace(/\\u002F/g, '/');

  // Extract video info from page. Douyin's page JSON has drifted over time, so try
  // several shapes instead of one exact pattern (old code only matched the uri form).
  const descMatch = html.match(/"desc":"([^"]*?)"/);
  const nickMatch = html.match(/"nickname":"([^"]*?)"/);
  const playMatch = html.match(/"play_addr":\{"uri":"([^"]+)","url_list":\["([^"]+)"\]/)
    || html.match(/"play_addr":\{"url_list":\["([^"]+)"\]/)
    || html.match(/"play_addr":\{"uri":"([^"]+)"/);
  const coverMatch = html.match(/"cover":"([^"]+)"/);
  const durationMatch = html.match(/"duration":(\d+)/);

  if (!playMatch) throw new Error('无法提取视频地址');

  const wmUrl = playMatch[2] || playMatch[1];
  const noWmUrl = wmUrl.replace('playwm', 'play');

  // Follow redirect to get real video URL
  let realUrl = noWmUrl;
  try {
    realUrl = await new Promise((resolve, reject) => {
      const req = https.request(noWmUrl, { method: 'HEAD', headers: { 'User-Agent': UA, 'Referer': 'https://www.douyin.com/' } }, (res) => {
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow one more redirect
          const req2 = https.request(res.headers.location, { method: 'HEAD', headers: { 'User-Agent': UA } }, (res2) => {
            res2.resume();
            resolve(res2.headers.location || res.headers.location);
          });
          req2.on('error', () => resolve(res.headers.location));
          req2.end();
        } else {
          resolve(noWmUrl);
        }
      });
      req.on('error', () => resolve(noWmUrl));
      req.end();
    });
  } catch (e) { /* use noWmUrl */ }

  const title = descMatch ? descMatch[1] : '未知';
  const author = nickMatch ? nickMatch[1] : '未知';
  const cover = coverMatch ? coverMatch[1].replace(/\\u002F/g, '/') : null;
  const duration = durationMatch ? parseInt(durationMatch[1]) / 1000 : null;

  return {
    title,
    thumbnail: cover,
    duration,
    uploader: author,
    platform: '抖音',
    video_formats: [{ label: 'MP4 · 无水印', height: 720, ext: 'mp4', url: realUrl, filesize: null }],
    audio_formats: []
  };
}

function runYtDlpOnce(url, client) {
  const args = ['-m', 'yt_dlp',
    '--dump-json', '--no-download', '--no-warnings', '--no-playlist',
    '--user-agent', 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  ];
  if (client) args.push('--extractor-args', 'youtube:player_client=' + client);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile('python3', args, { timeout: 90000 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stderr: stderr || '' });
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject({ err: e, stderr: 'bad-json' }); }
    });
  });
}

// YouTube blocks one player client at a time; rotate through the chain (XCRDownloader
// pattern) instead of failing on the first one. Non-YouTube sites get one plain attempt.
async function parseYtDlp(url) {
  const clients = isYoutubeUrl(url) ? YT_CLIENT_CHAIN : [null];
  let lastFailure = null;
  for (const client of clients) {
    try {
      const info = await runYtDlpOnce(url, client);
      if (!info || !(info.formats || []).some(f => f.url)) {
        lastFailure = { err: new Error('no-formats'), stderr: 'No video formats' };
        continue;
      }
      return buildInfo(info);
    } catch (e) {
      lastFailure = e;
      console.error('yt-dlp failed', url, 'client=' + (client || 'default'), (e.stderr || '').slice(0, 300));
    }
  }
  const e = new Error(classifyYtDlpError(lastFailure && lastFailure.stderr, lastFailure && lastFailure.err));
  e.status = 500;
  throw e;
}

function buildInfo(info) {
  const vf = [];
  const af = [];
  const seen = new Set();

  for (const f of (info.formats || []).filter(f => f.url)) {
    const hasAudio = !!(f.acodec && f.acodec !== 'none');
    if (f.has_video !== false && f.vcodec !== 'none' && f.height) {
      const k = f.height + 'p_' + f.ext + '_' + (hasAudio ? 'a' : 'v');
      if (!seen.has(k)) {
        seen.add(k);
        vf.push({
          label: f.ext.toUpperCase() + ' · ' + f.height + 'p' + (hasAudio ? ' · 含音频' : '') + ' · ' + (f.vcodec || '').split('.')[0],
          height: f.height, ext: f.ext, url: f.url, has_audio: hasAudio,
          filesize: f.filesize || f.filesize_approx || null
        });
      }
    }
    if (hasAudio && (f.vcodec === 'none' || !f.vcodec)) {
      const k = 'a_' + f.ext;
      if (!seen.has(k)) {
        seen.add(k);
        af.push({
          label: f.ext.toUpperCase() + ' · ' + f.acodec.split('.')[0],
          ext: f.ext, url: f.url,
          filesize: f.filesize || f.filesize_approx || null
        });
      }
    }
  }

  // Muxed (video+audio) formats first: a bare DASH video-only URL downloads silent
  // video, which is the most common "下载下来没声音" complaint. (XCRDownloader
  // prefers browser-compatible muxed MP4 for the same reason.)
  vf.sort((a, b) => (b.has_audio - a.has_audio) || (b.height - a.height));

  return {
    title: info.title || '未知',
    thumbnail: info.thumbnail || null,
    duration: info.duration || null,
    uploader: info.uploader || info.channel || '未知',
    platform: info.extractor || '未知',
    video_formats: vf.slice(0, 8),
    audio_formats: af.slice(0, 3)
  };
}

app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: '请提供视频链接' });
  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: '链接格式不正确' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return res.status(400).json({ error: '只支持 http/https 链接' });

  if (inFlightParses >= MAX_CONCURRENT_PARSE)
    return res.status(429).json({ error: '解析任务太多，请稍后再试' });
  inFlightParses++;
  try {
    // Douyin: direct parsing first (no cookies needed); if the page shape changed,
    // fall back to yt-dlp's Douyin extractor before giving up. Both can still fail
    // without fresh cookies — that case now says so instead of a bare failure.
    if (/douyin\.com|iesdouyin\.com/i.test(url)) {
      try {
        return res.json(await parseDouyin(url));
      } catch (e) {
        console.error('douyin direct parse failed, trying yt-dlp', url, e.message);
        try {
          return res.json(await parseYtDlp(url));
        } catch (e2) {
          return res.status(500).json({ error: '抖音解析失败：疑似需要登录 Cookie 才能访问，请换一条链接再试' });
        }
      }
    }

    // Other platforms: use yt-dlp (with client rotation for YouTube)
    return res.json(await parseYtDlp(url));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || '解析失败，请检查链接' });
  } finally {
    inFlightParses--;
  }
});

// Proxy download to bypass CDN anti-hotlinking
app.get('/api/proxy', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send('Missing url');

  // SSRF guard: never fetch private/internal addresses, and re-check the
  // redirect target too (a public URL could redirect to localhost).
  try { await assertPublicUrl(url); }
  catch (e) { return res.status(403).send('Forbidden url'); }

  const mod = url.startsWith('https') ? https : http;
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' };

  mod.get(url, { headers }, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      // Follow redirect
      const target = upstream.headers.location;
      assertPublicUrl(target).then(() => {
        const redirMod = target.startsWith('https') ? https : http;
        redirMod.get(target, { headers }, (r2) => {
          res.set('Content-Type', r2.headers['content-type'] || 'video/mp4');
          if (filename) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.mp4`);
          r2.pipe(res);
        }).on('error', () => res.status(502).send('Download failed'));
      }).catch(() => res.status(403).send('Forbidden url'));
      return;
    }
    res.set('Content-Type', upstream.headers['content-type'] || 'video/mp4');
    if (filename) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.mp4`);
    upstream.pipe(res);
  }).on('error', () => res.status(502).send('Download failed'));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log('鹏哥视频解析已启动: http://localhost:' + PORT);
});
