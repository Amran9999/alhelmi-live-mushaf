/**
 * Audio/video bilik: kamera+mic lokal + WebRTC star (guru ↔ setiap pelajar).
 * Cam dan mic dikawal berasingan (track.enabled).
 */

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export function createClassroomAv({
  socket,
  role,
  userId,
  localVideo,
  remoteVideoMap = new Map(),
  onRemoteStream,
  onRemoteGone,
  onMediaState,
  onStatus,
}) {
  let localStream = null;
  let camOn = true;
  let micOn = true;
  let mutePolicy = { muteAllExceptActive: false, activeReaderId: null };
  /** @type {Map<string, RTCPeerConnection>} */
  const pcs = new Map();
  const polite = role !== 'teacher'; // pelajar polite; guru initiate

  function status(msg) {
    onStatus?.(msg);
  }

  function broadcastMediaState() {
    socket.emit('av-media-state', { camOn, micOn: getEffectiveMicOn() });
  }

  function getEffectiveMicOn() {
    if (!micOn) return false;
    if (mutePolicy.muteAllExceptActive && role === 'student') {
      return mutePolicy.activeReaderId === userId;
    }
    return true;
  }

  function applyTrackEnables() {
    if (!localStream) return;
    for (const t of localStream.getVideoTracks()) t.enabled = camOn;
    const allowMic = getEffectiveMicOn();
    for (const t of localStream.getAudioTracks()) t.enabled = allowMic;
    if (localVideo) localVideo.classList.toggle('is-cam-off', !camOn);
    broadcastMediaState();
  }

  async function startLocal() {
    if (localStream) return localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.muted = true;
        localVideo.playsInline = true;
        await localVideo.play().catch(() => {});
      }
      applyTrackEnables();
      status('Kamera & mikrofon aktif');
      return localStream;
    } catch (err) {
      console.error(err);
      status(`Gagal akses media: ${err.message || err.name}`);
      throw err;
    }
  }

  function setCam(on) {
    camOn = Boolean(on);
    applyTrackEnables();
  }

  function setMic(on) {
    micOn = Boolean(on);
    applyTrackEnables();
  }

  function toggleCam() {
    setCam(!camOn);
    return camOn;
  }

  function toggleMic() {
    setMic(!micOn);
    return micOn;
  }

  function applyMutePolicy(policy) {
    mutePolicy = {
      muteAllExceptActive: Boolean(policy?.muteAllExceptActive),
      activeReaderId: policy?.activeReaderId || null,
    };
    applyTrackEnables();
  }

  function attachRemote(socketId, stream) {
    const el = remoteVideoMap.get(socketId);
    if (el) {
      el.srcObject = stream;
      el.playsInline = true;
      el.play().catch(() => {});
    }
    onRemoteStream?.(socketId, stream);
  }

  async function ensurePc(remoteSocketId, peerMeta = {}) {
    if (pcs.has(remoteSocketId)) return pcs.get(remoteSocketId);

    await startLocal();
    const pc = new RTCPeerConnection(ICE);
    pcs.set(remoteSocketId, pc);

    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      socket.emit('av-signal', {
        to: remoteSocketId,
        signal: { type: 'ice', candidate: ev.candidate },
      });
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      attachRemote(remoteSocketId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closePeer(remoteSocketId);
      }
    };

    pc._meta = peerMeta;
    return pc;
  }

  async function callPeer(remoteSocketId, peerMeta = {}) {
    const pc = await ensurePc(remoteSocketId, peerMeta);
    if (pc._makingOffer) return;
    pc._makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('av-signal', {
        to: remoteSocketId,
        signal: { type: 'offer', sdp: pc.localDescription },
      });
    } finally {
      pc._makingOffer = false;
    }
  }

  async function handleSignal({ from, signal, peer }) {
    const pc = await ensurePc(from, peer || {});
    try {
      if (signal.type === 'offer') {
        if (pc._makingOffer && !polite) return;
        await pc.setRemoteDescription(signal.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('av-signal', {
          to: from,
          signal: { type: 'answer', sdp: pc.localDescription },
        });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(signal.sdp);
      } else if (signal.type === 'ice' && signal.candidate) {
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (e) {
          if (!pc.remoteDescription) console.warn('ICE before remote desc', e);
        }
      }
    } catch (err) {
      console.error('av-signal error', err);
      status(`Ralat sambungan AV: ${err.message}`);
    }
  }

  function closePeer(socketId) {
    const pc = pcs.get(socketId);
    if (pc) {
      pc.close();
      pcs.delete(socketId);
    }
    const el = remoteVideoMap.get(socketId);
    if (el) el.srcObject = null;
    onRemoteGone?.(socketId);
  }

  function closeAll() {
    for (const id of [...pcs.keys()]) closePeer(id);
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
    }
    if (localVideo) localVideo.srcObject = null;
  }

  /** Guru initiate ke semua pelajar; pelajar hanya jawab offer. */
  async function onRoster(peers = []) {
    await startLocal().catch(() => null);
    if (!localStream || role !== 'teacher') return;
    for (const p of peers) {
      if (p.role === 'student') callPeer(p.socketId, p).catch(console.error);
    }
  }

  async function onPeerJoined(peer) {
    await startLocal().catch(() => null);
    if (!localStream) return;
    if (role === 'teacher' && peer.role === 'student') {
      callPeer(peer.socketId, peer).catch(console.error);
    }
  }

  socket.on('av-roster', onRoster);
  socket.on('av-peer-joined', onPeerJoined);
  socket.on('av-peer-left', ({ socketId }) => closePeer(socketId));
  socket.on('av-signal', handleSignal);
  socket.on('av-mute-policy', applyMutePolicy);
  socket.on('av-media-state', (state) => onMediaState?.(state));

  // Minta roster semula — elak race jika join lebih awal dari listener
  socket.emit('av-ready');

  return {
    startLocal,
    setCam,
    setMic,
    toggleCam,
    toggleMic,
    applyMutePolicy,
    getState: () => ({ camOn, micOn: getEffectiveMicOn(), wantMic: micOn }),
    closeAll,
  };
}
