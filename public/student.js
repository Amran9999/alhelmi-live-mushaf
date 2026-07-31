import { createClassroomAv } from './media-av.js';

const params = new URLSearchParams(window.location.search);
const roomId = (params.get('room') || 'kelas-a').trim();
const userId = (params.get('userId') || `student-${Math.random().toString(36).slice(2, 8)}`).trim();
const name = (params.get('name') || 'Pelajar').trim();
const accessToken = (params.get('token') || '').trim();

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

const mushafQs = new URLSearchParams({
  room: roomId,
  role: 'student',
  embed: '1',
  viewer: '1',
  userId,
  name,
  cb: 'classroom-26',
});
if (accessToken) mushafQs.set('token', accessToken);
else mushafQs.set('local', '1');
frame.src = `/mushaf?${mushafQs.toString()}`;

selfFallback.textContent = name
  .split(/\s+/)
  .map((p) => p[0])
  .join('')
  .slice(0, 2)
  .toUpperCase() || 'P';

const socket = io({ autoConnect: false });
let roomState = {};
/** Pelajar boleh pilih foto lokal untuk paparan/muat turun tanpa kawal guru. */
let localPreviewId = null;

const remoteMap = new Map();

const av = createClassroomAv({
  socket,
  role: 'student',
  userId,
  localVideo: selfVideo,
  remoteVideoMap: remoteMap,
  onRemoteStream(socketId, stream) {
    teacherVideo.srcObject = stream;
    teacherVideo.play().catch(() => {});
    teacherMedia.classList.remove('is-idle');
    teacherHint.textContent = 'Live · Guru';
    remoteMap.set(socketId, teacherVideo);
  },
  onRemoteGone() {
    teacherVideo.srcObject = null;
    teacherMedia.classList.add('is-idle');
    teacherHint.textContent = 'Guru terputus';
  },
  onStatus(msg) {
    selfStatus.textContent = msg;
    if (selfVideo.srcObject) selfMedia.classList.remove('is-idle');
  },
});

function refreshToggleUi() {
  const st = av.getState();
  btnMic.classList.toggle('is-off', !st.wantMic);
  btnMic.setAttribute('aria-pressed', st.wantMic ? 'true' : 'false');
  btnCam.classList.toggle('is-off', !st.camOn);
  btnCam.setAttribute('aria-pressed', st.camOn ? 'true' : 'false');
  selfMedia.classList.toggle('is-cam-off', !st.camOn);
  selfVideo.classList.toggle('is-cam-off', !st.camOn);
  if (!st.wantMic && roomState.muteAllExceptActive && roomState.activeReaderId !== userId) {
    selfStatus.textContent = 'Mikrofon dimatikan oleh guru';
  }
}

btnMic.addEventListener('click', () => {
  av.toggleMic();
  refreshToggleUi();
});
btnCam.addEventListener('click', () => {
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

function renderStudentNotes(state) {
  const photos = getSharedPhotos(state);
  if (studentNotesCount) studentNotesCount.textContent = `${photos.length}/10`;
  if (studentNotesBar) studentNotesBar.hidden = photos.length === 0;
  if (!studentNotesList) return;
  studentNotesList.innerHTML = '';
  photos.forEach((photo, index) => {
    const li = document.createElement('li');
    const active = resolvePreviewPhoto(state)?.id === photo.id;
    li.className = active ? 'is-active' : '';
    li.innerHTML = `
      <button type="button" class="student-note-preview" data-photo-id="${photo.id}">
        <img src="${photo.url}" alt="" />
        <span>Nota ${index + 1}</span>
      </button>
      <a class="student-note-dl" href="${photo.url}" download="${photo.name || `nota-${index + 1}.jpg`}">Muat turun</a>
    `;
    studentNotesList.appendChild(li);
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
  const showPhoto = state.stageView === 'photo' && photos.length > 0;
  const preview = resolvePreviewPhoto(state);

  frame.classList.toggle('is-hidden-stage', Boolean(showPhoto));
  if (sharedPhotoStage) sharedPhotoStage.hidden = !showPhoto;

  if (showPhoto && sharedPhotoImg && preview) {
    const next = new URL(preview.url, window.location.origin).href;
    if (sharedPhotoImg.src !== next) sharedPhotoImg.src = preview.url;
  } else if (sharedPhotoImg) {
    sharedPhotoImg.removeAttribute('src');
  }

  renderStudentNotes(state);
  renderStageStrip(state);
}

studentNotesList?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-photo-id]');
  if (!btn?.dataset.photoId) return;
  localPreviewId = btn.dataset.photoId;
  applyStageView(roomState);
});

stagePhotoStrip?.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-photo-id]');
  if (!chip?.dataset.photoId) return;
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
  const meActive = state.activeReaderId && state.activeReaderId === userId;
  const turn = meActive ? 'Giliran Anda: Sedang Baca' : 'Giliran Anda: Menunggu';
  const sync = state.pageSync === false ? 'Sync Off' : 'Sync On';
  const mode = state.mode === 'hafazan' ? 'Hafazan' : 'Bacaan';
  const stage = state.stageView === 'photo' && photos.length ? `Foto ${photos.length}/10` : 'Mushaf';
  statusEl.textContent = `Status: Berlangsung · ${turn} · ${mode} · ${sync} · Paparan: ${stage} · Guru menyemak: ${active}`;

  applyStageView(state);

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

socket.connect();
socket.emit('join', {
  token: accessToken || undefined,
  roomId: accessToken ? undefined : roomId,
  role: 'student',
  userId,
  name,
});

av.startLocal()
  .then(() => {
    selfMedia.classList.remove('is-idle');
    refreshToggleUi();
  })
  .catch(() => {
    selfStatus.textContent = 'Benarkan kamera/mic dalam browser';
  });

window.addEventListener('beforeunload', () => av.closeAll());
