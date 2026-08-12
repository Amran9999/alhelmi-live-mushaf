import express from 'express';
import crypto from 'node:crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join, resolve, sep } from 'path';
import {
  assertMushafClaims,
  resolveMushafJwtSecret,
  verifyHs256Jwt,
} from './jwt.js';
import {
  archivePhotoForStudent,
  listStudentNotesPayload,
  MAX_STUDENT_NOTE_SESSIONS,
} from './student-notes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Muat .env dari folder projek (tanpa pakej dotenv). */
function loadDotEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT) || 3090;

const MUSHAF_UPSTREAM = 'https://api.islamic.app/v1/mushaf';
const MUSHAF_BRAND_TITLE = 'AlHelmi Quran';
const SVG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = resolveMushafJwtSecret();
/** Sync key berasingan pilihan; jika kosong, guna JWT secret. */
const SYNC_SECRET = (process.env.MUSHAF_SYNC_SECRET || JWT_SECRET || '').trim();
/** Tanpa JWT + bukan production → boleh ?role=teacher|student */
const LOCAL_DEV = !JWT_SECRET && !IS_PROD;

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
        'http://localhost:3090',
        'http://127.0.0.1:3090',
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

const DEMO_FIFO = [
  { id: 's1', name: 'Aisyah', status: 'waiting', round: 1 },
  { id: 's2', name: 'Umar', status: 'waiting', round: 1 },
  { id: 's3', name: 'Abu Bakar', status: 'waiting', round: 1 },
  { id: 's4', name: 'Fatimah', status: 'waiting', round: 1 },
];

const DEFAULT_STATE = {
  mode: 'bacaan',
  page: 1,
  hidden: false,
  scopeLabel: '',
  teacherZoom: 100,
  syncZoom: false,
  pageSync: true,
  highlightedVerse: null,
  highlightedAyahs: [],
  highlightedWords: [],
  mushafLayout: 'hafs-v2',
  webcamLayout: 'pip',
  webcamTeacher: true,
  webcamStudents: false,
  /** Paparan utama bilik: mushaf | photo */
  stageView: 'mushaf',
  /** Galeri nota/foto sesi (maks 10). sharedPhotoUrl = foto aktif dipapar. */
  sharedPhotos: [],
  sharedPhotoId: null,
  sharedPhotoUrl: null,
  sharedPhotoName: '',
  activeReaderId: null,
  activeReaderName: '',
  muteAllExceptActive: false,
  fifo: [],
};

const rooms = new Map();
/** Anotasi lukisan per bilik: roomId -> { [page]: Stroke[] } (asing daripada state supaya `state` kekal ringan). */
const roomAnnotations = new Map();
const svgCache = new Map();
const UPLOADS_DIR = join(__dirname, 'uploads');
const MEDIA_URL_TTL_SEC = Math.min(
  3600,
  Math.max(60, Number(process.env.MUSHAF_MEDIA_URL_TTL_SEC) || 30 * 60),
);
const MAX_SHARE_BYTES = 6 * 1024 * 1024;
const MAX_SHARED_PHOTOS = 10;
const MAX_ANNOTATION_STROKES_PER_PAGE = 250;
const MAX_ANNOTATION_POINTS = 400;
const MAX_ANNOTATION_TEXT = 80;
const ANNOTATION_COLORS = new Set(['#e11d48', '#16a34a', '#0f172a']);
const SHARE_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};

try {
  mkdirSync(UPLOADS_DIR, { recursive: true });
} catch {
  /* ignore */
}

function safeRoomSlug(roomId) {
  return String(roomId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function signMediaUrl(urlPath) {
  if (!JWT_SECRET || !String(urlPath).startsWith('/uploads/')) return urlPath;
  const payload = Buffer.from(
    JSON.stringify({
      p: String(urlPath),
      exp: Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SEC,
    }),
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`mushaf-media.${payload}`)
    .digest('base64url');
  return `/media/${payload}.${signature}`;
}

function resolveSignedMedia(token) {
  if (!JWT_SECRET || !token) return null;
  const [payload, signature, ...rest] = String(token).split('.');
  if (!payload || !signature || rest.length) return null;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`mushaf-media.${payload}`)
    .digest('base64url');
  if (!timingSafeEqualText(signature, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(claims.exp) || Math.floor(Date.now() / 1000) >= claims.exp) {
      return null;
    }
    const urlPath = String(claims.p || '');
    if (!urlPath.startsWith('/uploads/') || urlPath.includes('\0')) return null;
    const fullPath = resolve(__dirname, `.${urlPath}`);
    const uploadsRoot = resolve(UPLOADS_DIR);
    if (fullPath !== uploadsRoot && !fullPath.startsWith(`${uploadsRoot}${sep}`)) return null;
    return fullPath;
  } catch {
    return null;
  }
}

function exposeRoomState(state) {
  const sharedPhotos = Array.isArray(state?.sharedPhotos)
    ? state.sharedPhotos.map((photo) => ({
        ...photo,
        url: signMediaUrl(photo.url),
      }))
    : [];
  return {
    ...state,
    sharedPhotos,
    sharedPhotoUrl: signMediaUrl(state?.sharedPhotoUrl),
  };
}

function exposeStudentNotes(userId) {
  const payload = listStudentNotesPayload(userId);
  return {
    ...payload,
    sessions: payload.sessions.map((session) => ({
      ...session,
      photos: session.photos.map((photo) => ({
        ...photo,
        url: signMediaUrl(photo.url),
      })),
    })),
  };
}

function removeSharedPhotoFile(urlPath) {
  if (!urlPath || typeof urlPath !== 'string') return;
  if (!urlPath.startsWith('/uploads/')) return;
  const name = basename(urlPath);
  if (!name || name.includes('..')) return;
  const full = join(UPLOADS_DIR, name);
  try {
    if (existsSync(full)) unlinkSync(full);
  } catch {
    /* ignore */
  }
}

function normalizeSharedPhotos(state = {}) {
  const list = Array.isArray(state.sharedPhotos)
    ? state.sharedPhotos
        .filter((p) => p && typeof p.url === 'string' && p.url.startsWith('/uploads/'))
        .map((p) => ({
          id: String(p.id || '').slice(0, 64),
          url: String(p.url),
          name: String(p.name || 'Foto').slice(0, 120),
          createdAt: Number(p.createdAt) || Date.now(),
        }))
        .filter((p) => p.id)
    : [];
  if (!list.length && state.sharedPhotoUrl && String(state.sharedPhotoUrl).startsWith('/uploads/')) {
    list.push({
      id: `legacy-${Date.now()}`,
      url: String(state.sharedPhotoUrl),
      name: String(state.sharedPhotoName || 'Foto').slice(0, 120),
      createdAt: Date.now(),
    });
  }
  return list.slice(0, MAX_SHARED_PHOTOS);
}

function withActiveSharedPhoto(state, photos, preferredId = null) {
  const list = Array.isArray(photos) ? photos : [];
  let active = null;
  if (preferredId) active = list.find((p) => p.id === preferredId) || null;
  if (!active && state.sharedPhotoId) {
    active = list.find((p) => p.id === state.sharedPhotoId) || null;
  }
  if (!active && state.sharedPhotoUrl) {
    active = list.find((p) => p.url === state.sharedPhotoUrl) || null;
  }
  if (!active) active = list.length ? list[list.length - 1] : null;
  return {
    ...state,
    sharedPhotos: list,
    sharedPhotoId: active?.id || null,
    sharedPhotoUrl: active?.url || null,
    sharedPhotoName: active?.name || '',
  };
}

function brandMushafSvg(svgText) {
  return svgText.replace(/islamic\.app/gi, MUSHAF_BRAND_TITLE);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      ...DEFAULT_STATE,
      // Tiada nama demo — pelajar masuk FIFO hanya bila socket join (online).
      fifo: [],
      updatedAt: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function getRoomAnnotations(roomId) {
  if (!roomAnnotations.has(roomId)) {
    roomAnnotations.set(roomId, Object.create(null));
  }
  return roomAnnotations.get(roomId);
}

function clampAnnotationPage(page) {
  const n = Number(page);
  if (!Number.isFinite(n)) return 1;
  return Math.min(604, Math.max(1, Math.round(n)));
}

function sanitizeAnnotationPoint(pt) {
  if (!pt || typeof pt !== 'object') return null;
  const x = Number(pt.x);
  const y = Number(pt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return null;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function sanitizeAnnotationStroke(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const page = clampAnnotationPage(payload.page);
  const rawTool = String(payload.tool || 'pen');
  const tool = rawTool === 'eraser' ? 'eraser' : rawTool === 'text' ? 'text' : 'pen';

  if (tool === 'text') {
    const text = String(payload.text || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_ANNOTATION_TEXT);
    if (!text) return null;
    const color = ANNOTATION_COLORS.has(String(payload.color || '').toLowerCase())
      ? String(payload.color).toLowerCase()
      : '#0f172a';
    const width = Math.min(0.08, Math.max(0.012, Number(payload.width) || 0.032));
    const rawPoints = Array.isArray(payload.points) ? payload.points : [];
    const p = sanitizeAnnotationPoint(rawPoints[0]);
    if (!p) return null;
    const id = String(payload.id || '').slice(0, 64) || `t-${Date.now()}`;
    return { id, page, tool: 'text', color, width, points: [p], text };
  }

  const color = tool === 'eraser'
    ? '#000000'
    : ANNOTATION_COLORS.has(String(payload.color || '').toLowerCase())
      ? String(payload.color).toLowerCase()
      : '#e11d48';
  const width = Math.min(0.08, Math.max(0.001, Number(payload.width) || 0.008));
  const rawPoints = Array.isArray(payload.points) ? payload.points : [];
  const points = [];
  for (let i = 0; i < rawPoints.length && points.length < MAX_ANNOTATION_POINTS; i += 1) {
    const p = sanitizeAnnotationPoint(rawPoints[i]);
    if (p) points.push(p);
  }
  if (points.length < 1) return null;
  const id = String(payload.id || '').slice(0, 64) || `s-${Date.now()}`;
  return { id, page, tool, color, width, points };
}

function emitAnnotationsSync(roomId, page, targetSocket = null) {
  const bag = getRoomAnnotations(roomId);
  const key = String(clampAnnotationPage(page));
  const strokes = Array.isArray(bag[key]) ? bag[key] : [];
  const payload = { page: Number(key), strokes };
  if (targetSocket) targetSocket.emit('annotations_sync', payload);
  else io.to(roomId).emit('annotations_sync', payload);
}

function publishRoom(roomId, next) {
  rooms.set(roomId, next);
  io.to(roomId).emit('state', exposeRoomState(next));
  return next;
}

function securityHeaders(_req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), geolocation=(), display-capture=()',
  );
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https://learn.alhelmi.com https://app.alhelmi.com",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "frame-src 'self'",
      `frame-ancestors ${ALLOWED_FRAME_ANCESTORS}`,
    ].join('; '),
  );
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * Production / JWT secret: token wajib.
 * Local tanpa secret: ?role=teacher|student dibenarkan.
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
      courseId: claims.courseId,
      sessionId: claims.sessionId,
    };
  }

  if (IS_PROD) {
    return {
      ok: false,
      error: 'MUSHAF_JWT_SECRET / MUSHAF_SYNC_SECRET wajib dalam production',
    };
  }

  const roomId = String(payload.roomId || payload.room || '').trim();
  if (!roomId) {
    return { ok: false, error: 'roomId required' };
  }

  const role = payload.role === 'teacher' ? 'teacher' : 'student';
  const userId =
    String(payload.userId || '').trim() ||
    (role === 'teacher' ? 'teacher-local' : `student-${Date.now()}`);
  const name = String(payload.name || '').trim() || (role === 'teacher' ? 'Ustaz' : 'Pelajar');
  const sessionId =
    String(payload.sessionId || payload.session_id || '').trim() ||
    `local-${roomId}-${new Date().toISOString().slice(0, 10)}`;

  return {
    ok: true,
    roomId,
    role,
    userId,
    name,
    courseId: Number(payload.courseId || payload.course_id) || null,
    sessionId,
  };
}

function applyFifoAction(state, action) {
  const fifo = (state.fifo || []).map((s) => ({ ...s }));
  const id = String(action.studentId || '').trim();
  let activeReaderId = state.activeReaderId;
  let activeReaderName = state.activeReaderName;

  if (action.type === 'call' && id) {
    for (const s of fifo) {
      if (s.status === 'active') s.status = 'done';
    }
    const target = fifo.find((s) => s.id === id);
    if (target) {
      target.status = 'active';
      activeReaderId = target.id;
      activeReaderName = target.name;
    }
  } else if (action.type === 'end') {
    let active =
      fifo.find((s) => s.status === 'active') ||
      (id ? fifo.find((s) => String(s.id) === id) : null);
    if (!active && state.activeReaderId) {
      active = fifo.find((s) => String(s.id) === String(state.activeReaderId)) || null;
    }
    if (!active && state.activeReaderName) {
      const want = String(state.activeReaderName).trim().toLowerCase();
      active =
        fifo.find(
          (s) =>
            s.status !== 'done' && String(s.name || '').trim().toLowerCase() === want,
        ) || null;
    }
    if (active) active.status = 'done';
    activeReaderId = null;
    activeReaderName = '';
    // Auto-FIFO: pelajar waiting seterusnya masuk aktif.
    const nextWaiting = fifo
      .filter((s) => s.status === 'waiting')
      .sort((a, b) => (a.round || 1) - (b.round || 1));
    const next = nextWaiting[0];
    if (next) {
      next.status = 'active';
      activeReaderId = next.id;
      activeReaderName = next.name;
    }
  } else if (action.type === 'skip' && id) {
    const target = fifo.find((s) => s.id === id);
    if (target && target.status === 'waiting') {
      const idx = fifo.indexOf(target);
      fifo.splice(idx, 1);
      fifo.push(target);
    }
  } else if (action.type === 'review' && id) {
    const target = fifo.find((s) => s.id === id);
    if (target) {
      target.status = 'waiting';
      target.round = (target.round || 1) + 1;
      const idx = fifo.indexOf(target);
      fifo.splice(idx, 1);
      fifo.push(target);
    }
  } else if (action.type === 'reset') {
    return {
      ...state,
      fifo: [],
      activeReaderId: null,
      activeReaderName: '',
      muteAllExceptActive: false,
      updatedAt: Date.now(),
    };
  }

  return {
    ...state,
    fifo,
    activeReaderId,
    activeReaderName,
    updatedAt: Date.now(),
  };
}

function redirectWithQuery(res, path, query) {
  const qs = new URLSearchParams(query).toString();
  res.redirect(302, qs ? `${path}?${qs}` : path);
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

/** / = bilik guru; ?role=student → /student (serasi pautan lama) */
app.get(['/', '/classroom', '/classroom.html'], (req, res) => {
  if (String(req.query.role || '').toLowerCase() === 'student') {
    redirectWithQuery(res, '/student', req.query);
    return;
  }
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.sendFile(join(__dirname, 'public', 'classroom.html'));
});

app.get(['/mushaf', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/student', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.sendFile(join(__dirname, 'public', 'student.html'));
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'alhelmi-live-mushaf',
    ui: 'classroom-dual-panel',
    renderer: 'svg-mushaf',
    auth: JWT_SECRET ? 'jwt' : LOCAL_DEV ? 'dev-local' : 'misconfigured',
    port: PORT,
  });
});

app.get('/media/:token', (req, res) => {
  const fullPath = resolveSignedMedia(req.params.token);
  if (!fullPath || !existsSync(fullPath)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(fullPath);
});

app.use(express.static(join(__dirname, 'public'), { index: false }));
app.use('/data', express.static(join(__dirname, 'data')));
app.use(
  '/uploads',
  IS_PROD
    ? (_req, res) => res.status(404).end()
    : express.static(UPLOADS_DIR, {
        fallthrough: false,
        maxAge: 0,
        setHeaders(res) {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'no-store');
        },
      }),
);

app.post('/api/room/:roomId/active-reader', express.json({ limit: '32kb' }), (req, res) => {
  const roomId = String(req.params.roomId || '').trim();
  if (!roomId) {
    res.status(400).json({ error: 'roomId required' });
    return;
  }

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
  const next = publishRoom(roomId, {
    ...state,
    activeReaderId: activeReaderId === null || activeReaderId === '' ? null : String(activeReaderId),
    activeReaderName,
    updatedAt: Date.now(),
  });

  res.json({
    ok: true,
    roomId,
    activeReaderId: next.activeReaderId,
    activeReaderName: next.activeReaderName,
  });
});

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
    const upstream = await fetch(url, { headers: { Accept: 'image/svg+xml' } });
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

  function peerInfo(sock) {
    return {
      socketId: sock.id,
      userId: sock.data.userId,
      name: sock.data.name,
      role: sock.data.role,
    };
  }

  function listRoomPeers(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return [];
    const peers = [];
    for (const id of room) {
      const s = io.sockets.sockets.get(id);
      if (s?.data?.userId) peers.push(peerInfo(s));
    }
    return peers;
  }

  function listStudentUserIdsInRoom(roomId) {
    const ids = new Set();
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return [];
    for (const id of room) {
      const s = io.sockets.sockets.get(id);
      if (s?.data?.role === 'student' && s.data.userId) ids.add(String(s.data.userId));
    }
    return [...ids];
  }

  function emitStudentNotes(userId) {
    const payload = exposeStudentNotes(userId);
    for (const [, sock] of io.sockets.sockets) {
      if (sock.data?.userId === String(userId) && sock.data?.role === 'student') {
        sock.emit('student_notes', payload);
      }
    }
  }

  function resolveSessionIdForRoom(roomId, preferred = null) {
    if (preferred) return String(preferred);
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
      for (const id of room) {
        const s = io.sockets.sockets.get(id);
        if (s?.data?.sessionId) return String(s.data.sessionId);
      }
    }
    return `room-${safeRoomSlug(roomId)}-${new Date().toISOString().slice(0, 10)}`;
  }

  function sessionIdForUser(roomId, userId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
      for (const id of room) {
        const s = io.sockets.sockets.get(id);
        if (s?.data?.userId === String(userId) && s.data.sessionId) {
          return String(s.data.sessionId);
        }
      }
    }
    return resolveSessionIdForRoom(roomId);
  }

  function courseIdForRoom(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return null;
    for (const id of room) {
      const s = io.sockets.sockets.get(id);
      if (s?.data?.courseId) return s.data.courseId;
    }
    return null;
  }

  function archiveSharedPhotoToStudents(roomId, entry, state) {
    const courseId = courseIdForRoom(roomId);
    const targets = new Set();
    // Utama: pembaca aktif (giliran talaqqi).
    if (state.activeReaderId) targets.add(String(state.activeReaderId));
    // Juga semua pelajar yang sedang dalam bilik.
    for (const id of listStudentUserIdsInRoom(roomId)) targets.add(id);
    if (!targets.size) return { archivedCount: 0, targetCount: 0 };

    let archivedCount = 0;
    for (const userId of targets) {
      const store = archivePhotoForStudent({
        userId,
        sessionId: sessionIdForUser(roomId, userId),
        courseId,
        roomId,
        sourceUrl: entry.url,
        name: entry.name,
        photoId: entry.id,
      });
      if (store) {
        archivedCount += 1;
        emitStudentNotes(userId);
      }
    }
    return { archivedCount, targetCount: targets.size };
  }

  socket.on('join', (payload = {}) => {
    const auth = resolveJoinAuth(payload);
    if (!auth.ok) {
      socket.emit('auth_error', { error: auth.error });
      return;
    }

    if (currentRoom) {
      socket.to(currentRoom).emit('av-peer-left', { socketId: socket.id, userId: socket.data.userId });
      socket.leave(currentRoom);
    }

    currentRoom = auth.roomId;
    role = auth.role;
    socket.data.userId = auth.userId;
    socket.data.name = auth.name;
    socket.data.role = role;
    socket.data.courseId = auth.courseId || null;
    socket.data.sessionId = auth.sessionId || null;
    socket.data.queueOwner = payload.queueOwner === 'portal' ? 'portal' : 'mushaf';
    socket.join(currentRoom);

    const state = getRoom(currentRoom);
    socket.emit('state', exposeRoomState(state));
    socket.emit('joined', {
      roomId: currentRoom,
      role,
      userId: auth.userId,
      name: auth.name,
      sessionId: auth.sessionId || null,
      courseId: auth.courseId || null,
      localDev: LOCAL_DEV,
      noteSessionsKept: MAX_STUDENT_NOTE_SESSIONS,
    });
    emitAnnotationsSync(currentRoom, state.page || 1, socket);
    if (role === 'student') {
      socket.emit('student_notes', exposeStudentNotes(auth.userId));
    }

    const peers = listRoomPeers(currentRoom).filter((p) => p.socketId !== socket.id);
    socket.emit('av-roster', peers);
    socket.to(currentRoom).emit('av-peer-joined', peerInfo(socket));

    if (role === 'student' && socket.data.queueOwner !== 'portal') {
      const state = getRoom(currentRoom);
      const fifo = (state.fifo || []).map((s) => ({ ...s }));
      const known =
        fifo.some((s) => s.id === auth.userId) ||
        fifo.some((s) => s.name === auth.name && s.status !== 'done');
      if (!known) {
        fifo.push({ id: auth.userId, name: auth.name, status: 'waiting', round: 1 });
        publishRoom(currentRoom, { ...state, fifo, updatedAt: Date.now() });
      }
    }

    if (role === 'teacher') {
      socket.to(currentRoom).emit('teacher_online', true);
    }
  });

  socket.on('teacher_update', (patch) => {
    if (role !== 'teacher' || !currentRoom) return;
    if (!patch || typeof patch !== 'object') return;

    const state = getRoom(currentRoom);
    const {
      sharedPhotoUrl: _ignoreUrl,
      sharedPhotoName: _ignoreName,
      sharedPhotoId: _ignoreId,
      sharedPhotos: _ignorePhotos,
      ...safePatch
    } = patch;
    const next = { ...state, ...safePatch, updatedAt: Date.now() };
    // URL/galeri foto hanya melalui share_photo / clear_photo / select_photo.
    // Ambil META foto sahaja — jangan Object.assign(...state) semula (itu batalkan page/zoom/mode).
    const photos = normalizeSharedPhotos(state);
    const photoMeta = withActiveSharedPhoto(state, photos);
    next.sharedPhotos = photoMeta.sharedPhotos;
    next.sharedPhotoId = photoMeta.sharedPhotoId;
    next.sharedPhotoUrl = photoMeta.sharedPhotoUrl;
    next.sharedPhotoName = photoMeta.sharedPhotoName;
    if (patch.mode === 'bacaan') next.hidden = false;
    if (patch.stageView === 'photo') {
      next.stageView = next.sharedPhotoUrl ? 'photo' : 'mushaf';
    } else if (patch.stageView === 'mushaf') {
      next.stageView = 'mushaf';
    }
    // Anotasi tidak melalui teacher_update — guna annotation_* sahaja.
    delete next.annotationsByPage;
    delete next.annotationStrokes;
    publishRoom(currentRoom, next);
    if (patch.page != null && Number(patch.page) !== Number(state.page)) {
      emitAnnotationsSync(currentRoom, next.page);
    }
  });

  /** Guru tambah satu stroke anotasi (pen/eraser) pada halaman mushaf. */
  socket.on('annotation_add', (payload) => {
    if (role !== 'teacher' || !currentRoom) return;
    const stroke = sanitizeAnnotationStroke(payload);
    if (!stroke) return;
    const bag = getRoomAnnotations(currentRoom);
    const key = String(stroke.page);
    const list = Array.isArray(bag[key]) ? bag[key].slice() : [];
    if (list.some((s) => s.id === stroke.id)) return;
    list.push(stroke);
    if (list.length > MAX_ANNOTATION_STROKES_PER_PAGE) {
      bag[key] = list.slice(list.length - MAX_ANNOTATION_STROKES_PER_PAGE);
    } else {
      bag[key] = list;
    }
    io.to(currentRoom).emit('annotation_add', stroke);
  });

  /** Guru padam semua anotasi pada satu halaman (atau halaman semasa). */
  socket.on('annotation_clear', (payload = {}) => {
    if (role !== 'teacher' || !currentRoom) return;
    const state = getRoom(currentRoom);
    const page = clampAnnotationPage(payload.page ?? state.page ?? 1);
    const bag = getRoomAnnotations(currentRoom);
    bag[String(page)] = [];
    io.to(currentRoom).emit('annotation_clear', { page });
  });

  /** Pelajar/guru minta stroke untuk halaman (contoh: pelajar baca sendiri). */
  socket.on('annotation_request', (payload = {}) => {
    if (!currentRoom) return;
    const state = getRoom(currentRoom);
    const page = clampAnnotationPage(payload.page ?? state.page ?? 1);
    emitAnnotationsSync(currentRoom, page, socket);
  });

  /** Guru muat naik JPG/PNG (base64) untuk dikongsi ke bilik. */
  socket.on('share_photo', (payload = {}) => {
    const requestId = String(payload.requestId || '').slice(0, 80) || null;
    const fail = (error) => socket.emit('share_photo_error', { error, requestId });
    if (role !== 'teacher' || !currentRoom) {
      fail(role !== 'teacher' ? 'Hanya guru boleh kongsi nota' : 'Belum join bilik mushaf');
      return;
    }
    const mime = String(payload.mime || '').toLowerCase().trim();
    const ext = SHARE_MIME[mime];
    if (!ext) {
      fail('Hanya JPG atau PNG dibenarkan');
      return;
    }
    const raw = String(payload.data || '').replace(/^data:image\/\w+;base64,/, '');
    if (!raw) {
      fail('Fail kosong');
      return;
    }
    let buf;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      fail('Fail rosak');
      return;
    }
    if (!buf.length || buf.length > MAX_SHARE_BYTES) {
      fail('Saiz maksimum 6MB');
      return;
    }
    // Magic bytes asas
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng =
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if ((ext === 'jpg' && !isJpeg) || (ext === 'png' && !isPng)) {
      fail('Format fail tidak sah');
      return;
    }

    const slug = safeRoomSlug(currentRoom) || 'room';
    const fileName = `${slug}-${Date.now()}.${ext}`;
    const fullPath = join(UPLOADS_DIR, fileName);
    try {
      writeFileSync(fullPath, buf);
    } catch (err) {
      console.error('share_photo write', err);
      fail('Gagal simpan fail');
      return;
    }

    const state = getRoom(currentRoom);
    const name = String(payload.name || fileName)
      .trim()
      .replace(/[^\w.\- ()[\]]+/g, '_')
      .slice(0, 120);
    const showNow = payload.show !== false;
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      url: `/uploads/${fileName}`,
      name: name || fileName,
      createdAt: Date.now(),
    };
    let photos = normalizeSharedPhotos(state);
    photos.push(entry);
    while (photos.length > MAX_SHARED_PHOTOS) {
      const dropped = photos.shift();
      if (dropped?.url) removeSharedPhotoFile(dropped.url);
    }
    const next = withActiveSharedPhoto(state, photos, entry.id);
    const published = publishRoom(currentRoom, {
      ...next,
      stageView: showNow ? 'photo' : state.stageView === 'photo' ? 'photo' : 'mushaf',
      updatedAt: Date.now(),
    });
    // Arkib per pelajar (kekal 3 sesi) — fail disalin, tidak hilang bila galeri bilik dikosongkan.
    let archiveResult = { archivedCount: 0, targetCount: 0 };
    try {
      archiveResult = archiveSharedPhotoToStudents(currentRoom, entry, published);
    } catch (err) {
      console.error('archive student notes', err);
      fail('Foto dikongsi tetapi arkib pelajar gagal disimpan');
      return;
    }
    socket.emit('share_photo_result', {
      ok: archiveResult.archivedCount === archiveResult.targetCount,
      requestId,
      photoId: entry.id,
      archivedCount: archiveResult.archivedCount,
      targetCount: archiveResult.targetCount,
    });
  });

  socket.on('notes_list', () => {
    if (role !== 'student' || !socket.data.userId) return;
    socket.emit('student_notes', exposeStudentNotes(socket.data.userId));
  });

  socket.on('state_refresh', () => {
    if (!currentRoom) return;
    socket.emit('state', exposeRoomState(getRoom(currentRoom)));
  });

  /** Guru pilih foto aktif dalam galeri (untuk paparan Foto). */
  socket.on('select_photo', (payload = {}) => {
    if (role !== 'teacher' || !currentRoom) return;
    const state = getRoom(currentRoom);
    const photos = normalizeSharedPhotos(state);
    const id = String(payload.id || '').trim();
    if (!id || !photos.some((p) => p.id === id)) return;
    const next = withActiveSharedPhoto(state, photos, id);
    publishRoom(currentRoom, {
      ...next,
      stageView: payload.show === false ? state.stageView : 'photo',
      updatedAt: Date.now(),
    });
  });

  /** Guru buang satu foto dari galeri. */
  socket.on('remove_photo', (payload = {}) => {
    if (role !== 'teacher' || !currentRoom) return;
    const state = getRoom(currentRoom);
    const id = String(payload.id || '').trim();
    let photos = normalizeSharedPhotos(state);
    const target = photos.find((p) => p.id === id);
    if (!target) return;
    removeSharedPhotoFile(target.url);
    photos = photos.filter((p) => p.id !== id);
    const next = withActiveSharedPhoto(state, photos);
    publishRoom(currentRoom, {
      ...next,
      stageView: next.sharedPhotoUrl ? state.stageView : 'mushaf',
      updatedAt: Date.now(),
    });
  });

  socket.on('clear_photo', () => {
    if (role !== 'teacher' || !currentRoom) return;
    const state = getRoom(currentRoom);
    for (const photo of normalizeSharedPhotos(state)) {
      removeSharedPhotoFile(photo.url);
    }
    if (state.sharedPhotoUrl) removeSharedPhotoFile(state.sharedPhotoUrl);
    publishRoom(currentRoom, {
      ...state,
      sharedPhotos: [],
      sharedPhotoId: null,
      sharedPhotoUrl: null,
      sharedPhotoName: '',
      stageView: 'mushaf',
      updatedAt: Date.now(),
    });
  });

  socket.on('fifo_action', (action = {}) => {
    if (role !== 'teacher' || !currentRoom) {
      socket.emit('fifo_error', {
        error:
          role !== 'teacher'
            ? 'Hanya guru boleh urus giliran (token role bukan teacher).'
            : 'Belum join bilik mushaf.',
      });
      return;
    }
    if (socket.data.queueOwner === 'portal') {
      socket.emit('fifo_error', {
        error: 'Giliran bilik ini dikawal oleh portal Moodle.',
      });
      return;
    }
    const state = getRoom(currentRoom);
    const next = applyFifoAction(state, action);
    // Tamat / Panggil / Mute semua → hanya pembaca aktif boleh mic+cam (mushaf WebRTC).
    if (action.type === 'mute_all' || action.type === 'end' || action.type === 'call') {
      next.muteAllExceptActive = true;
      next.updatedAt = Date.now();
    }
    publishRoom(currentRoom, next);
    if (next.muteAllExceptActive) {
      io.to(currentRoom).emit('av-mute-policy', {
        muteAllExceptActive: true,
        activeReaderId: next.activeReaderId || null,
      });
    }
  });

  socket.on('av-signal', ({ to, signal } = {}) => {
    if (!currentRoom || !to || !signal) return;
    const target = io.sockets.sockets.get(to);
    if (!target || !target.rooms.has(currentRoom)) return;
    target.emit('av-signal', { from: socket.id, signal, peer: peerInfo(socket) });
  });

  socket.on('av-media-state', (media = {}) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('av-media-state', {
      socketId: socket.id,
      userId: socket.data.userId,
      camOn: Boolean(media.camOn),
      micOn: Boolean(media.micOn),
    });
  });

  socket.on('av-ready', () => {
    if (!currentRoom) return;
    const peers = listRoomPeers(currentRoom).filter((p) => p.socketId !== socket.id);
    socket.emit('av-roster', peers);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const roomId = currentRoom;
    const leftUserId = socket.data.userId;
    socket.to(roomId).emit('av-peer-left', {
      socketId: socket.id,
      userId: leftUserId,
    });
    if (role === 'teacher') {
      socket.to(roomId).emit('teacher_online', false);
    }
    // Pelajar logout / tutup tab → keluar FIFO bilik (masuk semula bila join).
    if (role === 'student' && leftUserId && socket.data.queueOwner !== 'portal') {
      const state = getRoom(roomId);
      const fifo = (state.fifo || []).map((s) => ({ ...s }));
      const me = fifo.find((s) => String(s.id) === String(leftUserId));
      if (!me) return;
      if (me.status === 'waiting') {
        const nextFifo = fifo.filter((s) => String(s.id) !== String(leftUserId));
        publishRoom(roomId, { ...state, fifo: nextFifo, updatedAt: Date.now() });
        return;
      }
      if (me.status === 'active') {
        const ended = applyFifoAction(state, { type: 'end', id: leftUserId });
        publishRoom(roomId, ended);
        if (ended.muteAllExceptActive) {
          io.to(roomId).emit('av-mute-policy', {
            muteAllExceptActive: true,
            activeReaderId: ended.activeReaderId || null,
          });
        }
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`AlHelmi Live Mushaf (kelas) → http://localhost:${PORT}`);
  console.log(`  Guru:     http://localhost:${PORT}/?room=kelas-a`);
  console.log(`  Pelajar:  http://localhost:${PORT}/student?room=kelas-a`);
  console.log(`  Mushaf:   http://localhost:${PORT}/mushaf?room=kelas-a&role=teacher&local=1`);
  console.log(`Auth: ${JWT_SECRET ? 'jwt' : LOCAL_DEV ? 'dev-local (?role= OK)' : 'MISCONFIGURED'}`);
  if (!JWT_SECRET && !IS_PROD) {
    console.warn('[dev] Tiada MUSHAF_JWT_SECRET — guna ?room=&role= untuk ujian tempatan.');
  }
});
