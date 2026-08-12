import { createClassroomAv } from './media-av.js';

const params = new URLSearchParams(window.location.search);
const roomId = (params.get('room') || 'kelas-a').trim();
/** Diganti dari JWT `joined.userId` (Moodle id) — jangan kekal student-xxxx rawak. */
let userId = (params.get('userId') || `student-${Math.random().toString(36).slice(2, 8)}`).trim();
const name = (params.get('name') || 'Pelajar').trim();
const accessToken = (params.get('token') || '').trim();
const previewMode = params.get('preview') === '1';
const queueOwner = params.get('queue_owner') === 'portal' ? 'portal' : 'mushaf';

/** Dalam iframe portal — sembunyi PiP “Guru” mushaf (Jitsi float = bilik).
 *  PiP “Anda” kekal: preview webcam pelajar (keputusan produk 2 Ogos). */
function isEmbeddedInPortal() {
  if (params.get('embed') === '1') return true;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
const embeddedInPortal = isEmbeddedInPortal();

const frame = document.getElementById('mushaf-frame');
const statusEl = document.getElementById('student-status');
const teacherVideo = document.getElementById('teacher-video');
const teacherMedia = document.getElementById('teacher-media');
const teacherHint = document.getElementById('teacher-av-hint');
const selfVideo = document.getElementById('self-video');
const selfMedia = document.getElementById('self-media');
const selfFallback = document.getElementById('self-fallback');
const selfStatus = document.getElementById('self-av-status');
const btnMic = document.getElementById('self-mic');
const btnCam = document.getElementById('self-cam');
const sharedPhotoStage = document.getElementById('shared-photo-stage');
const sharedPhotoImg = document.getElementById('shared-photo-img');
const stagePhotoStrip = document.getElementById('stage-photo-strip');
const studentNotesBar = document.getElementById('student-notes-bar');
const studentNotesList = document.getElementById('student-notes-list');
const studentNotesCount = document.getElementById('student-notes-count');
const studentNotesToggle = document.getElementById('student-notes-toggle');
const studentNotesClose = document.getElementById('student-notes-close');
const noteLightbox = document.getElementById('student-note-lightbox');
const noteLightboxImg = document.getElementById('student-note-lightbox-img');
const noteLightboxTitle = document.getElementById('student-note-lightbox-title');
const noteLightboxDl = document.getElementById('student-note-lightbox-dl');
const noteLightboxClose = document.getElementById('student-note-lightbox-close');
const previewBanner = document.getElementById('preview-banner');
const labelSelf = document.getElementById('label-self');
const labelTeacher = document.getElementById('label-teacher');
const pipTeacherRemote = document.getElementById('pip-teacher-remote');
const pipSelf = document.getElementById('pip-self');
let archivedNotes = { sessions: [] };

// Portal: biar “Anda”; elak PiP “Guru” mushaf (duplicate Jitsi)
if (embeddedInPortal) {
  if (pipTeacherRemote) pipTeacherRemote.hidden = true;
  document.body.classList.add('is-portal-embed');
}
let joinedRole = 'student';
let joinedName = name;

const mushafQs = new URLSearchParams({
  room: roomId,
  role: 'student',
  embed: '1',
  viewer: '1',
  shell: 'student',
  annotate: '0',
  userId,
  name,
  cb: 'classroom-36',
  queue_owner: queueOwner,
});
if (previewMode) mushafQs.set('preview', '1');
if (accessToken) mushafQs.set('token', accessToken);
else mushafQs.set('local', '1');
frame.src = `/mushaf?${mushafQs.toString()}`;

let lastPostedActiveId = undefined;

function notifyPortalFifoActive(state) {
  if (!embeddedInPortal) return;
  const activeId =
    state?.activeReaderId != null && String(state.activeReaderId).trim() !== ''
      ? String(state.activeReaderId)
      : null;
  if (activeId === lastPostedActiveId) return;
  lastPostedActiveId = activeId;
  try {
    window.parent.postMessage(
      {
        source: 'alhelmi-mushaf',
        type: 'fifo-active-changed',
        activeReaderId: activeId,
        activeReaderName: (state?.activeReaderName || '').trim() || null,
        prevActiveName: null,
        muteAllExceptActive: Boolean(state?.muteAllExceptActive),
      },
      '*',
    );
  } catch {
    /* ignore */
  }
}

function applyViewerLabels() {
  const isTeacherPreview = previewMode || joinedRole === 'teacher';
  document.body.classList.toggle('is-teacher-preview', isTeacherPreview);
  if (previewBanner) previewBanner.hidden = !isTeacherPreview;
  if (labelSelf) {
    labelSelf.textContent = isTeacherPreview ? 'Kamera anda' : 'Anda';
  }
  if (labelTeacher) {
    labelTeacher.textContent = isTeacherPreview ? 'Slot guru' : 'Guru';
  }
  if (teacherHint && isTeacherPreview) {
    teacherHint.textContent = 'Pratonton — slot guru kosong di tab ini';
  }
  if (selfStatus && isTeacherPreview && selfStatus.textContent === 'Menyambung…') {
    selfStatus.textContent = 'Pratonton · kamera tab ini (bukan pelajar)';
  }
  if (pipTeacherRemote) {
    pipTeacherRemote.title = isTeacherPreview
      ? 'Dalam pratonton guru, slot ini tidak menunjukkan diri anda'
      : 'Kamera guru';
  }
  if (selfFallback) {
    const label = isTeacherPreview ? joinedName || 'Guru' : joinedName || name;
    selfFallback.textContent = label
      .split(/\s+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || (isTeacherPreview ? 'G' : 'P');
  }
}

applyViewerLabels();

const socket = io({ autoConnect: false });
let roomState = {};
/** Pilih foto dalam galeri live bila guru sedang papar mode Foto (bukan arkib). */
let localPreviewId = null;

const remoteMap = new Map();

const av = createClassroomAv({
  socket,
  role: 'student',
  userId,
  localVideo: selfVideo,
  remoteVideoMap: remoteMap,
  // Portal: Jitsi = media bilik — jangan rampas kamera dengan WebRTC mushaf.
  skipLocalMedia: embeddedInPortal && !previewMode,
  onRemoteStream(socketId, stream) {
    if (embeddedInPortal) return;
    teacherVideo.srcObject = stream;
    teacherVideo.play().catch(() => {});
    teacherMedia.classList.remove('is-idle');
    teacherHint.textContent = 'Live · Guru';
    remoteMap.set(socketId, teacherVideo);
  },
  onRemoteGone() {
    if (embeddedInPortal) return;
    teacherVideo.srcObject = null;
    teacherMedia.classList.add('is-idle');
    teacherHint.textContent = 'Guru terputus';
  },
  onStatus(msg) {
    if (!selfStatus) return;
    selfStatus.textContent = msg;
    if (selfVideo?.srcObject) selfMedia.classList.remove('is-idle');
  },
});

function refreshToggleUi() {
  if (!btnMic || !btnCam) return;
  const st = av.getState();
  btnMic.classList.toggle('is-off', !st.wantMic);
  btnMic.setAttribute('aria-pressed', st.wantMic ? 'true' : 'false');
  btnCam.classList.toggle('is-off', !st.camOn);
  btnCam.setAttribute('aria-pressed', st.camOn ? 'true' : 'false');
  selfMedia?.classList.toggle('is-cam-off', !st.camOn);
  selfVideo?.classList.toggle('is-cam-off', !st.camOn);
  if (!st.wantMic && roomState.muteAllExceptActive && String(roomState.activeReaderId) !== String(userId)) {
    if (selfStatus) selfStatus.textContent = 'Mic & kamera dimatikan — tunggu giliran anda';
  } else if (st.wantCam && !st.camOn && roomState.muteAllExceptActive) {
    if (selfStatus) selfStatus.textContent = 'Kamera ditutup sehingga giliran anda';
  }
}

btnMic?.addEventListener('click', () => {
  av.toggleMic();
  refreshToggleUi();
});
btnCam?.addEventListener('click', () => {
  av.toggleCam();
  refreshToggleUi();
});

function getSharedPhotos(state = roomState) {
  const list = Array.isArray(state?.sharedPhotos) ? state.sharedPhotos : [];
  if (list.length) return list;
  if (state?.sharedPhotoUrl) {
    return [{
      id: state.sharedPhotoId || 'active',
      url: state.sharedPhotoUrl,
      name: state.sharedPhotoName || 'Foto',
    }];
  }
  return [];
}

function resolvePreviewPhoto(state) {
  const photos = getSharedPhotos(state);
  if (!photos.length) return null;
  if (localPreviewId) {
    const found = photos.find((p) => p.id === localPreviewId);
    if (found) return found;
  }
  return photos.find((p) => p.id === state.sharedPhotoId) || photos[photos.length - 1];
}

function flattenArchivedPhotos() {
  const sessions = Array.isArray(archivedNotes?.sessions) ? archivedNotes.sessions : [];
  const items = [];
  sessions.forEach((session, sIndex) => {
    const photos = Array.isArray(session.photos) ? session.photos : [];
    photos.forEach((photo, pIndex) => {
      items.push({
        ...photo,
        sessionId: session.sessionId,
        sessionLabel: session.label || (session.isCurrent ? 'Sesi semasa' : `Sesi ${sIndex + 1}`),
        noteLabel: `Nota ${pIndex + 1}`,
      });
    });
  });
  return items;
}

function setNotesExpanded(open) {
  if (!studentNotesBar) return;
  studentNotesBar.classList.toggle('is-collapsed', !open);
  studentNotesToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function openNoteLightbox(photo) {
  if (!noteLightbox || !photo?.url) return;
  if (noteLightboxImg) noteLightboxImg.src = photo.url;
  if (noteLightboxTitle) {
    noteLightboxTitle.textContent = photo.noteLabel || photo.name || 'Nota';
  }
  if (noteLightboxDl) {
    noteLightboxDl.href = photo.url;
    noteLightboxDl.download = photo.name || 'nota.jpg';
  }
  noteLightbox.hidden = false;
}

function closeNoteLightbox() {
  if (!noteLightbox) return;
  noteLightbox.hidden = true;
  if (noteLightboxImg) noteLightboxImg.removeAttribute('src');
}

function renderStudentNotes(state) {
  const livePhotos = getSharedPhotos(state);
  const archived = flattenArchivedPhotos();
  // Utama: arkib per-pelajar (3 sesi). Live bilik sebagai fallback jika arkib belum sampai.
  const photos = archived.length
    ? archived
    : livePhotos.map((photo, index) => ({
        ...photo,
        sessionLabel: 'Sesi semasa',
        noteLabel: `Nota ${index + 1}`,
      }));

  if (studentNotesCount) {
    studentNotesCount.textContent = String(photos.length);
  }
  if (studentNotesBar) {
    studentNotesBar.hidden = photos.length === 0;
    if (photos.length === 0) setNotesExpanded(false);
  }
  if (!studentNotesList) return;
  studentNotesList.innerHTML = '';

  let lastSession = '';
  photos.forEach((photo) => {
    if (photo.sessionLabel && photo.sessionLabel !== lastSession) {
      lastSession = photo.sessionLabel;
      const head = document.createElement('div');
      head.className = 'student-notes-session';
      head.textContent = lastSession;
      studentNotesList.appendChild(head);
    }
    const row = document.createElement('div');
    row.className = 'student-notes-row';
    row.innerHTML = `
      <button type="button" class="student-note-preview" data-photo-id="${photo.id}" data-photo-url="${photo.url}" data-photo-label="${photo.noteLabel || 'Nota'}" data-photo-name="${photo.name || 'nota.jpg'}">
        <img src="${photo.url}" alt="" />
        <span>${photo.noteLabel || 'Nota'}</span>
      </button>
      <a class="student-note-dl" href="${photo.url}" download="${photo.name || 'nota.jpg'}">Muat turun</a>
    `;
    studentNotesList.appendChild(row);
  });
}

function renderStageStrip(state) {
  const photos = getSharedPhotos(state);
  if (!stagePhotoStrip) return;
  const showPhoto = state.stageView === 'photo' && photos.length > 0;
  stagePhotoStrip.hidden = !showPhoto || photos.length < 2;
  if (stagePhotoStrip.hidden) {
    stagePhotoStrip.innerHTML = '';
    return;
  }
  const activeId = resolvePreviewPhoto(state)?.id;
  stagePhotoStrip.innerHTML = photos
    .map(
      (photo, index) => `
      <button type="button" class="stage-photo-chip${photo.id === activeId ? ' is-active' : ''}" data-photo-id="${photo.id}">
        ${index + 1}
      </button>`,
    )
    .join('');
}

function applyStageView(state) {
  const photos = getSharedPhotos(state);
  // Hanya guru (suis Foto) yang ganti mushaf — arkib nota pelajar tidak rampas skrin.
  const showPhoto = state.stageView === 'photo' && photos.length > 0;
  const preview = showPhoto ? resolvePreviewPhoto(state) : null;
  const displayUrl = preview?.url || null;

  if (!showPhoto) localPreviewId = null;

  frame.classList.toggle('is-hidden-stage', Boolean(showPhoto));
  if (sharedPhotoStage) sharedPhotoStage.hidden = !showPhoto;

  if (showPhoto && sharedPhotoImg && displayUrl) {
    const next = new URL(displayUrl, window.location.origin).href;
    if (sharedPhotoImg.src !== next) sharedPhotoImg.src = displayUrl;
  } else if (sharedPhotoImg) {
    sharedPhotoImg.removeAttribute('src');
  }

  renderStudentNotes(state);
  renderStageStrip(state);
}

studentNotesToggle?.addEventListener('click', () => {
  const open = studentNotesBar?.classList.contains('is-collapsed');
  setNotesExpanded(Boolean(open));
});
studentNotesClose?.addEventListener('click', () => setNotesExpanded(false));
noteLightboxClose?.addEventListener('click', () => closeNoteLightbox());
noteLightbox?.addEventListener('click', (event) => {
  if (event.target === noteLightbox) closeNoteLightbox();
});

studentNotesList?.addEventListener('click', (event) => {
  const btn = event.target.closest('.student-note-preview[data-photo-url]');
  if (!btn?.dataset.photoUrl) return;
  event.preventDefault();
  openNoteLightbox({
    id: btn.dataset.photoId,
    url: btn.dataset.photoUrl,
    noteLabel: btn.dataset.photoLabel,
    name: btn.dataset.photoName,
  });
});

socket.on('student_notes', (payload) => {
  archivedNotes = payload || { sessions: [] };
  renderStudentNotes(roomState);
});

stagePhotoStrip?.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-photo-id]');
  if (!chip?.dataset.photoId) return;
  // Hanya tukar foto dalam mode Foto guru — jangan sentuh mushaf.
  if (roomState?.stageView !== 'photo') return;
  localPreviewId = chip.dataset.photoId;
  applyStageView(roomState);
});

socket.on('state', (state) => {
  roomState = state || {};
  const photos = getSharedPhotos(roomState);
  if (localPreviewId && !photos.some((p) => p.id === localPreviewId)) {
    localPreviewId = null;
  }

  const active = state.activeReaderName || '—';
  const meActive =
    state.activeReaderId != null && String(state.activeReaderId) === String(userId);
  const turn = meActive ? 'Giliran Anda: Sedang Baca' : 'Giliran Anda: Menunggu';
  const sync = state.pageSync === false ? 'Sync Off' : 'Sync On';
  const mode = state.mode === 'hafazan' ? 'Hafazan' : 'Bacaan';
  const stage = state.stageView === 'photo' && photos.length ? `Foto ${photos.length}/10` : 'Mushaf';
  statusEl.textContent = `Status: Berlangsung · ${turn} · ${mode} · ${sync} · Paparan: ${stage} · Guru menyemak: ${active}`;

  applyStageView(state);
  notifyPortalFifoActive(state);

  if (state.muteAllExceptActive) {
    av.applyMutePolicy({
      muteAllExceptActive: true,
      activeReaderId: state.activeReaderId,
    });
    refreshToggleUi();
  }
});

socket.on('av-mute-policy', (policy) => {
  av.applyMutePolicy(policy);
  refreshToggleUi();
});

socket.on('joined', (payload = {}) => {
  joinedRole = payload.role === 'teacher' ? 'teacher' : 'student';
  joinedName = payload.name || name;
  if (payload.userId != null && String(payload.userId).trim() !== '') {
    userId = String(payload.userId);
    av.setUserId(userId);
  }
  applyViewerLabels();
  if (roomState && Object.keys(roomState).length) {
    notifyPortalFifoActive(roomState);
  }
});

socket.connect();
socket.emit('join', {
  token: accessToken || undefined,
  roomId: accessToken ? undefined : roomId,
  role: previewMode ? undefined : 'student',
  userId: previewMode ? undefined : userId,
  name: previewMode ? undefined : name,
  queueOwner,
});

const mediaRefreshId = window.setInterval(() => {
  if (!socket.connected) return;
  socket.emit('notes_list');
  socket.emit('state_refresh');
}, 20 * 60 * 1000);
window.addEventListener(
  'beforeunload',
  () => {
    window.clearInterval(mediaRefreshId);
  },
  { once: true },
);

if (embeddedInPortal && !previewMode) {
  selfMedia?.classList.add('is-idle');
  if (selfStatus) {
    selfStatus.textContent = 'Kamera bilik: gunakan tetingkap Kamera (Jitsi)';
  }
  if (pipSelf) pipSelf.hidden = true;
} else {
  av.startLocal()
    .then(() => {
      selfMedia.classList.remove('is-idle');
      refreshToggleUi();
      applyViewerLabels();
    })
    .catch(() => {
      selfStatus.textContent = previewMode
        ? 'Pratonton · benarkan kamera untuk uji paparan'
        : 'Benarkan kamera/mic dalam browser';
    });
}

window.addEventListener('beforeunload', () => av.closeAll());
