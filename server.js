import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';
import {
  assertMushafClaims,
  resolveMushafJwtSecret,
  verifyHs256Jwt,
} from './jwt.js';

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
  sharedPhotoUrl: null,
  sharedPhotoName: '',
  activeReaderId: null,
  activeReaderName: '',
  muteAllExceptActive: false,
  fifo: DEMO_FIFO.map((s) => ({ ...s })),
};

const rooms = new Map();
const svgCache = new Map();
const UPLOADS_DIR = join(__dirname, 'uploads');
const MAX_SHARE_BYTES = 6 * 1024 * 1024;
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

function brandMushafSvg(svgText) {
  return svgText.replace(/islamic\.app/gi, MUSHAF_BRAND_TITLE);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      ...DEFAULT_STATE,
      fifo: DEMO_FIFO.map((s) => ({ ...s })),
      updatedAt: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function publishRoom(roomId, next) {
  rooms.set(roomId, next);
  io.to(roomId).emit('state', next);
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
      "img-src 'self' data: blob:",
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

  return { ok: true, roomId, role, userId, name };
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
    const active = fifo.find((s) => s.status === 'active') || fifo.find((s) => s.id === id);
    if (active) active.status = 'done';
    activeReaderId = null;
    activeReaderName = '';
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
      fifo: DEMO_FIFO.map((s) => ({ ...s })),
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

app.use(express.static(join(__dirname, 'public'), { index: false }));
app.use('/data', express.static(join(__dirname, 'data')));
app.use(
  '/uploads',
  express.static(UPLOADS_DIR, {
    fallthrough: false,
    maxAge: IS_PROD ? '1h' : 0,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', IS_PROD ? 'public, max-age=3600' : 'no-store');
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
    socket.join(currentRoom);

    const state = getRoom(currentRoom);
    socket.emit('state', state);
    socket.emit('joined', {
      roomId: currentRoom,
      role,
      userId: auth.userId,
      name: auth.name,
      localDev: LOCAL_DEV,
    });

    const peers = listRoomPeers(currentRoom).filter((p) => p.socketId !== socket.id);
    socket.emit('av-roster', peers);
    socket.to(currentRoom).emit('av-peer-joined', peerInfo(socket));

    if (role === 'student') {
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
      ...safePatch
    } = patch;
    const next = { ...state, ...safePatch, updatedAt: Date.now() };
    // URL foto hanya melalui share_photo / clear_photo
    next.sharedPhotoUrl = state.sharedPhotoUrl;
    next.sharedPhotoName = state.sharedPhotoName;
    if (patch.mode === 'bacaan') next.hidden = false;
    if (patch.stageView === 'photo') {
      next.stageView = state.sharedPhotoUrl ? 'photo' : 'mushaf';
    } else if (patch.stageView === 'mushaf') {
      next.stageView = 'mushaf';
    }
    publishRoom(currentRoom, next);
  });

  /** Guru muat naik JPG/PNG (base64) untuk dikongsi ke bilik. */
  socket.on('share_photo', (payload = {}) => {
    if (role !== 'teacher' || !currentRoom) return;
    const mime = String(payload.mime || '').toLowerCase().trim();
    const ext = SHARE_MIME[mime];
    if (!ext) {
      socket.emit('share_photo_error', { error: 'Hanya JPG atau PNG dibenarkan' });
      return;
    }
    const raw = String(payload.data || '').replace(/^data:image\/\w+;base64,/, '');
    if (!raw) {
      socket.emit('share_photo_error', { error: 'Fail kosong' });
      return;
    }
    let buf;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      socket.emit('share_photo_error', { error: 'Fail rosak' });
      return;
    }
    if (!buf.length || buf.length > MAX_SHARE_BYTES) {
      socket.emit('share_photo_error', { error: 'Saiz maksimum 6MB' });
      return;
    }
    // Magic bytes asas
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng =
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if ((ext === 'jpg' && !isJpeg) || (ext === 'png' && !isPng)) {
      socket.emit('share_photo_error', { error: 'Format fail tidak sah' });
      return;
    }

    const slug = safeRoomSlug(currentRoom) || 'room';
    const fileName = `${slug}-${Date.now()}.${ext}`;
    const fullPath = join(UPLOADS_DIR, fileName);
    try {
      writeFileSync(fullPath, buf);
    } catch (err) {
      console.error('share_photo write', err);
      socket.emit('share_photo_error', { error: 'Gagal simpan fail' });
      return;
    }

    const state = getRoom(currentRoom);
    removeSharedPhotoFile(state.sharedPhotoUrl);
    const name = String(payload.name || fileName)
      .trim()
      .replace(/[^\w.\- ()[\]]+/g, '_')
      .slice(0, 120);
    const showNow = payload.show !== false;
    publishRoom(currentRoom, {
      ...state,
      sharedPhotoUrl: `/uploads/${fileName}`,
      sharedPhotoName: name || fileName,
      stageView: showNow ? 'photo' : state.stageView === 'photo' ? 'photo' : 'mushaf',
      updatedAt: Date.now(),
    });
  });

  socket.on('clear_photo', () => {
    if (role !== 'teacher' || !currentRoom) return;
    const state = getRoom(currentRoom);
    removeSharedPhotoFile(state.sharedPhotoUrl);
    publishRoom(currentRoom, {
      ...state,
      sharedPhotoUrl: null,
      sharedPhotoName: '',
      stageView: 'mushaf',
      updatedAt: Date.now(),
    });
  });

  socket.on('fifo_action', (action = {}) => {
    if (role !== 'teacher' || !currentRoom) return;
    const state = getRoom(currentRoom);
    const next = applyFifoAction(state, action);
    if (action.type === 'mute_all') {
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
    socket.to(currentRoom).emit('av-peer-left', {
      socketId: socket.id,
      userId: socket.data.userId,
    });
    if (role === 'teacher') {
      socket.to(currentRoom).emit('teacher_online', false);
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
