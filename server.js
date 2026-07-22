import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  assertMushafClaims,
  resolveMushafJwtSecret,
  verifyHs256Jwt,
} from './jwt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3090;
const MUSHAF_UPSTREAM = 'https://api.islamic.app/v1/mushaf';
const MUSHAF_BRAND_TITLE = 'AlHelmi Quran';
const SVG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = resolveMushafJwtSecret();
const SYNC_SECRET = (process.env.MUSHAF_SYNC_SECRET || '').trim();
/** Prod: HTTPS parents only (AH-09 — no localhost HTTP in frame-ancestors). */
const ALLOWED_FRAME_ANCESTORS = (
  IS_PROD
    ? [
        "'self'",
        'https://learn.alhelmi.com',
        'https://app.alhelmi.com',
        'https://alhelmi.com',
        'https://www.alhelmi.com',
      ]
    : [
        "'self'",
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://host.docker.internal:3000',
        'https://learn.alhelmi.com',
        'https://app.alhelmi.com',
        'https://alhelmi.com',
        'https://www.alhelmi.com',
      ]
).join(' ');
const ALLOWED_SOCKET_ORIGINS = IS_PROD
  ? [
      'https://app.alhelmi.com',
      'https://quran.alhelmi.com',
      'https://learn.alhelmi.com',
    ]
  : [
      'https://app.alhelmi.com',
      'https://quran.alhelmi.com',
      'https://learn.alhelmi.com',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3090',
      'http://127.0.0.1:3090',
    ];

const DEFAULT_STATE = {
  mode: 'bacaan',
  page: 1,
  hidden: false,
  scopeLabel: '',
  teacherZoom: 100,
  syncZoom: false,
  highlightedVerse: null,
  highlightedAyahs: [],
  highlightedWords: [],
  mushafLayout: 'hafs-v2',
  webcamLayout: 'pip',
  webcamTeacher: false,
  webcamStudents: false,
  activeReaderId: null,
  activeReaderName: '',
};

const rooms = new Map();
const svgCache = new Map();

function brandMushafSvg(svgText) {
  return svgText.replace(/islamic\.app/gi, MUSHAF_BRAND_TITLE);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { ...DEFAULT_STATE, updatedAt: Date.now() });
  }
  return rooms.get(roomId);
}

function securityHeaders(_req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Webcam UI flags sync to parent Jitsi — no getUserMedia on this origin.
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), display-capture=()',
  );
  // Staged CSP: same-origin Socket.IO + Google Fonts used by public/index.html.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      `frame-ancestors ${ALLOWED_FRAME_ANCESTORS}`,
    ].join('; '),
  );
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * Resolve join identity.
 * Production / when secret set: JWT required (OWASP A01 — never trust ?role=).
 */
function resolveJoinAuth(payload = {}) {
  const token = String(payload.token || '').trim();

  if (JWT_SECRET) {
    const claims = assertMushafClaims(verifyHs256Jwt(token, JWT_SECRET));
    if (!claims) {
      return { ok: false, error: 'Token mushaf tidak sah atau tamat tempoh' };
    }
    return {
      ok: true,
      roomId: claims.room,
      role: claims.role,
      userId: claims.userId,
      name: claims.name,
    };
  }

  if (IS_PROD) {
    return {
      ok: false,
      error: 'MUSHAF_JWT_SECRET / MUSHAF_SYNC_SECRET wajib dalam production',
    };
  }

  // Local/dev only fallback — student by default; teacher blocked without secret.
  const roomId = String(payload.roomId || payload.room || '').trim();
  if (!roomId) {
    return { ok: false, error: 'roomId required' };
  }
  return {
    ok: true,
    roomId,
    role: 'student',
    userId: String(payload.userId || '').trim() || null,
    name: '',
  };
}

const app = express();
app.disable('x-powered-by');
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: IS_PROD ? ALLOWED_SOCKET_ORIGINS : true,
    methods: ['GET', 'POST'],
  },
});

app.use(securityHeaders);
app.use(express.static(join(__dirname, 'public')));
app.use('/data', express.static(join(__dirname, 'data')));

app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/styles.css', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(join(__dirname, 'public', 'styles.css'));
});

app.get('/app.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(join(__dirname, 'public', 'app.js'));
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'alhelmi-live-mushaf',
    renderer: 'svg-mushaf',
    ui: 'toolbar-slim-3',
    auth: JWT_SECRET ? 'jwt' : IS_PROD ? 'misconfigured' : 'dev-student-only',
  });
});

/** Dashboard / Moodle pushes active batch reader for turn queue sync */
app.post('/api/room/:roomId/active-reader', express.json({ limit: '32kb' }), (req, res) => {
  const roomId = String(req.params.roomId || '').trim();
  if (!roomId) {
    res.status(400).json({ error: 'roomId required' });
    return;
  }

  // ISO 27001 A.8.3 — fail closed when sync secret missing in production.
  if (!SYNC_SECRET) {
    if (IS_PROD) {
      res.status(503).json({ error: 'MUSHAF_SYNC_SECRET tidak dikonfigurasi' });
      return;
    }
  } else if (req.get('x-mushaf-sync-key') !== SYNC_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const activeReaderId = req.body?.activeReaderId ?? req.body?.active_reader_id ?? null;
  const activeReaderName = String(
    req.body?.activeReaderName ?? req.body?.active_reader_name ?? '',
  ).trim();

  const state = getRoom(roomId);
  const next = {
    ...state,
    activeReaderId: activeReaderId === null || activeReaderId === '' ? null : String(activeReaderId),
    activeReaderName,
    updatedAt: Date.now(),
  };
  rooms.set(roomId, next);
  io.to(roomId).emit('state', next);
  res.json({
    ok: true,
    roomId,
    activeReaderId: next.activeReaderId,
    activeReaderName: next.activeReaderName,
  });
});

/** Proxy + cache SVG mushaf Medina (islamic.app) — paparan seperti cetakan */
app.get('/mushaf/page/:page.svg', async (req, res) => {
  const page = Number(req.params.page);
  if (!Number.isInteger(page) || page < 1 || page > 604) {
    res.status(400).send('Halaman tidak sah');
    return;
  }

  const width = Math.min(1200, Math.max(320, Number(req.query.width) || 900));
  const theme = req.query.theme === 'dark' ? 'dark' : 'light';
  const cacheKey = `${page}:${width}:${theme}`;
  const cached = svgCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SVG_CACHE_TTL_MS) {
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(brandMushafSvg(cached.body));
    return;
  }

  try {
    const url = `${MUSHAF_UPSTREAM}/page/${page}.svg?font=uthmani&theme=${theme}&width=${width}`;
    const upstream = await fetch(url, {
      headers: { Accept: 'image/svg+xml' },
    });
    if (!upstream.ok) {
      res.status(502).send(`Mushaf upstream error (${upstream.status})`);
      return;
    }
    const body = brandMushafSvg(await upstream.text());
    svgCache.set(cacheKey, { body, at: Date.now() });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(body);
  } catch {
    res.status(502).send('Mushaf upstream unavailable');
  }
});

io.on('connection', (socket) => {
  let currentRoom = null;
  let role = 'student';

  socket.on('join', (payload = {}) => {
    const auth = resolveJoinAuth(payload);
    if (!auth.ok) {
      socket.emit('auth_error', { error: auth.error });
      return;
    }

    if (currentRoom) {
      socket.leave(currentRoom);
    }

    currentRoom = auth.roomId;
    role = auth.role;
    socket.data.userId = auth.userId;
    socket.join(currentRoom);

    const state = getRoom(currentRoom);
    socket.emit('state', state);
    socket.emit('joined', {
      roomId: currentRoom,
      role,
      userId: auth.userId,
      name: auth.name,
    });

    if (role === 'teacher') {
      socket.to(currentRoom).emit('teacher_online', true);
    }
  });

  socket.on('teacher_update', (patch) => {
    if (role !== 'teacher' || !currentRoom) return;
    if (!patch || typeof patch !== 'object') return;

    const state = getRoom(currentRoom);
    const next = { ...state, ...patch, updatedAt: Date.now() };

    // Bacaan = sentiasa tunjuk mushaf. Hafazan = guru kawalan via toggle hide (tiada auto-hide).
    if (patch.mode === 'bacaan') {
      next.hidden = false;
    }

    rooms.set(currentRoom, next);
    io.to(currentRoom).emit('state', next);
  });

  socket.on('disconnect', () => {
    if (role === 'teacher' && currentRoom) {
      socket.to(currentRoom).emit('teacher_online', false);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`AlHelmi Live Mushaf → http://localhost:${PORT}`);
  console.log(`Auth mode: ${JWT_SECRET ? 'jwt' : IS_PROD ? 'MISCONFIGURED' : 'dev-student-only'}`);
  if (!JWT_SECRET) {
    console.warn(
      '[security] Set MUSHAF_JWT_SECRET (or MUSHAF_SYNC_SECRET). Teacher role via ?role= is disabled.',
    );
  }
});
