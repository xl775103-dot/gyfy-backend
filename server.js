const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

  // Extract video info from page
  const descMatch = html.match(/"desc":"([^"]*?)"/);
  const nickMatch = html.match(/"nickname":"([^"]*?)"/);
  const playMatch = html.match(/"play_addr":\{"uri":"([^"]+)","url_list":\["([^"]+)"\]/);
  const coverMatch = html.match(/"cover":"([^"]+)"/);
  const durationMatch = html.match(/"duration":(\d+)/);

  if (!playMatch) throw new Error('无法提取视频地址');

  const wmUrl = playMatch[2];
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

function parseYtDlp(url, res) {
  execFile('python3', ['-m', 'yt_dlp',
    '--dump-json', '--no-download', '--no-warnings', '--no-playlist',
    '--extractor-args', 'youtube:player_client=android,web',
    '--user-agent', 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    url
  ], { timeout: 90000 }, (err, stdout, stderr) => {
    if (err) { console.error('yt-dlp failed', url, (stderr || '').slice(0, 500)); return res.status(500).json({ error: '解析失败，请检查链接' }); }

    try {
      const info = JSON.parse(stdout);
      const vf = [];
      const af = [];
      const seen = new Set();

      for (const f of (info.formats || []).filter(f => f.url)) {
        if (f.has_video !== false && f.vcodec !== 'none' && f.height) {
          const k = f.height + 'p_' + f.ext;
          if (!seen.has(k)) {
            seen.add(k);
            vf.push({
              label: f.ext.toUpperCase() + ' · ' + f.height + 'p · ' + (f.vcodec || '').split('.')[0],
              height: f.height, ext: f.ext, url: f.url,
              filesize: f.filesize || f.filesize_approx || null
            });
          }
        }
        if (f.acodec && f.acodec !== 'none' && (f.vcodec === 'none' || !f.vcodec)) {
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

      vf.sort((a, b) => b.height - a.height);

      res.json({
        title: info.title || '未知',
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        uploader: info.uploader || info.channel || '未知',
        platform: info.extractor || '未知',
        video_formats: vf.slice(0, 8),
        audio_formats: af.slice(0, 3)
      });
    } catch (e) {
      res.status(500).json({ error: '解析错误' });
    }
  });
}

app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供视频链接' });

  // Douyin: use direct parsing (no cookies needed)
  if (/douyin\.com|iesdouyin\.com/i.test(url)) {
    parseDouyin(url).then(data => res.json(data)).catch(e => {
      res.status(500).json({ error: '抖音解析失败: ' + e.message });
    });
    return;
  }

  // Other platforms: use yt-dlp
  parseYtDlp(url, res);
});

// Proxy download to bypass CDN anti-hotlinking
app.get('/api/proxy', (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send('Missing url');

  const mod = url.startsWith('https') ? https : http;
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' };

  mod.get(url, { headers }, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      // Follow redirect
      const redirMod = upstream.headers.location.startsWith('https') ? https : http;
      redirMod.get(upstream.headers.location, { headers }, (r2) => {
        res.set('Content-Type', r2.headers['content-type'] || 'video/mp4');
        if (filename) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.mp4`);
        r2.pipe(res);
      }).on('error', () => res.status(502).send('Download failed'));
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
