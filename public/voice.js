/**
 * ================= 语音对讲模块（WebRTC 点对点） =================
 * 音频流直接在两个浏览器之间传输，不经过服务器；
 * 服务器只负责转发 offer / answer / ICE 候选等信令。
 */
(function () {
  'use strict';

  const V = {
    pc: null,              // RTCPeerConnection
    localStream: null,     // 本地麦克风流
    remoteAudio: null,     // 播放对方声音的 <audio>
    state: 'idle',         // idle | inviting | ringing | connecting | active | ended
    muted: false,
    speakerOff: false,
    connectedAt: 0,
    statsTimer: null,
    send: null,            // 由 app.js 注入：向对手发送信令
    onStateChange: null,   // 状态回调
  };

  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  };

  const isSupported = () =>
    !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  function setState(s, extra) {
    V.state = s;
    if (V.onStateChange) V.onStateChange(s, extra);
  }

  /* ---------- 采集麦克风 ---------- */
  async function getMic() {
    if (V.localStream) return V.localStream;
    if (!isSupported()) throw new Error('当前浏览器不支持语音通话，请使用 HTTPS 或现代浏览器');
    V.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,      // 回声消除，避免对局中自己声音回灌
        noiseSuppression: true,      // 降噪
        autoGainControl: true,       // 自动增益
        channelCount: 1,
      },
      video: false,
    });
    return V.localStream;
  }

  /* ---------- 创建连接（可带缓冲的 ICE 候选队列） ---------- */
  function createPeer() {
    if (V.pc) return V.pc;
    const pc = new RTCPeerConnection(ICE_CONFIG);
    V.pc = pc;
    V.pendingIce = [];   // 在 remoteDescription 设置前先缓存候选

    pc.onicecandidate = e => {
      if (e.candidate && V.send) V.send({ action: 'ice', payload: e.candidate.toJSON() });
    };

    pc.ontrack = e => {
      V.remoteAudio = V.remoteAudio || document.getElementById('remoteAudio');
      if (V.remoteAudio) {
        V.remoteAudio.srcObject = e.streams[0];
        V.remoteAudio.play().catch(() => {});
      }
      setState('active');
      V.connectedAt = Date.now();
      startStats();
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') setState('active');
      else if (st === 'connecting') setState('connecting');
      else if (st === 'failed') { setState('ended', '连接失败'); hangup(true); }
      else if (st === 'disconnected') setState('ended', '连接中断');
      else if (st === 'closed') setState('ended');
    };

    // 加入本地音轨
    if (V.localStream) {
      V.localStream.getAudioTracks().forEach(tr => pc.addTrack(tr, V.localStream));
    }
    return pc;
  }

  /* ---------- 通话计时 / 质量统计 ---------- */
  function startStats() {
    stopStats();
    V.statsTimer = setInterval(async () => {
      if (!V.pc) return;
      try {
        const stats = await V.pc.getStats();
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            V.lastJitter = r.jitter ? (r.jitter * 1000).toFixed(0) + 'ms' : '—';
            V.lastPacketsLost = r.packetsLost || 0;
          }
        });
      } catch {}
    }, 3000);
  }
  function stopStats() { if (V.statsTimer) clearInterval(V.statsTimer); V.statsTimer = null; }
  function duration() { return V.connectedAt ? Math.floor((Date.now() - V.connectedAt) / 1000) : 0; }

  /* ---------- 发起呼叫（主叫） ---------- */
  async function invite() {
    if (V.state === 'active' || V.state === 'connecting') return;
    try {
      await getMic();
      setState('inviting');
      if (V.send) V.send({ action: 'invite' });
    } catch (e) {
      setState('idle');
      throw e;
    }
  }

  /* ---------- 对方收到邀请后同意（被叫） ---------- */
  async function accept() {
    try {
      await getMic();
      setState('connecting');
      if (V.send) V.send({ action: 'accept' });
    } catch (e) {
      setState('idle');
      if (V.send) V.send({ action: 'decline' });
      throw e;
    }
  }

  function decline() {
    setState('idle');
    if (V.send) V.send({ action: 'decline' });
  }

  /* ---------- 信令处理 ---------- */
  async function handleSignal(msg) {
    const act = msg.action;
    const pl = msg.payload;

    switch (act) {
      case 'invite':
        if (V.state === 'active') {
          // 已在通话中，直接回复 accept 以重建
          if (V.send) V.send({ action: 'accept' });
        } else {
          setState('ringing', msg.by);
        }
        break;

      case 'accept':
        // 我是主叫方，收到对方同意 → 我发 offer
        setState('connecting');
        await sendOffer();
        break;

      case 'decline':
        setState('ended', '对方拒绝了通话');
        cleanup();
        break;

      case 'offer':
        // 我是被叫方，收到 offer → 回 answer
        await receiveOffer(pl);
        break;

      case 'answer':
        // 我是主叫方，收到 answer
        await receiveAnswer(pl);
        break;

      case 'ice':
        await addIce(pl);
        break;

      case 'hangup':
        setState('ended', '对方已挂断');
        cleanup(false);
        break;

      case 'mute':
        if (V.onStateChange) V.onStateChange('peerMute', pl);
        break;
    }
  }

  async function sendOffer() {
    const pc = createPeer();
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    if (V.send) V.send({ action: 'offer', payload: { sdp: pc.localDescription.sdp, type: pc.localDescription.type } });
  }

  async function receiveOffer(payload) {
    const pc = createPeer();
    await pc.setRemoteDescription(new RTCSessionDescription(payload));
    await flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (V.send) V.send({ action: 'answer', payload: { sdp: pc.localDescription.sdp, type: pc.localDescription.type } });
  }

  async function receiveAnswer(payload) {
    if (!V.pc) return;
    await V.pc.setRemoteDescription(new RTCSessionDescription(payload));
    await flushIce();
  }

  async function addIce(candidate) {
    if (!candidate) return;
    if (V.pc && V.pc.remoteDescription && V.pc.remoteDescription.type) {
      try { await V.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    } else {
      V.pendingIce = V.pendingIce || [];
      V.pendingIce.push(candidate);
    }
  }

  async function flushIce() {
    if (!V.pendingIce || !V.pc) return;
    for (const c of V.pendingIce) {
      try { await V.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    V.pendingIce = [];
  }

  /* ---------- 挂断 ---------- */
  function hangup(notifyPeer) {
    if (notifyPeer !== false && V.send) V.send({ action: 'hangup' });
    cleanup();
    setState('idle');
  }

  function cleanup(keepStream) {
    stopStats();
    if (V.pc) {
      try { V.pc.ontrack = null; V.pc.onicecandidate = null; V.pc.onconnectionstatechange = null; V.pc.close(); } catch {}
      V.pc = null;
    }
    if (V.remoteAudio) { try { V.remoteAudio.srcObject = null; } catch {} }
    V.pendingIce = [];
    V.connectedAt = 0;
    if (!keepStream && V.localStream) {
      V.localStream.getTracks().forEach(t => t.stop());
      V.localStream = null;
    }
  }

  /* ---------- 静音 / 免提 ---------- */
  function toggleMute() {
    V.muted = !V.muted;
    if (V.localStream) V.localStream.getAudioTracks().forEach(t => { t.enabled = !V.muted; });
    if (V.send) V.send({ action: 'mute', payload: V.muted });
    return V.muted;
  }

  function toggleSpeaker() {
    V.speakerOff = !V.speakerOff;
    if (V.remoteAudio) V.remoteAudio.muted = V.speakerOff;
    return V.speakerOff;
  }

  /* ---------- 音量检测（说话时头像发光） ---------- */
  function createLevelMeter(stream, onLevel) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      let raf;
      const loop = () => {
        an.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        onLevel(Math.min(1, sum / data.length / 90));
        raf = requestAnimationFrame(loop);
      };
      loop();
      return { stop() { cancelAnimationFrame(raf); try { ctx.close(); } catch {} } };
    } catch { return { stop() {} }; }
  }

  window.Voice = {
    V, isSupported, invite, accept, decline, hangup, handleSignal,
    toggleMute, toggleSpeaker, duration, createLevelMeter,
    get micReady() { return !!V.localStream; },
  };
})();
