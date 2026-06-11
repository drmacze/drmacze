const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN || null;
let cachedAccessToken = null;
let tokenExpiresAt = 0;

const REDIRECT_URI_PATH = '/callback';

function getBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 30000) return cachedAccessToken;
  if (!SPOTIFY_REFRESH_TOKEN) return null;
  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const res = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: SPOTIFY_REFRESH_TOKEN }),
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    cachedAccessToken = res.data.access_token;
    tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
    if (res.data.refresh_token) SPOTIFY_REFRESH_TOKEN = res.data.refresh_token;
    return cachedAccessToken;
  } catch (err) {
    console.error('Token refresh error:', err.response?.data || err.message);
    return null;
  }
}

async function getNowPlaying() {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204 || !res.data) return { isPlaying: false };
    const data = res.data;
    const track = data.item;
    if (!track) return { isPlaying: false };
    return {
      isPlaying: data.is_playing,
      title: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      album: track.album.name,
      albumArt: track.album.images[0]?.url || null,
      songUrl: track.external_urls.spotify,
      duration: track.duration_ms,
      progress: data.progress_ms,
    };
  } catch (err) {
    if (err.response?.status === 204) return { isPlaying: false };
    console.error('Now playing error:', err.response?.data || err.message);
    return null;
  }
}

async function fetchAlbumArtBase64(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 4000 });
    const b64 = Buffer.from(res.data).toString('base64');
    const mime = res.headers['content-type'] || 'image/jpeg';
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/auth', (req, res) => {
  const base = getBaseUrl(req);
  const redirectUri = `${base}${REDIRECT_URI_PATH}`;
  const scopes = 'user-read-currently-playing user-read-playback-state';
  const url = `https://accounts.spotify.com/authorize?response_type=code&client_id=${SPOTIFY_CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2 style="font-family:monospace;color:#f85149">Error: ${error}</h2>`);
  const base = getBaseUrl(req);
  const redirectUri = `${base}${REDIRECT_URI_PATH}`;
  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const response = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token } = response.data;
    SPOTIFY_REFRESH_TOKEN = refresh_token;
    cachedAccessToken = access_token;
    tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
    res.send(`<!DOCTYPE html><html><head><title>Auth OK</title>
      <style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d1117;color:#c9d1d9;font-family:'Courier New',monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px}
      .box{background:#161b22;border:1px solid #22c55e44;padding:28px;max-width:600px;width:90%}
      h2{color:#22c55e;margin-bottom:12px;font-size:14px;letter-spacing:2px}
      .token{background:#0d1117;border:1px solid #22c55e;padding:12px;word-break:break-all;font-size:11px;color:#22c55e;margin-top:8px}
      p{font-size:12px;color:#8b949e;margin-top:12px}a{color:#22c55e}</style></head>
      <body><div class="box"><h2>AUTH SUCCESS</h2>
      <p>Save this as secret <strong>SPOTIFY_REFRESH_TOKEN</strong> in Replit:</p>
      <div class="token">${refresh_token}</div>
      <p>After saving, restart the server. <a href="/">View widget</a></p>
      </div></body></html>`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send(`<h2>Error: ${err.response?.data?.error_description || err.message}</h2>`);
  }
});

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/now-playing', async (req, res) => {
  if (!SPOTIFY_REFRESH_TOKEN) return res.status(401).json({ error: 'not_authenticated', authUrl: '/auth' });
  const data = await getNowPlaying();
  if (data === null) return res.status(503).json({ error: 'spotify_error' });
  res.json(data);
});

// ── SSE streaming ─────────────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const poll = async () => {
    if (!SPOTIFY_REFRESH_TOKEN) { send({ error: 'not_authenticated' }); return; }
    const data = await getNowPlaying();
    if (data) send(data);
  };

  poll();
  const interval = setInterval(poll, 5000);
  req.on('close', () => clearInterval(interval));
});

// ── Pixel Art SVG endpoint ────────────────────────────────────────────────────

app.get('/api/now-playing/svg', async (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (!SPOTIFY_REFRESH_TOKEN) {
    return res.send(buildPixelSVG({ isPlaying: false, title: 'NOT AUTHENTICATED', artist: 'VISIT /AUTH TO CONNECT' }, null));
  }

  const data = await getNowPlaying();
  if (!data) return res.send(buildPixelSVG({ isPlaying: false }, null));

  const artBase64 = data.albumArt ? await fetchAlbumArtBase64(data.albumArt) : null;
  res.send(buildPixelSVG(data, artBase64));
});

function escX(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '...' : str;
}

// Builds pixel-art equalizer bar SVG elements (8 bars, animating independently)
function eqBars(baseX, baseY, isPlaying) {
  if (!isPlaying) {
    return Array.from({ length: 8 }, (_, i) =>
      `<rect x="${baseX + i * 7}" y="${baseY - 3}" width="4" height="3" fill="#22c55e" opacity="0.3"/>`
    ).join('');
  }

  const configs = [
    { dur: '0.9s',  vals: '6;22;10;28;8;20;6',  yvals: '-6;-22;-10;-28;-8;-20;-6'  },
    { dur: '1.1s',  vals: '10;4;24;8;18;4;14',  yvals: '-10;-4;-24;-8;-18;-4;-14' },
    { dur: '0.75s', vals: '18;6;28;12;22;6;18',  yvals: '-18;-6;-28;-12;-22;-6;-18' },
    { dur: '1.3s',  vals: '4;20;8;16;26;8;4',   yvals: '-4;-20;-8;-16;-26;-8;-4'  },
    { dur: '0.85s', vals: '24;8;18;4;22;10;24',  yvals: '-24;-8;-18;-4;-22;-10;-24' },
    { dur: '1.0s',  vals: '8;26;6;20;10;28;8',  yvals: '-8;-26;-6;-20;-10;-28;-8'  },
    { dur: '1.2s',  vals: '14;4;22;8;18;4;14',  yvals: '-14;-4;-22;-8;-18;-4;-14' },
    { dur: '0.95s', vals: '20;10;4;24;8;16;20',  yvals: '-20;-10;-4;-24;-8;-16;-20' },
  ];

  return configs.map((c, i) => {
    const heights = c.vals.split(';').map(Number);
    const yVals = heights.map(h => baseY - h).join(';');
    return `<rect x="${baseX + i * 7}" y="${baseY}" width="4" height="0" fill="#22c55e">
      <animate attributeName="height" values="${c.vals}" dur="${c.dur}" repeatCount="indefinite" calcMode="linear"/>
      <animate attributeName="y" values="${yVals}" dur="${c.dur}" repeatCount="indefinite" calcMode="linear"/>
    </rect>`;
  }).join('');
}

function progressPixels(pct, x, y, w, h) {
  const blockW = 6;
  const gap = 2;
  const total = Math.floor(w / (blockW + gap));
  const filled = Math.round(pct * total);
  return Array.from({ length: total }, (_, i) =>
    `<rect x="${x + i * (blockW + gap)}" y="${y}" width="${blockW}" height="${h}" fill="${i < filled ? '#22c55e' : '#21262d'}"/>`
  ).join('');
}

function buildPixelSVG(data, artBase64) {
  const { isPlaying = false, title, artist, duration = 0, progress = 0, songUrl } = data;

  const W = 480, H = 130;
  const displayTitle = escX(truncate(title || 'NOTHING PLAYING', 32));
  const displayArtist = escX(truncate(artist || '', 38));
  const pct = duration > 0 ? Math.min(progress / duration, 1) : 0;

  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // Album art area
  const artSize = 90;
  const artX = 16, artY = 20;
  const artSection = artBase64
    ? `<image href="${artBase64}" x="${artX + 1}" y="${artY + 1}" width="${artSize - 2}" height="${artSize - 2}" style="image-rendering:pixelated"/>`
    : `<rect x="${artX + 1}" y="${artY + 1}" width="${artSize - 2}" height="${artSize - 2}" fill="#161b22"/>
       <rect x="${artX + 32}" y="${artY + 28}" width="28" height="4" fill="#22c55e" opacity="0.6"/>
       <rect x="${artX + 32}" y="${artY + 38}" width="28" height="4" fill="#22c55e" opacity="0.4"/>
       <rect x="${artX + 32}" y="${artY + 48}" width="20" height="4" fill="#22c55e" opacity="0.3"/>`;

  // Corner pixel accents (4×4 squares at each corner of album art)
  const corners = [
    [artX - 2, artY - 2], [artX + artSize - 2, artY - 2],
    [artX - 2, artY + artSize - 2], [artX + artSize - 2, artY + artSize - 2],
  ].map(([cx, cy]) => `<rect x="${cx}" y="${cy}" width="4" height="4" fill="#22c55e"/>`).join('');

  // Progress pixels
  const progX = 120, progY = 96, progW = 280;
  const progPixels = progressPixels(pct, progX, progY, progW, 5);

  // Equalizer bars (right-aligned)
  const eqX = 418, eqY = 100;
  const eq = eqBars(eqX, eqY, isPlaying);

  // Blinking REC indicator
  const recIndicator = isPlaying ? `
    <rect x="${W - 22}" y="10" width="5" height="5" fill="#22c55e">
      <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
    </rect>
    <text x="${W - 15}" y="17" font-family="'Courier New',monospace" font-size="7" fill="#22c55e" font-weight="bold" letter-spacing="0.5">REC</text>
  ` : `<rect x="${W - 22}" y="10" width="5" height="5" fill="#484f58"/>
    <text x="${W - 15}" y="17" font-family="'Courier New',monospace" font-size="7" fill="#484f58" letter-spacing="0.5">OFF</text>`;

  // Scanline overlay (subtle horizontal lines across the whole card)
  const scanlines = Array.from({ length: Math.floor(H / 3) }, (_, i) =>
    `<line x1="0" y1="${i * 3 + 1}" x2="${W}" y2="${i * 3 + 1}" stroke="#000" stroke-width="1" opacity="0.08"/>`
  ).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <pattern id="pg" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="#0d1117"/>
      <rect width="1" height="1" fill="#161b22"/>
    </pattern>
    <clipPath id="art-clip">
      <rect x="${artX + 1}" y="${artY + 1}" width="${artSize - 2}" height="${artSize - 2}"/>
    </clipPath>
  </defs>

  <!-- Background grid -->
  <rect width="${W}" height="${H}" fill="url(#pg)"/>

  <!-- Outer border -->
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="#22c55e" stroke-width="1" opacity="0.25"/>

  <!-- Card corner accents -->
  <rect x="0" y="0" width="5" height="5" fill="#22c55e"/>
  <rect x="${W - 5}" y="0" width="5" height="5" fill="#22c55e"/>
  <rect x="0" y="${H - 5}" width="5" height="5" fill="#22c55e"/>
  <rect x="${W - 5}" y="${H - 5}" width="5" height="5" fill="#22c55e"/>

  <!-- REC indicator -->
  ${recIndicator}

  <!-- Album art border -->
  <rect x="${artX}" y="${artY}" width="${artSize}" height="${artSize}" fill="none" stroke="#22c55e" stroke-width="1" opacity="0.5"/>
  ${artSection}
  ${corners}

  <!-- Separator line -->
  <line x1="118" y1="${artY}" x2="118" y2="${artY + artSize}" stroke="#22c55e" stroke-width="1" opacity="0.1"/>

  <!-- Status label -->
  <text x="126" y="${artY + 13}" font-family="'Courier New',monospace" font-size="8" fill="${isPlaying ? '#22c55e' : '#484f58'}" letter-spacing="2" font-weight="bold">${isPlaying ? 'NOW PLAYING' : 'NOT PLAYING'}</text>

  <!-- Title -->
  <text x="126" y="${artY + 34}" font-family="'Courier New',monospace" font-size="13" fill="#e6edf3" font-weight="bold" letter-spacing="0.5">${displayTitle}</text>

  <!-- Artist -->
  <text x="126" y="${artY + 52}" font-family="'Courier New',monospace" font-size="10" fill="#8b949e" letter-spacing="0.5">${displayArtist}</text>

  <!-- Equalizer bars -->
  ${eq}

  <!-- Progress block bar -->
  ${progPixels}

  <!-- Time labels -->
  <text x="${progX}" y="${H - 8}" font-family="'Courier New',monospace" font-size="8" fill="#484f58">${fmtTime(progress)}</text>
  <text x="${progX + progW}" y="${H - 8}" font-family="'Courier New',monospace" font-size="8" fill="#484f58" text-anchor="end">${fmtTime(duration)}</text>

  <!-- Bottom pixel border line -->
  <line x1="5" y1="${H - 1}" x2="${W - 5}" y2="${H - 1}" stroke="#22c55e" stroke-width="1" opacity="0.15"/>

  <!-- Scanlines overlay -->
  ${scanlines}
</svg>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Spotify Now Playing server running on port ${PORT}`);
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) console.warn('WARNING: Spotify credentials not set');
  if (!SPOTIFY_REFRESH_TOKEN) console.log('INFO: No refresh token. Visit /auth to authenticate.');
});
