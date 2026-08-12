import { createClassroomAv } from './media-av.js';

const params = new URLSearchParams(window.location.search);
const roomId = (params.get('room') || 'kelas-a').trim();
const teacherName = (params.get('name') || 'Ustaz Farid').trim();
const accessToken = (params.get('token') || '').trim();
const localDev = params.get('local') === '1' || params.get('dev') === '1' || !accessToken;
const queueOwner = params.get('queue_owner') === 'portal' ? 'portal' : 'mushaf';

/** Dalam iframe portal — kamera tunggal dikendalikan app (PiP Jitsi boleh seret). */
function isEmbeddedInPortal() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
const embeddedInPortal = isEmbeddedInPortal();
if (queueOwner === 'portal') {
  document.body.classList.add('queue-owner-portal');
}

const els = {
  classTitle: document.getElementById('class-title'),
  teacherName: document.getElementById('teacher-name'), // optional — nama tidak dipaparkan di panel
  connPill: document.getElementById('conn-pill'),
  pageSync: document.getElementById('page-sync'),
  pageSyncLabel: document.getElementById('page-sync-label'),
  fifoCount: document.getElementById('fifo-count'),
  fifoList: document.getElementById('fifo-list'),
  activeSlot: document.getElementById('active-reader-slot'),
  activeName: document.getElementById('active-name'),
  activeInitials: document.getElementById('active-initials'),
  btnEndTurn: document.getElementById('btn-end-turn'),
  btnMuteAll: document.getElementById('btn-mute-all'),
  btnResetFifo: document.getElementById('btn-reset-fifo'),
  muteHint: document.getElementById('mute-hint'),
  studentLink: document.getElementById('student-link'),
  roomLabel: document.getElementById('room-label'),
  mushafFrame: document.getElementById('mushaf-frame'),
  dockSearch: document.getElementById('dock-search'),
  dockResults: document.getElementById('dock-results'),
  dockGo: document.getElementById('dock-go'),
  dockPageLabel: document.getElementById('dock-page-label'),
  dockZoomLabel: document.getElementById('dock-zoom-label'),
  stageTitle: document.getElementById('stage-title'),
  sharedPhotoStage: document.getElementById('shared-photo-stage'),
  sharedPhotoImg: document.getElementById('shared-photo-img'),
  mushafDock: document.querySelector('.mushaf-dock'),
  btnStageMushaf: document.getElementById('btn-stage-mushaf'),
  btnStagePhoto: document.getElementById('btn-stage-photo'),
  btnStageMushafTop: document.getElementById('btn-stage-mushaf-top'),
  btnStagePhotoTop: document.getElementById('btn-stage-photo-top'),
  sharePhotoInput: document.getElementById('share-photo-input'),
  sharePhotoMeta: document.getElementById('share-photo-meta'),
  sharePhotoGallery: document.getElementById('share-photo-gallery'),
  stagePhotoStrip: document.getElementById('stage-photo-strip'),
  shareStatus: document.getElementById('share-status'),
  btnClearPhoto: document.getElementById('btn-clear-photo'),
  btnScreenshotNote: document.getElementById('btn-screenshot-note'),
};

els.classTitle.textContent = roomId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
if (els.teacherName) els.teacherName.textContent = teacherName;
els.roomLabel.textContent = `Bilik: ${roomId}`;

const studentQs = new URLSearchParams({
  room: roomId,
  preview: '1', // guru buka pratonton — bukan akaun pelajar sebenar
  queue_owner: queueOwner,
});
if (accessToken) studentQs.set('token', accessToken);
else studentQs.set('local', '1');
els.studentLink.href = `/student?${studentQs.toString()}`;
els.studentLink.title = 'Pratonton paparan pelajar (anda kekal sebagai guru di tab ini)';

/* viewer=1 → mushaf tanpa toolbar dalam iframe */
const mushafQs = new URLSearchParams({
  room: roomId,
  role: 'teacher',
  embed: '1',
  viewer: '1',
  name: teacherName,
  cb: 'classroom-38',
  queue_owner: queueOwner,
});
if (accessToken) mushafQs.set('token', accessToken);
else mushafQs.set('local', '1');
els.mushafFrame.src = `/mushaf?${mushafQs.toString()}`;

const socket = io({ autoConnect: false });
let roomState = { page: 1, mode: 'bacaan', teacherZoom: 100, pageSync: true };
let navData = null;
let surahCatalog = [];
let navMode = 'surah'; // surah | juz | page
let selectedPage = 1;
/** Nama pembaca aktif sebelumnya — untuk mute Jitsi di portal */
let lastFifoActiveName = '';
/** userId → { camOn, micOn, name } — dikemas dari WebRTC */
const peerMediaByUserId = new Map();
/** name → { camOn, micOn, userId } — fallback bila FIFO id ≠ socket userId */
const peerMediaByName = new Map();

const socketReady = new Promise((resolve) => {
  socket.on('connect', () => {
    els.connPill.textContent = 'Live';
    els.connPill.classList.add('is-live');
  });
  socket.on('disconnect', () => {
    els.connPill.textContent = 'Terputus';
    els.connPill.classList.remove('is-live');
  });
  socket.on('auth_error', (payload) => {
    els.connPill.textContent = payload?.error || 'Auth gagal';
    els.connPill.classList.remove('is-live');
  });
  socket.on('joined', (info) => {
    if (info?.name && els.teacherName) els.teacherName.textContent = info.name;
    if (info?.roomId) {
      els.roomLabel.textContent = `Bilik: ${info.roomId}`;
      els.classTitle.textContent = String(info.roomId)
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    resolve();
  });
  socket.on('state', applyState);
  socket.on('fifo_error', (payload = {}) => {
    const msg = payload.error || 'Giliran gagal dikemas kini.';
    if (els.muteHint) els.muteHint.textContent = msg;
    console.warn('[fifo]', msg);
  });
  socket.connect();
  socket.emit('join', {
    token: accessToken || undefined,
    roomId: accessToken ? undefined : roomId,
    role: 'teacher',
    userId: 'teacher-local',
    name: teacherName,
    localDev: localDev || undefined,
    queueOwner,
  });
});

const mediaRefreshId = window.setInterval(() => {
  if (socket.connected) socket.emit('state_refresh');
}, 20 * 60 * 1000);
window.addEventListener(
  'beforeunload',
  () => {
    window.clearInterval(mediaRefreshId);
  },
  { once: true },
);

async function boot() {
  navData = await fetch('/data/navigation.json').then((r) => r.json());
  surahCatalog = [];
  for (let i = 1; i <= 114; i += 1) {
    surahCatalog.push({
      num: i,
      name: navData.surahNames[String(i)] || `Surah ${i}`,
      page: navData.surahStartPage[String(i)] || 1,
    });
  }
  await socketReady;
  bindDock();
  initTeacherAv();
}

/** Kamera/mic sebenar + WebRTC ke pelajar */
function initTeacherAv() {
  const localVideo = document.getElementById('pip-local-video');
  const fallback = document.getElementById('pip-fallback');
  const mediaWrap = localVideo?.closest('.pip-media');
  const statusEl = document.getElementById('pip-av-status');
  const btnMic = document.getElementById('pip-mic');
  const btnCam = document.getElementById('pip-cam');
  const activeVideo = document.getElementById('active-reader-video');
  const activePhoto = document.getElementById('active-reader-photo');
  const activeCam = activePhoto?.closest('.active-cam') || activeVideo?.closest('.active-cam');
  const activeAvLabel = document.getElementById('active-av-label');
  const pipTeacher = document.getElementById('pip-teacher');
  const pipStudent = document.getElementById('pip-student');
  const pipStudentVideo = document.getElementById('pip-student-video');
  const pipStudentMedia = document.getElementById('pip-student-media');
  const pipStudentFallback = document.getElementById('pip-student-fallback');
  const pipStudentLabel = document.getElementById('pip-student-label');
  const pipStudentStatus = document.getElementById('pip-student-status');

  // Elak dua kamera guru: dalam portal, PiP mushaf disembunyi (Jitsi float = satu kamera)
  if (embeddedInPortal) {
    if (pipTeacher) pipTeacher.hidden = true;
    if (pipStudent) pipStudent.hidden = true;
  }

  const peerBySocket = new Map(); // socketId -> { userId, name, stream, camOn, micOn }

  const LEARN_PUBLIC = (
    params.get('learn') ||
    window.__ALHELMI_LEARN_URL__ ||
    'https://learn.alhelmi.com'
  ).replace(/\/$/, '');

  /** Foto profil Moodle (pix) — bukan webcam. */
  function profilePhotoUrl(userId) {
    const id = String(userId || '').trim();
    if (!/^\d+$/.test(id)) return null;
    return `${LEARN_PUBLIC}/user/pix.php/${id}/f2.jpg`;
  }

  function setActiveReaderPhoto(userId, displayName) {
    if (!activePhoto || !activeCam) return;
    const url = profilePhotoUrl(userId);
    activeCam.classList.remove('has-video');
    if (activeVideo) activeVideo.srcObject = null;
    if (!url) {
      activePhoto.removeAttribute('src');
      activePhoto.hidden = true;
      activeCam.classList.remove('has-photo');
      return;
    }
    activePhoto.hidden = false;
    activePhoto.alt = displayName || 'Foto pelajar';
    if (activePhoto.getAttribute('src') !== url) {
      activePhoto.onload = () => activeCam.classList.add('has-photo');
      activePhoto.onerror = () => {
        activeCam.classList.remove('has-photo');
        activePhoto.hidden = true;
      };
      activePhoto.src = url;
    } else {
      activeCam.classList.add('has-photo');
    }
  }

  function findActivePeer() {
    const fifo = Array.isArray(roomState?.fifo) ? roomState.fifo : [];
    const activeStudent = fifo.find((s) => s.status === 'active');
    const activeId = roomState?.activeReaderId;
    for (const peer of peerBySocket.values()) {
      if (!peer.stream) continue;
      if (activeId && peer.userId === activeId) return peer;
      if (activeStudent && (peer.userId === activeStudent.id || peer.name === activeStudent.name)) {
        return peer;
      }
    }
    // Fallback: satu stream pelajar sahaja
    const streams = [...peerBySocket.values()].filter((p) => p.stream);
    return streams.length === 1 ? streams[0] : null;
  }

  function syncActiveReaderVideo() {
    const fifo = Array.isArray(roomState?.fifo) ? roomState.fifo : [];
    const activeStudent = fifo.find((s) => s.status === 'active');
    const activeId = roomState?.activeReaderId || activeStudent?.id;
    const activeName =
      roomState?.activeReaderName || activeStudent?.name || els.activeName?.textContent || 'Pelajar';

    // Slot FIFO = foto profil (bukan webcam). Webcam kekal di Jitsi / PiP terapung.
    setActiveReaderPhoto(activeId, activeName);

    const match = findActivePeer();
    if (match) {
      const cam = match.camOn !== false ? 'Cam On' : 'Cam Off';
      const mic = match.micOn ? 'Mic On' : 'Mic Off';
      if (activeAvLabel) activeAvLabel.textContent = `Sedang Baca · ${mic} · ${cam}`;
    } else if (activeStudent || roomState?.activeReaderId) {
      if (activeAvLabel) {
        activeAvLabel.textContent = embeddedInPortal
          ? 'Sedang Baca · video live di PiP Kamera (Jitsi)'
          : 'Sedang Baca';
      }
    } else {
      if (activeAvLabel) activeAvLabel.textContent = 'Sedang Baca';
    }

    // PiP terapung pelajar (boleh diseret) — hanya bila bukan dalam portal
    if (!embeddedInPortal && match?.stream && pipStudent && pipStudentVideo) {
      pipStudent.hidden = false;
      if (pipStudentVideo.srcObject !== match.stream) {
        pipStudentVideo.srcObject = match.stream;
        pipStudentVideo.play().catch(() => {});
      }
      pipStudentMedia?.classList.remove('is-idle');
      const name = match.name || roomState?.activeReaderName || 'Pelajar';
      if (pipStudentLabel) pipStudentLabel.textContent = name;
      if (pipStudentFallback) pipStudentFallback.textContent = initials(name);
      if (pipStudentStatus) {
        const cam = match.camOn !== false ? 'Cam On' : 'Cam Off';
        pipStudentStatus.textContent = `Seret ke mana-mana · ${cam}`;
      }
    } else if (pipStudent) {
      pipStudent.hidden = true;
      if (pipStudentVideo) pipStudentVideo.srcObject = null;
      pipStudentMedia?.classList.add('is-idle');
    }
  }

  const av = createClassroomAv({
    socket,
    role: 'teacher',
    userId: 'teacher-local',
    localVideo: embeddedInPortal ? null : localVideo,
    skipLocalMedia: embeddedInPortal,
    onRemoteStream(socketId, stream) {
      const prev = peerBySocket.get(socketId) || {};
      peerBySocket.set(socketId, { ...prev, stream });
      syncActiveReaderVideo();
    },
    onRemoteGone(socketId) {
      peerBySocket.delete(socketId);
      syncActiveReaderVideo();
    },
    onMediaState(state) {
      const prev = peerBySocket.get(state.socketId) || {};
      const merged = {
        ...prev,
        userId: state.userId,
        camOn: state.camOn,
        micOn: state.micOn,
      };
      peerBySocket.set(state.socketId, merged);
      if (state.userId) {
        peerMediaByUserId.set(state.userId, {
          camOn: state.camOn,
          micOn: state.micOn,
          name: merged.name,
        });
      }
      if (merged.name) {
        peerMediaByName.set(merged.name, {
          camOn: state.camOn,
          micOn: state.micOn,
          userId: state.userId,
        });
      }
      syncActiveReaderVideo();
      refreshFifoMediaLabels();
    },
    onStatus(msg) {
      if (statusEl) statusEl.textContent = msg;
      if (mediaWrap && localVideo?.srcObject) {
        mediaWrap.classList.remove('is-idle');
        if (fallback) fallback.textContent = initials(teacherName);
      }
    },
  });

  if (!embeddedInPortal) {
    mediaWrap?.classList.add('is-idle');
    if (fallback) fallback.textContent = initials(teacherName);

    function refreshToggleUi() {
      const st = av.getState();
      btnMic?.classList.toggle('is-off', !st.wantMic);
      btnMic?.setAttribute('aria-pressed', st.wantMic ? 'true' : 'false');
      btnMic && (btnMic.title = st.wantMic ? 'Matikan mikrofon' : 'Hidupkan mikrofon');
      btnCam?.classList.toggle('is-off', !st.camOn);
      btnCam?.setAttribute('aria-pressed', st.camOn ? 'true' : 'false');
      btnCam && (btnCam.title = st.camOn ? 'Matikan kamera' : 'Hidupkan kamera');
      mediaWrap?.classList.toggle('is-cam-off', !st.camOn);
      localVideo?.classList.toggle('is-cam-off', !st.camOn);
    }

    btnMic?.addEventListener('click', (e) => {
      e.stopPropagation();
      av.toggleMic();
      refreshToggleUi();
    });
    btnCam?.addEventListener('click', (e) => {
      e.stopPropagation();
      av.toggleCam();
      refreshToggleUi();
    });

    av.startLocal()
      .then(() => {
        mediaWrap?.classList.remove('is-idle');
        refreshToggleUi();
      })
      .catch(() => {
        mediaWrap?.classList.add('is-idle');
        if (statusEl) statusEl.textContent = 'Seret PiP · benarkan kamera untuk siaran';
      });
  }

  // Simpan peer meta dari roster/join
  socket.on('av-roster', (peers) => {
    for (const p of peers) {
      const prev = peerBySocket.get(p.socketId) || {};
      peerBySocket.set(p.socketId, { ...prev, userId: p.userId, name: p.name });
    }
  });
  socket.on('av-peer-joined', (p) => {
    const prev = peerBySocket.get(p.socketId) || {};
    peerBySocket.set(p.socketId, { ...prev, userId: p.userId, name: p.name });
  });
  socket.on('av-signal', ({ from, peer }) => {
    if (!peer) return;
    const prev = peerBySocket.get(from) || {};
    peerBySocket.set(from, { ...prev, userId: peer.userId, name: peer.name });
  });

  socket.on('state', () => {
    queueMicrotask(syncActiveReaderVideo);
  });

  window.addEventListener('beforeunload', () => av.closeAll());
}

function patch(partial) {
  // Optimistic UI — label dock bergerak serta-merta; server sahkan via event `state`.
  if (partial && typeof partial === 'object') {
    roomState = { ...roomState, ...partial };
    if (partial.page != null && els.dockPageLabel) {
      els.dockPageLabel.textContent = `${clampPage(partial.page)} / 604`;
    }
    if (partial.teacherZoom != null && els.dockZoomLabel) {
      els.dockZoomLabel.textContent = `${clampZoom(partial.teacherZoom)}%`;
    }
    if (partial.mode != null) {
      document.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === partial.mode);
      });
    }
  }
  socket.emit('teacher_update', partial);
}

function clampPage(n) {
  return Math.min(604, Math.max(1, Number(n) || 1));
}

function clampZoom(n) {
  return Math.min(180, Math.max(70, Number(n) || 100));
}

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

function renderPhotoGallery(state) {
  const photos = getSharedPhotos(state);
  const activeId = state.sharedPhotoId || photos[photos.length - 1]?.id;
  const gallery = els.sharePhotoGallery;
  if (!gallery) return;

  gallery.hidden = photos.length === 0;
  gallery.innerHTML = '';
  photos.forEach((photo, index) => {
    const li = document.createElement('li');
    li.className = 'share-photo-item' + (photo.id === activeId ? ' is-active' : '');
    li.innerHTML = `
      <button type="button" class="share-photo-thumb" data-photo-id="${photo.id}" title="Papar ${photo.name}">
        <img src="${photo.url}" alt="" />
        <span>${index + 1}</span>
      </button>
      <a class="share-photo-dl" href="${photo.url}" download="${photo.name || `nota-${index + 1}.jpg`}">Muat turun</a>
      <button type="button" class="share-photo-remove" data-remove-id="${photo.id}" title="Buang">×</button>
    `;
    gallery.appendChild(li);
  });
}

function renderStagePhotoStrip(state) {
  const photos = getSharedPhotos(state);
  const strip = els.stagePhotoStrip;
  if (!strip) return;
  const showPhoto = state.stageView === 'photo' && photos.length > 0;
  strip.hidden = !showPhoto || photos.length < 2;
  if (strip.hidden) {
    strip.innerHTML = '';
    return;
  }
  const activeId = state.sharedPhotoId || photos[photos.length - 1]?.id;
  strip.innerHTML = photos
    .map(
      (photo, index) => `
      <button type="button" class="stage-photo-chip${photo.id === activeId ? ' is-active' : ''}" data-photo-id="${photo.id}">
        ${index + 1}
      </button>`,
    )
    .join('');
}

function setViewSwitchUi(showPhoto, hasPhoto) {
  const pairs = [
    [els.btnStageMushaf, els.btnStagePhoto],
    [els.btnStageMushafTop, els.btnStagePhotoTop],
  ];
  for (const [mushafBtn, photoBtn] of pairs) {
    if (photoBtn) photoBtn.disabled = !hasPhoto;
    mushafBtn?.classList.toggle('active', !showPhoto);
    photoBtn?.classList.toggle('active', showPhoto);
  }
}

function switchStageView(stage) {
  if (stage === 'photo') {
    if (!getSharedPhotos(roomState).length) {
      if (els.sharePhotoMeta) {
        els.sharePhotoMeta.textContent = 'Muat naik atau screenshot foto dulu sebelum tukar ke Foto';
      }
      els.sharePhotoInput?.click();
      return;
    }
    patch({ stageView: 'photo' });
    return;
  }
  patch({ stageView: 'mushaf' });
}

function applyStageView(state) {
  const photos = getSharedPhotos(state);
  const hasPhoto = photos.length > 0;
  const showPhoto = state.stageView === 'photo' && hasPhoto;

  setViewSwitchUi(showPhoto, hasPhoto);
  els.btnClearPhoto.hidden = !hasPhoto;

  if (hasPhoto) {
    els.sharePhotoMeta.textContent = showPhoto
      ? `Pelajar nampak FOTO · ${photos.length}/10 · ${state.sharedPhotoName || 'Nota'}`
      : `Foto sedia (${photos.length}/10) — tekan Foto untuk papar ke pelajar`;
    if (state.sharedPhotoUrl) {
      const next = new URL(state.sharedPhotoUrl, window.location.origin).href;
      if (els.sharedPhotoImg.src !== next) els.sharedPhotoImg.src = state.sharedPhotoUrl;
    }
  } else {
    els.sharePhotoMeta.textContent = 'Tiada foto — muat naik JPG/PNG panduan (huruf/bacaan)';
    els.sharedPhotoImg.removeAttribute('src');
  }

  renderPhotoGallery(state);
  renderStagePhotoStrip(state);

  els.mushafFrame.classList.toggle('is-hidden-stage', showPhoto);
  els.sharedPhotoStage.hidden = !showPhoto;
  els.mushafDock?.classList.toggle('is-hidden-stage', showPhoto);
  if (els.stageTitle) {
    els.stageTitle.textContent = showPhoto
      ? state.sharedPhotoName || 'Foto dikongsi'
      : 'Mushaf Madinah';
  }
  if (els.shareStatus) {
    els.shareStatus.textContent = showPhoto ? `Foto ${photos.length}/10` : 'Mushaf';
  }
}

function notifyPortalFifoActive(state, prevName) {
  if (!embeddedInPortal) return;
  const activeName = (state.activeReaderName || '').trim();
  const activeId = state.activeReaderId || null;
  try {
    window.parent.postMessage(
      {
        source: 'alhelmi-mushaf',
        type: 'fifo-active-changed',
        activeReaderId: activeId,
        activeReaderName: activeName || null,
        prevActiveName: prevName || null,
        muteAllExceptActive: Boolean(state.muteAllExceptActive),
      },
      '*',
    );
  } catch {
    /* ignore */
  }
}

function applyState(state) {
  const prevActiveName = lastFifoActiveName;
  roomState = state;
  const pageSync = state.pageSync !== false;
  els.pageSync.checked = pageSync;
  els.pageSyncLabel.textContent = pageSync ? 'Mod Sync: Aktif' : 'Mod Sync: Off';

  const page = state.page || 1;
  const zoom = state.teacherZoom || 100;
  els.dockPageLabel.textContent = `${page} / 604`;
  els.dockZoomLabel.textContent = `${zoom}%`;
  selectedPage = page;

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === (state.mode || 'bacaan'));
  });

  applyStageView(state);

  const fifo = Array.isArray(state.fifo) ? state.fifo : [];
  const waiting = fifo.filter((s) => s.status === 'waiting' || s.status === 'active');
  els.fifoCount.textContent = `${waiting.length}/${fifo.length}`;

  let active = fifo.find((s) => s.status === 'active') || null;
  if (!active && state.activeReaderId) {
    active = fifo.find((s) => String(s.id) === String(state.activeReaderId)) || null;
  }
  // Sync Moodle/portal boleh set activeReader tanpa entry FIFO — tetap papar slot + Tamat.
  if (!active && (state.activeReaderId || state.activeReaderName)) {
    active = {
      id: state.activeReaderId || 'sync-active',
      name: (state.activeReaderName || '').trim() || 'Pelajar',
      status: 'active',
    };
  }
  if (active) {
    els.activeSlot.hidden = false;
    const label = (active.name || state.activeReaderName || '').trim() || 'Pelajar';
    els.activeName.textContent = label;
    els.activeInitials.textContent = initials(label);
    // Foto profil (bukan webcam) — syncActiveReaderVideo juga akan set semula
    const photo = document.getElementById('active-reader-photo');
    const cam = photo?.closest('.active-cam');
    const url = /^\d+$/.test(String(active.id))
      ? `https://learn.alhelmi.com/user/pix.php/${active.id}/f2.jpg`
      : null;
    if (photo && url) {
      photo.hidden = false;
      photo.alt = label;
      if (photo.getAttribute('src') !== url) photo.src = url;
      cam?.classList.add('has-photo');
    } else if (photo) {
      photo.hidden = true;
      cam?.classList.remove('has-photo');
    }
  } else {
    els.activeSlot.hidden = true;
  }

  els.fifoList.innerHTML = '';
  for (const student of fifo) {
    if (student.status === 'active') continue;
    els.fifoList.appendChild(renderFifoItem(student));
  }

  const nextActiveName = (active?.name || state.activeReaderName || '').trim();
  if (nextActiveName !== prevActiveName) {
    notifyPortalFifoActive(state, prevActiveName);
  }
  lastFifoActiveName = nextActiveName;
}

function bindDock() {
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      navMode = btn.getAttribute('data-nav');
      document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b === btn));
      els.dockSearch.value = '';
      els.dockResults.hidden = true;
      els.dockSearch.placeholder =
        navMode === 'juz' ? 'Juzuk 1–30…' : navMode === 'page' ? 'Halaman 1–604…' : 'Cari surah…';
      els.dockSearch.focus();
    });
  });

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      patch({ mode, ...(mode === 'bacaan' ? { hidden: false } : {}) });
    });
  });

  els.dockPagePrev = document.getElementById('dock-page-prev');
  els.dockPageNext = document.getElementById('dock-page-next');
  els.dockZoomIn = document.getElementById('dock-zoom-in');
  els.dockZoomOut = document.getElementById('dock-zoom-out');

  els.dockPagePrev.addEventListener('click', () => patch({ page: clampPage((roomState.page || 1) - 1) }));
  els.dockPageNext.addEventListener('click', () => patch({ page: clampPage((roomState.page || 1) + 1) }));
  els.dockZoomIn.addEventListener('click', () =>
    patch({ teacherZoom: clampZoom((roomState.teacherZoom || 100) + 10) }),
  );
  els.dockZoomOut.addEventListener('click', () =>
    patch({ teacherZoom: clampZoom((roomState.teacherZoom || 100) - 10) }),
  );

  els.dockGo.addEventListener('click', goDock);
  els.dockSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goDock();
    }
  });
  els.dockSearch.addEventListener('input', onDockSearchInput);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dock-search-wrap')) els.dockResults.hidden = true;
  });
}

function onDockSearchInput() {
  const q = els.dockSearch.value.trim().toLowerCase();
  els.dockResults.innerHTML = '';
  if (!q) {
    els.dockResults.hidden = true;
    return;
  }

  if (navMode === 'surah') {
    const hits = surahCatalog
      .filter((s) => `${s.num} ${s.name}`.toLowerCase().includes(q.replace(/^surah\s+/i, '')))
      .slice(0, 8);
    for (const s of hits) {
      const li = document.createElement('li');
      li.textContent = `${s.num}. ${s.name}`;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectedPage = s.page;
        els.dockSearch.value = `${s.num}. ${s.name}`;
        els.dockResults.hidden = true;
        patch({ page: clampPage(s.page) });
      });
      els.dockResults.appendChild(li);
    }
    els.dockResults.hidden = hits.length === 0;
    return;
  }

  els.dockResults.hidden = true;
}

function goDock() {
  const raw = els.dockSearch.value.trim();
  let page = selectedPage;

  if (navMode === 'page') {
    page = clampPage(raw || roomState.page);
  } else if (navMode === 'juz') {
    const juz = Math.min(30, Math.max(1, Number(raw.replace(/\D/g, '')) || 1));
    page = navData.juzStartPage[String(juz)] || 1;
  } else if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    if (num >= 1 && num <= 114) page = surahCatalog[num - 1]?.page || 1;
    else page = clampPage(num);
  } else if (raw) {
    const hit = surahCatalog.find((s) => s.name.toLowerCase().includes(raw.toLowerCase().replace(/^\d+\.\s*/, '')));
    if (hit) page = hit.page;
  }

  patch({ page: clampPage(page) });
}

els.pageSync.addEventListener('change', () => {
  const on = els.pageSync.checked;
  els.pageSyncLabel.textContent = on ? 'Mod Sync: Aktif' : 'Mod Sync: Off';
  patch({ pageSync: on });
});

els.btnStageMushaf?.addEventListener('click', () => switchStageView('mushaf'));
els.btnStagePhoto?.addEventListener('click', () => switchStageView('photo'));
els.btnStageMushafTop?.addEventListener('click', () => switchStageView('mushaf'));
els.btnStagePhotoTop?.addEventListener('click', () => switchStageView('photo'));
els.btnClearPhoto?.addEventListener('click', () => socket.emit('clear_photo'));

els.sharePhotoGallery?.addEventListener('click', (event) => {
  const thumb = event.target.closest('[data-photo-id]');
  if (thumb?.dataset.photoId) {
    socket.emit('select_photo', { id: thumb.dataset.photoId, show: true });
    return;
  }
  const removeBtn = event.target.closest('[data-remove-id]');
  if (removeBtn?.dataset.removeId) {
    socket.emit('remove_photo', { id: removeBtn.dataset.removeId });
  }
});

els.stagePhotoStrip?.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-photo-id]');
  if (!chip?.dataset.photoId) return;
  socket.emit('select_photo', { id: chip.dataset.photoId, show: true });
});

els.btnScreenshotNote?.addEventListener('click', () => {
  if (els.sharePhotoMeta) els.sharePhotoMeta.textContent = 'Mengambil screenshot nota…';
  postToMushaf({ type: 'annotation-send-note' });
});

els.sharePhotoInput?.addEventListener('change', async () => {
  const file = els.sharePhotoInput.files?.[0];
  els.sharePhotoInput.value = '';
  if (!file) return;
  const okType = file.type === 'image/jpeg' || file.type === 'image/png';
  if (!okType) {
    els.sharePhotoMeta.textContent = 'Hanya JPG atau PNG';
    return;
  }
  if (file.size > 6 * 1024 * 1024) {
    els.sharePhotoMeta.textContent = 'Saiz maksimum 6MB';
    return;
  }
  els.sharePhotoMeta.textContent = `Memuat naik ${file.name}…`;
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('baca gagal'));
      reader.readAsDataURL(file);
    });
    socket.emit('share_photo', {
      mime: file.type,
      data: dataUrl,
      name: file.name,
      show: true,
    });
  } catch {
    els.sharePhotoMeta.textContent = 'Gagal baca fail';
  }
});

socket.on('share_photo_error', (payload) => {
  if (els.sharePhotoMeta) {
    els.sharePhotoMeta.textContent = payload?.error || 'Gagal kongsi foto';
  }
});

/* Status screenshot/nota dari iframe mushaf */
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== 'alhelmi-mushaf' || data.type !== 'share-status') return;
  if (els.sharePhotoMeta) {
    els.sharePhotoMeta.textContent = data.message || (data.error ? 'Gagal hantar nota' : '…');
  }
});

function postToMushaf(payload) {
  const frame = els.mushafFrame;
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage(
    { source: 'alhelmi-classroom', ...payload },
    window.location.origin,
  );
}

/* Keyboard skrol → iframe mushaf (fokus mungkin di shell, bukan iframe) */
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, select')) return;
  const scrollKeys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '];
  if (!scrollKeys.includes(event.key)) return;
  event.preventDefault();
  postToMushaf({ type: 'mushaf-scroll', key: event.key });
});

els.btnEndTurn?.addEventListener('click', () => {
  if (!socket.connected) {
    if (els.muteHint) els.muteHint.textContent = 'Socket terputus — refresh bilik.';
    return;
  }
  socket.emit('fifo_action', { type: 'end' });
  if (els.muteHint) els.muteHint.textContent = 'Menamatkan giliran…';
});

/** Portal (app.alhelmi.com) — Tamat Giliran di luar iframe (elak PiP tutup butang). */
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.source !== 'alhelmi-portal' || data.type !== 'fifo-end') return;
  const okOrigin =
    event.origin === window.location.origin ||
    event.origin === 'https://app.alhelmi.com' ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(event.origin);
  if (!okOrigin) return;
  if (!socket.connected) {
    if (els.muteHint) els.muteHint.textContent = 'Socket terputus — refresh bilik.';
    return;
  }
  socket.emit('fifo_action', { type: 'end' });
  if (els.muteHint) els.muteHint.textContent = 'Menamatkan giliran…';
});
els.btnMuteAll?.addEventListener('click', () => {
  socket.emit('fifo_action', { type: 'mute_all' });
  const active = roomState?.activeReaderName;
  if (els.muteHint) {
    els.muteHint.textContent = active
      ? `Semua dimatikan kecuali ${active}.`
      : 'Mikrofon semua pelajar dimatikan.';
  }
});
els.btnResetFifo?.addEventListener('click', () => socket.emit('fifo_action', { type: 'reset' }));

function mediaMetaForStudent(student) {
  const st = peerMediaByUserId.get(student.id) || peerMediaByName.get(student.name);
  if (!st) return 'Belum bersambung';
  const cam = st.camOn !== false ? 'Cam On' : 'Cam Off';
  const mic = st.micOn ? 'Mic On' : 'Mic Off';
  return `${mic} · ${cam}`;
}

function refreshFifoMediaLabels() {
  for (const li of els.fifoList.querySelectorAll('.fifo-item')) {
    const meta = li.querySelector('.fifo-item-meta');
    const studentId = li.dataset.studentId;
    const studentName = li.dataset.studentName;
    if (!meta) continue;
    const st =
      (studentId && peerMediaByUserId.get(studentId)) ||
      (studentName && peerMediaByName.get(studentName));
    if (st) {
      const cam = st.camOn !== false ? 'Cam On' : 'Cam Off';
      const mic = st.micOn ? 'Mic On' : 'Mic Off';
      meta.textContent = `${mic} · ${cam}`;
    }
  }
}

function renderFifoItem(student) {
  const li = document.createElement('li');
  li.className = 'fifo-item';
  li.dataset.studentId = student.id;
  li.dataset.studentName = student.name;
  if (student.round > 1) li.classList.add('is-review');
  if (student.status === 'done') li.classList.add('is-done');

  const name = document.createElement('div');
  name.className = 'fifo-item-name';
  name.textContent = student.name;

  const badge = document.createElement('span');
  badge.className = 'badge';
  if (student.round > 1) {
    badge.classList.add('badge-review');
    badge.textContent = `Kali ${student.round}`;
  } else if (student.status === 'done') {
    badge.textContent = 'Selesai';
  } else {
    badge.textContent = 'Menunggu';
  }

  const meta = document.createElement('div');
  meta.className = 'fifo-item-meta';
  meta.textContent = mediaMetaForStudent(student);

  const actions = document.createElement('div');
  actions.className = 'btn-row';

  if (student.status === 'waiting') {
    const call = document.createElement('button');
    call.type = 'button';
    call.className = 'btn btn-primary btn-sm';
    call.textContent = 'Panggil';
    call.addEventListener('click', () => socket.emit('fifo_action', { type: 'call', studentId: student.id }));
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn btn-ghost btn-sm';
    skip.textContent = 'Langkau';
    skip.addEventListener('click', () => socket.emit('fifo_action', { type: 'skip', studentId: student.id }));
    actions.append(call, skip);
  } else if (student.status === 'done') {
    const review = document.createElement('button');
    review.type = 'button';
    review.className = 'btn btn-ghost btn-sm';
    review.textContent = 'Ulang baca';
    review.addEventListener('click', () => socket.emit('fifo_action', { type: 'review', studentId: student.id }));
    actions.append(review);
  }

  li.append(name, badge, meta, actions);
  return li;
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** PiP terapung: seret ke mana-mana pada skrin penuh (fixed ke viewport). */
function initDraggablePip({
  pipId = 'pip-teacher',
  shrinkId = 'pip-shrink',
  growId = 'pip-grow',
  largeId = 'pip-large',
  resizeId = 'pip-resize',
  storageSuffix = 'teacher',
  defaultWidth = 148,
} = {}) {
  const pip = document.getElementById(pipId);
  const btnShrink = document.getElementById(shrinkId);
  const btnGrow = document.getElementById(growId);
  const btnLarge = document.getElementById(largeId);
  const resizeHandle = document.getElementById(resizeId);
  if (!pip) return;

  const storageKey = `alquran-pip-screen:${roomId}:${storageSuffix}`;
  const MIN_W = 120;
  const STEP = 36;
  const MARGIN = 8;
  let width = defaultWidth;
  let beforeLarge = defaultWidth;
  let isLarge = false;

  function viewport() {
    return {
      w: window.innerWidth,
      h: window.innerHeight,
    };
  }

  function maxWidth() {
    // Bukan fullscreen: had ~40% lebar skrin, max 380px
    return Math.min(380, Math.max(MIN_W, Math.floor(viewport().w * 0.4)));
  }

  function clampSize(w) {
    return Math.min(maxWidth(), Math.max(MIN_W, Math.round(w)));
  }

  function clampPos(left, top) {
    const { w, h } = viewport();
    const maxL = Math.max(MARGIN, w - pip.offsetWidth - MARGIN);
    const maxT = Math.max(MARGIN, h - pip.offsetHeight - MARGIN);
    return {
      left: Math.min(Math.max(MARGIN, left), maxL),
      top: Math.min(Math.max(MARGIN, top), maxT),
    };
  }

  function applyPos(left, top) {
    const p = clampPos(left, top);
    pip.style.left = `${p.left}px`;
    pip.style.top = `${p.top}px`;
    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
    return p;
  }

  function applySize(w, { keepLargeFlag } = {}) {
    width = clampSize(w);
    pip.style.setProperty('--pip-w', `${width}px`);
    if (!keepLargeFlag) {
      isLarge = width >= maxWidth() - 8;
    }
    pip.classList.toggle('is-large', isLarge);
    btnLarge?.classList.toggle('is-active', isLarge);
    if (pip.style.left) {
      applyPos(parseFloat(pip.style.left) || 0, parseFloat(pip.style.top) || 0);
    }
    persist();
  }

  function persist() {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          left: parseFloat(pip.style.left) || null,
          top: parseFloat(pip.style.top) || null,
          width,
          beforeLarge,
          isLarge,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.width === 'number') width = clampSize(parsed.width);
      if (typeof parsed?.beforeLarge === 'number') beforeLarge = parsed.beforeLarge;
      isLarge = Boolean(parsed?.isLarge);
      pip.style.setProperty('--pip-w', `${width}px`);
      pip.classList.toggle('is-large', isLarge);
      btnLarge?.classList.toggle('is-active', isLarge);
      if (typeof parsed?.left === 'number' && typeof parsed?.top === 'number') {
        applyPos(parsed.left, parsed.top);
      }
    } catch {
      /* ignore */
    }
  }

  restore();

  btnShrink?.addEventListener('click', (e) => {
    e.stopPropagation();
    isLarge = false;
    applySize(width - STEP);
  });
  btnGrow?.addEventListener('click', (e) => {
    e.stopPropagation();
    applySize(width + STEP);
  });
  btnLarge?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isLarge) {
      isLarge = false;
      applySize(beforeLarge || 148, { keepLargeFlag: true });
      pip.classList.remove('is-large');
      btnLarge.classList.remove('is-active');
      persist();
    } else {
      beforeLarge = width;
      isLarge = true;
      applySize(maxWidth(), { keepLargeFlag: true });
      pip.classList.add('is-large');
      btnLarge.classList.add('is-active');
      persist();
    }
  });

  window.addEventListener('resize', () => {
    applySize(width, { keepLargeFlag: true });
    if (pip.style.left) {
      applyPos(parseFloat(pip.style.left) || 0, parseFloat(pip.style.top) || 0);
    }
  });

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originL = 0;
  let originT = 0;

  pip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('.pip-btn, .pip-resize')) return;
    dragging = true;
    pip.classList.add('is-dragging');
    pip.setPointerCapture(event.pointerId);
    const rect = pip.getBoundingClientRect();
    originL = rect.left;
    originT = rect.top;
    startX = event.clientX;
    startY = event.clientY;
    event.preventDefault();
  });

  pip.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const next = applyPos(originL + (event.clientX - startX), originT + (event.clientY - startY));
    originL = next.left;
    originT = next.top;
    startX = event.clientX;
    startY = event.clientY;
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    pip.classList.remove('is-dragging');
    try {
      pip.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    persist();
  }

  pip.addEventListener('pointerup', endDrag);
  pip.addEventListener('pointercancel', endDrag);

  let resizing = false;
  let resizeStartX = 0;
  let resizeStartW = 0;

  resizeHandle?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    resizing = true;
    resizeStartX = event.clientX;
    resizeStartW = width;
    resizeHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  resizeHandle?.addEventListener('pointermove', (event) => {
    if (!resizing) return;
    isLarge = false;
    applySize(resizeStartW + (event.clientX - resizeStartX));
  });

  function endResize(event) {
    if (!resizing) return;
    resizing = false;
    try {
      resizeHandle.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    persist();
  }

  resizeHandle?.addEventListener('pointerup', endResize);
  resizeHandle?.addEventListener('pointercancel', endResize);
}

if (!embeddedInPortal) {
  initDraggablePip({
    pipId: 'pip-teacher',
    shrinkId: 'pip-shrink',
    growId: 'pip-grow',
    largeId: 'pip-large',
    resizeId: 'pip-resize',
    storageSuffix: 'teacher',
  });
  initDraggablePip({
    pipId: 'pip-student',
    shrinkId: 'pip-student-shrink',
    growId: 'pip-student-grow',
    largeId: 'pip-student-large',
    resizeId: 'pip-student-resize',
    storageSuffix: 'student',
    defaultWidth: 168,
  });
}

boot().catch((err) => {
  console.error(err);
  els.connPill.textContent = 'Ralat muat';
});
