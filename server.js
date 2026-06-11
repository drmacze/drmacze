const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const LASTFM_API_KEY  = process.env.LASTFM_API_KEY;
const LASTFM_USERNAME = process.env.LASTFM_USERNAME;

async function getNowPlaying() {
  if (!LASTFM_API_KEY || !LASTFM_USERNAME) return null;
  try {
    const res = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'user.getrecenttracks',
        user: LASTFM_USERNAME,
        api_key: LASTFM_API_KEY,
        format: 'json',
        limit: 1,
      },
      timeout: 5000,
    });

    const tracks = res.data?.recenttracks?.track;
    if (!tracks || tracks.length === 0) return { isPlaying: false };

    const track = Array.isArray(tracks) ? tracks[0] : tracks;
    const isPlaying = track['@attr']?.nowplaying === 'true';

    // Last.fm album art — pick largest image (last in array)
    const images = track.image || [];
    const artUrl = images[images.length - 1]?.['#text'] || null;

    return {
      isPlaying,
      isTopTrack: !isPlaying,
      title: track.name || 'Unknown',
      artist: track.artist?.['#text'] || track.artist?.name || 'Unknown Artist',
      album: track.album?.['#text'] || '',
      albumArt: artUrl || null,
      songUrl: track.url || null,
      duration: 0,
      progress: 0,
    };
  } catch (err) {
    console.error('Last.fm error:', err.response?.status, err.message);
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
  const scopes = 'user-top-read';
  const url = `https://accounts.spotify.com/authorize?response_type=code&client_id=${SPOTIFY_CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&show_dialog=true`;
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
  if (!LASTFM_API_KEY || !LASTFM_USERNAME) return res.status(401).json({ error: 'not_configured' });
  const data = await getNowPlaying();
  if (data === null) return res.status(503).json({ error: 'lastfm_error' });
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
    if (!LASTFM_API_KEY || !LASTFM_USERNAME) { send({ error: 'not_configured' }); return; }
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

  if (!LASTFM_API_KEY || !LASTFM_USERNAME) {
    return res.send(buildPixelSVG({ isPlaying: false, title: 'NOT CONFIGURED', artist: 'SET LASTFM_API_KEY + USERNAME' }, null));
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
  return Array.from({ length: total }, (_, i) => {
    const ratio = i / total;
    const fill = i < filled
      ? (ratio < 0.5 ? '#e91e8c' : '#9c27b0')
      : '#1a0a2e';
    return `<rect x="${x + i * (blockW + gap)}" y="${y}" width="${blockW}" height="${h}" fill="${fill}"/>`;
  }).join('');
}

function buildPixelSVG(data, artBase64) {
  const { isPlaying = false, isRecent = false, isTopTrack = false, title, artist, duration = 0, progress = 0 } = data;

  const W = 490, H = 136;
  const displayTitle  = escX(truncate(title  || 'NOTHING PLAYING', 30));
  const displayArtist = escX(truncate(artist || '',                36));
  const pct = duration > 0 ? Math.min(progress / duration, 1) : 0;

  const fmtTime = ms => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // Palette
  const PINK    = '#e91e8c';
  const PINK_D  = '#e91e8c55';
  const PURPLE  = '#9c27b0';
  const DARK    = '#0d0014';
  const SURFACE = '#1a0a2e';
  const MUTED   = '#c084fc';
  const DEAD    = '#3d2a50';

  // Album art
  const artX = 16, artY = 18, artSize = 96;
  const artSection = artBase64
    ? `<image href="${artBase64}" x="${artX}" y="${artY}" width="${artSize}" height="${artSize}" style="image-rendering:pixelated" clip-path="url(#aclip)"/>`
    : `<rect x="${artX}" y="${artY}" width="${artSize}" height="${artSize}" fill="${SURFACE}"/>
       <rect x="${artX + 34}" y="${artY + 30}" width="30" height="4" fill="${PINK}" opacity="0.5"/>
       <rect x="${artX + 34}" y="${artY + 40}" width="24" height="4" fill="${PINK}" opacity="0.35"/>
       <rect x="${artX + 34}" y="${artY + 50}" width="18" height="4" fill="${PINK}" opacity="0.2"/>`;

  // Art corner squares
  const artCorners = [
    [artX - 2, artY - 2], [artX + artSize - 2, artY - 2],
    [artX - 2, artY + artSize - 2], [artX + artSize - 2, artY + artSize - 2],
  ].map(([cx, cy]) => `<rect x="${cx}" y="${cy}" width="5" height="5" fill="${PINK}"/>`).join('');

  // Progress pixel blocks
  const progX = 124, progY = 100, progW = 288;
  const progPixels = progressPixels(pct, progX, progY, progW, 6);

  // Equalizer bars
  const eqX = 430, eqY = 112;
  const eq = eqBars(eqX, eqY, isPlaying || isTopTrack);

  // LED REC indicator (2×2 grid of squares)
  const recX = W - 60, recY = 10;
  const recBlock = isPlaying
    ? `<rect x="${recX}" y="${recY}" width="5" height="5" fill="${PINK}">
         <animate attributeName="opacity" values="1;0.2;1" dur="0.9s" repeatCount="indefinite"/>
       </rect>
       <rect x="${recX + 6}" y="${recY}" width="5" height="5" fill="${PINK}">
         <animate attributeName="opacity" values="0.2;1;0.2" dur="0.9s" repeatCount="indefinite"/>
       </rect>
       <text x="${recX + 14}" y="${recY + 8}" font-family="'Courier New',monospace" font-size="7" fill="${PINK}" letter-spacing="0.5">REC</text>`
    : `<rect x="${recX}" y="${recY}" width="5" height="5" fill="${DEAD}"/>
       <rect x="${recX + 6}" y="${recY}" width="5" height="5" fill="${DEAD}"/>
       <text x="${recX + 14}" y="${recY + 8}" font-family="'Courier New',monospace" font-size="7" fill="${DEAD}" letter-spacing="0.5">OFF</text>`;

  // Scanlines
  const scanlines = Array.from({ length: Math.floor(H / 4) }, (_, i) =>
    `<line x1="0" y1="${i * 4 + 2}" x2="${W}" y2="${i * 4 + 2}" stroke="#000" stroke-width="1" opacity="0.07"/>`
  ).join('');

  // Pixel grid background (10×10 cells to match pixel art reference)
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <pattern id="pg" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="${DARK}"/>
      <rect width="1" height="1" fill="${SURFACE}"/>
    </pattern>
    <linearGradient id="pinkgrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${PINK}"/>
      <stop offset="100%" stop-color="${PURPLE}"/>
    </linearGradient>
    <linearGradient id="bggrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#200030" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="${DARK}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="aclip">
      <rect x="${artX}" y="${artY}" width="${artSize}" height="${artSize}"/>
    </clipPath>
  </defs>

  <!-- Pixel grid bg -->
  <rect width="${W}" height="${H}" fill="url(#pg)"/>
  <rect width="${W}" height="${H}" fill="url(#bggrad)"/>

  <!-- Outer border -->
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="url(#pinkgrad)" stroke-width="1" opacity="0.35"/>

  <!-- Corner squares (card) -->
  <rect x="0"       y="0"       width="6" height="6" fill="${PINK}"/>
  <rect x="${W - 6}" y="0"       width="6" height="6" fill="${PINK}"/>
  <rect x="0"       y="${H - 6}" width="6" height="6" fill="${PINK}"/>
  <rect x="${W - 6}" y="${H - 6}" width="6" height="6" fill="${PINK}"/>

  <!-- Status label -->
  <text x="16" y="13" font-family="'Courier New',monospace" font-size="7" fill="${isPlaying ? PINK : isTopTrack ? PURPLE : DEAD}" letter-spacing="2" font-weight="bold">${isPlaying ? 'NOW PLAYING' : isTopTrack ? 'TOP TRACK' : 'NOTHING PLAYING'}</text>

  <!-- REC indicator -->
  ${recBlock}

  <!-- Pink divider line under header -->
  <line x1="16" y1="16" x2="${W - 16}" y2="16" stroke="url(#pinkgrad)" stroke-width="1" opacity="0.3"/>

  <!-- Album art border -->
  <rect x="${artX - 1}" y="${artY - 1}" width="${artSize + 2}" height="${artSize + 2}" fill="none" stroke="${PINK}" stroke-width="1" opacity="0.5"/>
  ${artSection}
  ${artCorners}

  <!-- Art grid overlay (pixel art look) -->
  <rect x="${artX}" y="${artY}" width="${artSize}" height="${artSize}" fill="none"
    style="background-image: repeating-linear-gradient(#fff1 1px, transparent 1px)" opacity="0.04"/>

  <!-- Info: title -->
  <text x="126" y="${artY + 18}" font-family="'Courier New',monospace" font-size="12" fill="#f8e8ff" font-weight="bold" letter-spacing="0.5">${displayTitle}</text>

  <!-- Info: artist -->
  <text x="126" y="${artY + 36}" font-family="'Courier New',monospace" font-size="9" fill="${MUTED}" letter-spacing="0.5">${displayArtist}</text>

  <!-- Pink accent bar under artist -->
  <rect x="126" y="${artY + 42}" width="80" height="2" fill="url(#pinkgrad)" opacity="0.5"/>

  <!-- Equalizer -->
  ${eq}

  <!-- Progress pixel bar -->
  ${progPixels}

  <!-- Time labels -->
  <text x="${progX}" y="${H - 8}" font-family="'Courier New',monospace" font-size="8" fill="${DEAD}">${fmtTime(progress)}</text>
  <text x="${progX + progW}" y="${H - 8}" font-family="'Courier New',monospace" font-size="8" fill="${DEAD}" text-anchor="end">${fmtTime(duration)}</text>

  <!-- Scanlines -->
  ${scanlines}
</svg>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Now Playing server running on port ${PORT}`);
  if (!LASTFM_API_KEY) console.warn('WARNING: LASTFM_API_KEY not set');
  if (!LASTFM_USERNAME) console.warn('WARNING: LASTFM_USERNAME not set');
});
