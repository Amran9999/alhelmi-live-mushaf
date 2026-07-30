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

const mushafQs = new URLSearchParams({
  room: roomId,
  role: 'student',
  embed: '1',
  viewer: '1',
  userId,
  name,
  cb: 'classroom-21',
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

const remoteMap = new Map();
// Guru video diguna bila stream remote masuk (socketId guru tidak diketahui awal)

const av = createClassroomAv({
  socket,
  role: 'student',
  userId,
  localVideo: selfVideo,
  remoteVideoMap: remoteMap,
  onRemoteStream(socketId, stream) {
    // Papar aliran jauh sebagai guru (star: hanya guru menghantar ke pelajar dulu;
    // pelajar juga menghantar ke guru — stream jauh di sini = guru)
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

socket.on('state', (state) => {
  roomState = state || {};
  const active = state.activeReaderName || '—';
  const meActive = state.activeReaderId && state.activeReaderId === userId;
  const turn = meActive ? 'Giliran Anda: Sedang Baca' : 'Giliran Anda: Menunggu';
  const sync = state.pageSync === false ? 'Sync Off' : 'Sync On';
  const mode = state.mode === 'hafazan' ? 'Hafazan' : 'Bacaan';
  statusEl.textContent = `Status: Berlangsung · ${turn} · ${mode} · ${sync} · Guru menyemak: ${active}`;

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
