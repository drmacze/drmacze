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
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 30000) {
    return cachedAccessToken;
  }
  if (!SPOTIFY_REFRESH_TOKEN) return null;

  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const res = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: SPOTIFY_REFRESH_TOKEN,
      }),
      {
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    cachedAccessToken = res.data.access_token;
    tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
    if (res.data.refresh_token) {
      SPOTIFY_REFRESH_TOKEN = res.data.refresh_token;
    }
    return cachedAccessToken;
  } catch (err) {
    console.error('Error refreshing token:', err.response?.data || err.message);
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
    console.error('Error fetching now playing:', err.response?.data || err.message);
    return null;
  }
}

// ── Auth flow ─────────────────────────────────────────────────────────────────

app.get('/auth', (req, res) => {
  const base = getBaseUrl(req);
  const redirectUri = `${base}${REDIRECT_URI_PATH}`;
  const scopes = 'user-read-currently-playing user-read-playback-state';
  const url = `https://accounts.spotify.com/authorize?response_type=code&client_id=${SPOTIFY_CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Error: ${error}</h2>`);

  const base = getBaseUrl(req);
  const redirectUri = `${base}${REDIRECT_URI_PATH}`;

  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const response = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
      {
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token, refresh_token } = response.data;
    SPOTIFY_REFRESH_TOKEN = refresh_token;
    cachedAccessToken = access_token;
    tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Spotify Auth Berhasil</title>
        <style>
          body { background: #0d1117; color: #c9d1d9; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; flex-direction: column; gap: 16px; }
          .box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; max-width: 600px; width: 90%; }
          h2 { color: #22c55e; margin: 0 0 12px; }
          .token { background: #0d1117; border: 1px solid #22c55e; border-radius: 4px; padding: 12px; word-break: break-all; font-size: 12px; color: #22c55e; }
          p { margin: 8px 0; font-size: 14px; color: #8b949e; }
          a { color: #22c55e; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>✅ Auth Berhasil!</h2>
          <p>Simpan Refresh Token ini sebagai secret <strong>SPOTIFY_REFRESH_TOKEN</strong> di Replit:</p>
          <div class="token">${refresh_token}</div>
          <p style="margin-top:16px">Setelah disimpan, server akan langsung bisa menampilkan lagu yang sedang diputar. <a href="/">Lihat widget →</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send(`<h2>Error: ${err.response?.data?.error_description || err.message}</h2>`);
  }
});

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/now-playing', async (req, res) => {
  if (!SPOTIFY_REFRESH_TOKEN) {
    return res.status(401).json({ error: 'not_authenticated', authUrl: '/auth' });
  }
  const data = await getNowPlaying();
  if (data === null) return res.status(503).json({ error: 'spotify_error' });
  res.json(data);
});

// ── SSE streaming endpoint ────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const poll = async () => {
    if (!SPOTIFY_REFRESH_TOKEN) {
      send({ error: 'not_authenticated' });
      return;
    }
    const data = await getNowPlaying();
    if (data) send(data);
  };

  poll();
  const interval = setInterval(poll, 5000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ── Widget SVG endpoint (for README embedding) ────────────────────────────────

app.get('/api/now-playing/svg', async (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (!SPOTIFY_REFRESH_TOKEN) {
    return res.send(buildSVG({ isPlaying: false, title: 'Not authenticated', artist: 'Visit /auth' }));
  }

  const data = await getNowPlaying();
  res.send(buildSVG(data || { isPlaying: false }));
});

function escapeXML(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSVG(data) {
  const { isPlaying, title = 'Not Playing', artist = '', albumArt } = data;
  const displayTitle = title.length > 30 ? title.substring(0, 30) + '…' : title;
  const displayArtist = artist.length > 35 ? artist.substring(0, 35) + '…' : artist;

  const artSection = albumArt
    ? `<image href="${albumArt}" x="12" y="12" width="60" height="60" clip-path="url(#roundRect)"/>`
    : `<rect x="12" y="12" width="60" height="60" rx="4" fill="#1e1e2e"/>
       <text x="42" y="50" text-anchor="middle" font-size="24" fill="#22c55e">♪</text>`;

  return `<svg width="340" height="84" viewBox="0 0 340 84" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <clipPath id="roundRect">
      <rect x="12" y="12" width="60" height="60" rx="4"/>
    </clipPath>
  </defs>
  <rect width="340" height="84" rx="8" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
  ${artSection}
  <text x="84" y="26" font-family="monospace" font-size="10" fill="#8b949e">${isPlaying ? '▶ NOW PLAYING' : '⏸ PAUSED'}</text>
  <text x="84" y="46" font-family="monospace" font-size="13" font-weight="bold" fill="#c9d1d9">${escapeXML(displayTitle)}</text>
  <text x="84" y="64" font-family="monospace" font-size="11" fill="#8b949e">${escapeXML(displayArtist)}</text>
  ${isPlaying ? `<circle cx="318" cy="14" r="5" fill="#22c55e"><animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite"/></circle>` : ''}
</svg>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Spotify Now Playing server running on port ${PORT}`);
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.warn('⚠️  SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set!');
  }
  if (!SPOTIFY_REFRESH_TOKEN) {
    console.log('ℹ️  No SPOTIFY_REFRESH_TOKEN set. Visit /auth to authenticate.');
  }
});
