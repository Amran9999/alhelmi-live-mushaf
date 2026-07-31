import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, cpSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTES_ROOT = join(__dirname, 'uploads', 'notes');
const INDEX_ROOT = join(__dirname, 'data', 'student-notes');
export const MAX_STUDENT_NOTE_SESSIONS = 3;
export const MAX_PHOTOS_PER_SESSION = 10;

try {
  mkdirSync(NOTES_ROOT, { recursive: true });
  mkdirSync(INDEX_ROOT, { recursive: true });
} catch {
  /* ignore */
}

function safeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
}

function indexPath(userId) {
  return join(INDEX_ROOT, `${safeId(userId) || 'unknown'}.json`);
}

function emptyStore(userId) {
  return { userId: String(userId), sessions: [], updatedAt: Date.now() };
}

export function loadStudentNotes(userId) {
  const id = safeId(userId);
  if (!id) return emptyStore(userId);
  const path = indexPath(id);
  if (!existsSync(path)) return emptyStore(id);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    return {
      userId: id,
      sessions: sessions.map((s) => ({
        sessionId: String(s.sessionId || ''),
        courseId: Number(s.courseId) || null,
        roomId: String(s.roomId || ''),
        label: String(s.label || ''),
        updatedAt: Number(s.updatedAt) || Date.now(),
        photos: Array.isArray(s.photos)
          ? s.photos.filter((p) => p && p.url && p.id)
          : [],
      })).filter((s) => s.sessionId),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  } catch {
    return emptyStore(id);
  }
}

function saveStudentNotes(store) {
  const id = safeId(store.userId);
  if (!id) return;
  mkdirSync(INDEX_ROOT, { recursive: true });
  writeFileSync(
    indexPath(id),
    JSON.stringify({ ...store, userId: id, updatedAt: Date.now() }, null, 2),
    'utf8',
  );
}

function deleteSessionFiles(userId, sessionId) {
  const dir = join(NOTES_ROOT, safeId(userId), safeId(sessionId));
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function pruneSessions(store) {
  store.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  while (store.sessions.length > MAX_STUDENT_NOTE_SESSIONS) {
    const dropped = store.sessions.pop();
    if (dropped) deleteSessionFiles(store.userId, dropped.sessionId);
  }
}

/**
 * Salin fail live upload ke arkib pelajar, kekalkan max 3 sesi.
 * @returns {object|null} store selepas kemas kini
 */
export function archivePhotoForStudent({
  userId,
  sessionId,
  courseId = null,
  roomId = '',
  sourceUrl,
  name,
  photoId,
}) {
  const uid = safeId(userId);
  const sid = safeId(sessionId);
  if (!uid || !sid || !sourceUrl || !String(sourceUrl).startsWith('/uploads/')) {
    return null;
  }

  const srcName = basename(sourceUrl);
  if (!srcName || srcName.includes('..')) return null;
  const srcFull = join(__dirname, 'uploads', srcName);
  // Juga terima path nested /uploads/live/...
  const srcAlt = join(__dirname, String(sourceUrl).replace(/^\//, ''));
  const fromPath = existsSync(srcFull) ? srcFull : existsSync(srcAlt) ? srcAlt : null;
  if (!fromPath) return null;

  const destDir = join(NOTES_ROOT, uid, sid);
  mkdirSync(destDir, { recursive: true });
  const destName = `${Date.now()}-${srcName}`.replace(/[^\w.\-]+/g, '_').slice(0, 160);
  const destFull = join(destDir, destName);
  try {
    cpSync(fromPath, destFull);
  } catch {
    return null;
  }

  const archivedUrl = `/uploads/notes/${uid}/${sid}/${destName}`;
  const store = loadStudentNotes(uid);
  let session = store.sessions.find((s) => s.sessionId === sid);
  if (!session) {
    session = {
      sessionId: sid,
      courseId: courseId || null,
      roomId: String(roomId || ''),
      label: '',
      updatedAt: Date.now(),
      photos: [],
    };
    store.sessions.unshift(session);
  }

  if (session.photos.some((p) => p.id === photoId || p.url === archivedUrl)) {
    session.updatedAt = Date.now();
    pruneSessions(store);
    saveStudentNotes(store);
    return store;
  }

  session.photos.push({
    id: String(photoId || destName).slice(0, 64),
    url: archivedUrl,
    name: String(name || destName).slice(0, 120),
    createdAt: Date.now(),
  });
  while (session.photos.length > MAX_PHOTOS_PER_SESSION) {
    const dropped = session.photos.shift();
    if (dropped?.url?.startsWith('/uploads/notes/')) {
      const full = join(__dirname, String(dropped.url).replace(/^\//, ''));
      try {
        if (existsSync(full)) unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  }
  session.courseId = courseId || session.courseId;
  session.roomId = roomId || session.roomId;
  session.updatedAt = Date.now();
  pruneSessions(store);
  saveStudentNotes(store);
  return store;
}

export function listStudentNotesPayload(userId) {
  const store = loadStudentNotes(userId);
  return {
    userId: store.userId,
    maxSessions: MAX_STUDENT_NOTE_SESSIONS,
    sessions: store.sessions.map((s, index) => ({
      sessionId: s.sessionId,
      courseId: s.courseId,
      roomId: s.roomId,
      updatedAt: s.updatedAt,
      isCurrent: index === 0,
      label: s.label || (index === 0 ? 'Sesi semasa' : `Sesi ${index + 1}`),
      photos: s.photos,
    })),
  };
}
