'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('esc_' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('esc_' + k, JSON.stringify(v)); } catch (_) {} },
  };
  const LANG_LIST = [['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['fr', 'Français'], ['it', 'Italiano'], ['de', 'Deutsch']];
  const langName = (c) => (LANG_LIST.find((l) => l[0] === c) || [c, c])[1];

  /* ---------- estado ---------- */
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let clientId = LS.get('clientId', null);
  if (!clientId) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    clientId = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    LS.set('clientId', clientId);
  }
  let profile = LS.get('profile', null); // { alias, start, end, enabled, langs }
  let blocked = LS.get('blocked', []);
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let pushCfg = null;
  let deferredInstall = null;

  let ws = null, wsReady = false, reconnectDelay = 1000;
  let call = null;            // { id, role, peerId, peerAlias, pc, pending[], startedAt, timerInt, ... }
  let pendingIncoming = null;
  let localStream = null;
  let lastPeer = null;        // { id, alias } de la última llamada, para poder reportar después
  let wakeLock = null;
  let settingsMode = false;

  /* ---------- UI ---------- */
  const screens = ['welcome', 'setup', 'home', 'searching', 'incoming', 'call', 'end', 'banned'];
  function show(name) {
    screens.forEach((s) => $('s-' + s).classList.toggle('hidden', s !== name));
    window.scrollTo(0, 0);
  }
  let toastT;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3800);
  }
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const toHHMM = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  function nowInWindow() {
    if (!profile) return false;
    if (profile.start === profile.end) return true;
    const d = new Date(); const m = d.getHours() * 60 + d.getMinutes();
    return profile.start < profile.end ? (m >= profile.start && m < profile.end) : (m >= profile.start || m < profile.end);
  }

  function refreshHome() {
    $('who').textContent = profile ? profile.alias : '';
    $('receive').checked = !!profile.enabled;
    $('window-label').textContent = profile.start === profile.end ? 'Cualquier hora' : 'De ' + toHHMM(profile.start) + ' a ' + toHHMM(profile.end);
    $('outside-note').classList.toggle('hidden', !(profile.enabled && !nowInWindow()));
    $('btn-call').disabled = !wsReady;
    $('push-banner').classList.toggle('hidden', !(pushCfg && !LS.get('push', false) && !LS.get('pushBannerOff', false) && 'PushManager' in window && (!isIOS || isStandalone)));
    $('btn-install').classList.toggle('hidden', !deferredInstall || isStandalone);
  }
  function homeVisible() { return !$('s-home').classList.contains('hidden'); }
  function setConn(ok) {
    $('dot').classList.toggle('off', !ok);
    $('conn').textContent = ok ? 'Conectado' : 'Reconectando…';
    if (profile && homeVisible()) refreshHome();
  }

  /* ---------- WebSocket ---------- */
  function sendWS(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  const availPayload = () => ({ start: profile.start, end: profile.end, tz, enabled: !!profile.enabled });
  function pushProfile() {
    if (wsReady && profile) sendWS({ t: 'profile', alias: profile.alias, avail: availPayload(), langs: profile.langs, blocked });
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = () => {
      reconnectDelay = 1000;
      if (!profile) return;
      const hello = { t: 'hello', clientId, alias: profile.alias, avail: availPayload(), langs: profile.langs, blocked, hidden: document.hidden };
      if (call && call.id && call.startedAt) hello.resume = call.id; // reanudar llamada cortada por mala señal
      sendWS(hello);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onServer(m); };
    ws.onclose = () => {
      wsReady = false; setConn(false);
      if (call && call.startedAt) {
        // en llamada: el audio sigue entre los dos celulares; esperamos reconectar unos segundos
        banner('Sin conexión con el servidor… reconectando (el audio sigue si la red lo permite)');
        if (!call.dropTimer) call.dropTimer = setTimeout(() => { if (!wsReady && call) { toast('Se perdió la conexión'); endLocally('La llamada se cortó', 'Se perdió la conexión a internet.'); } }, 25000);
      } else if (call || pendingIncoming) {
        cleanupCall(); goHome(); toast('Se perdió la conexión');
      }
      setTimeout(connect, call && call.startedAt ? Math.min(reconnectDelay, 2000) : reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function banner(text) { const b = $('net-banner'); b.textContent = text || ''; b.classList.toggle('hidden', !text); }

  function onServer(m) {
    switch (m.t) {
      case 'config':
        iceServers = m.iceServers || iceServers; pushCfg = m.push || null; wsReady = true; setConn(true);
        if (call && call.dropTimer) { clearTimeout(call.dropTimer); call.dropTimer = null; }
        resyncPush();
        updateSettingsPush();
        break;
      case 'stats': showStats(m.available); break;
      case 'searching':
        if (call && !call.id) {
          call.id = m.callId;
          if (call.cancelled) { sendWS({ t: 'hangup', callId: call.id }); cleanupCall(); break; }
        }
        $('search-msg').textContent = m.phase === 'push'
          ? 'Avisando por notificación a alguien disponible. Puede tardar hasta un minuto.'
          : 'Sonando para alguien…';
        break;
      case 'no_one':
        cleanupCall();
        endScreen('No hay nadie disponible ahora', 'Nadie está conectado dentro de su horario en este momento. Probá de nuevo en un rato, y dejá la app abierta en tu horario por si alguien te busca.');
        break;
      case 'incoming': onIncoming(m); break;
      case 'missed':
        if (pendingIncoming && pendingIncoming.callId === m.callId) { stopRing(); pendingIncoming = null; goHome(); toast('Llamada perdida'); }
        break;
      case 'matched': onMatched(m); break;
      case 'signal': onSignalSafe(m); break;
      case 'resumed':
        banner('');
        if (call && call.role === 'caller' && call.pc && call.pc.connectionState !== 'connected') tryIceRestart();
        break;
      case 'peer_offline': if (call) banner('La otra persona perdió la conexión. Esperando que vuelva…'); break;
      case 'peer_back': banner(''); break;
      case 'ended': onEnded(m); break;
      case 'banned': cleanupCall(); show('banned'); break;
      case 'deleted':
        try { navigator.serviceWorker.getRegistration().then((r) => r && r.pushManager.getSubscription().then((s) => s && s.unsubscribe())); } catch (_) {}
        try { Object.keys(localStorage).filter((k) => k.indexOf('esc_') === 0).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
        location.href = '/';
        break;
      case 'error': if (m.code === 'rate') toast('Esperá un momento antes de volver a llamar'); break;
    }
  }

  function showStats(n) {
    $('avail-count').textContent = n > 0
      ? (n === 1 ? 'Hay 1 persona disponible ahora' : 'Hay ' + n + ' personas disponibles ahora')
      : 'Ahora no hay nadie disponible, pero podés intentar igual';
  }

  /* ---------- sonido y vibración ---------- */
  let ringCtx = null, ringInt = null;
  function startRing() {
    try {
      ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        const o = ringCtx.createOscillator(), g = ringCtx.createGain();
        o.frequency.value = 520; g.gain.value = 0.08; o.connect(g); g.connect(ringCtx.destination);
        o.start(); o.stop(ringCtx.currentTime + 0.35);
      };
      beep(); ringInt = setInterval(beep, 1400);
    } catch (_) {}
    if (navigator.vibrate) navigator.vibrate([300, 200, 300, 1200, 300, 200, 300]);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Escúchame', { body: 'Alguien quiere hablar contigo', tag: 'call' }); } catch (_) {}
    }
  }
  function stopRing() { clearInterval(ringInt); ringInt = null; if (navigator.vibrate) navigator.vibrate(0); }

  /* ---------- micrófono y pantalla ---------- */
  async function getMic() {
    if (localStream && localStream.getTracks().some((t) => t.readyState === 'live')) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    return localStream;
  }
  function releaseMic() { if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; } }
  async function keepAwake() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (_) {} }
  function letSleep() { try { if (wakeLock) wakeLock.release(); } catch (_) {} wakeLock = null; }

  /* ---------- llamar ---------- */
  async function startCall() {
    if (!wsReady) return toast('Sin conexión todavía');
    try { await getMic(); } catch (_) { return toast('Necesito permiso de micrófono para hablar. Activalo en los permisos del navegador.'); }
    call = { id: null, role: 'caller', pending: [] };
    $('search-msg').textContent = 'Puede tardar unos segundos.';
    sendWS({ t: 'call' });
    show('searching');
  }

  function onIncoming(m) {
    if (call || pendingIncoming) { sendWS({ t: 'decline', callId: m.callId }); return; }
    pendingIncoming = m;
    $('in-alias').textContent = m.fromAlias || 'Alguien';
    show('incoming'); startRing();
  }

  async function acceptIncoming() {
    if (!pendingIncoming) return;
    const m = pendingIncoming; stopRing();
    try { await getMic(); } catch (_) {
      sendWS({ t: 'decline', callId: m.callId }); pendingIncoming = null; goHome();
      return toast('Necesito permiso de micrófono para atender');
    }
    call = { id: m.callId, role: 'callee', pending: [] };
    pendingIncoming = null;
    sendWS({ t: 'accept', callId: m.callId });
    $('peer-alias').textContent = m.fromAlias; $('peer-initial').textContent = (m.fromAlias || '?')[0].toUpperCase();
    $('call-state').textContent = 'Conectando…'; $('timer').textContent = '00:00'; $('shared-langs').textContent = ''; banner('');
    show('call');
  }
  function declineIncoming() {
    if (!pendingIncoming) return;
    stopRing(); sendWS({ t: 'decline', callId: pendingIncoming.callId }); pendingIncoming = null; goHome();
  }

  async function onMatched(m) {
    if (!call) return;
    call.id = m.callId; call.peerId = m.peerId; call.peerAlias = m.peerAlias;
    lastPeer = { id: m.peerId, alias: m.peerAlias };
    $('peer-alias').textContent = m.peerAlias; $('peer-initial').textContent = (m.peerAlias || '?')[0].toUpperCase();
    $('call-state').textContent = 'Conectando…'; $('timer').textContent = '00:00'; banner('');
    $('shared-langs').textContent = m.shared && m.shared.length ? 'Idioma en común: ' + m.shared.map(langName).join(', ') : '';
    show('call');
    const pc = new RTCPeerConnection({ iceServers });
    call.pc = pc;
    (await getMic()).getTracks().forEach((t) => pc.addTrack(t, localStream));
    pc.onicecandidate = (e) => { if (e.candidate && call) sendWS({ t: 'signal', callId: call.id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => { $('remote').srcObject = e.streams[0]; $('remote').play().catch(() => {}); };
    pc.onconnectionstatechange = () => {
      if (!call || call.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected') { clearTimeout(call.failTimer); call.failTimer = null; $('call-state').textContent = 'En llamada'; startTimer(); keepAwake(); }
      if (st === 'disconnected') $('call-state').textContent = 'Conexión inestable…';
      if (st === 'failed') {
        tryIceRestart();
        if (!call.failTimer) call.failTimer = setTimeout(() => { if (call && pc.connectionState !== 'connected') { toast('No se pudo mantener el audio'); hangup(); } }, 20000);
      }
    };
    if (m.role === 'caller') {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWS({ t: 'signal', callId: call.id, data: { sdp: pc.localDescription } });
    }
  }

  async function tryIceRestart() { // solo quien llamó reinicia la negociación de red
    if (!call || !call.pc || call.role !== 'caller' || !wsReady) return;
    try {
      const offer = await call.pc.createOffer({ iceRestart: true });
      await call.pc.setLocalDescription(offer);
      sendWS({ t: 'signal', callId: call.id, data: { sdp: call.pc.localDescription } });
    } catch (e) { console.error('iceRestart', e); }
  }

  async function onSignal(m) {
    if (!call || !call.pc || m.callId !== call.id) return;
    const pc = call.pc, d = m.data || {};
    try {
      if (d.sdp) {
        await pc.setRemoteDescription(d.sdp);
        for (const c of call.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (d.sdp.type === 'offer') {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          sendWS({ t: 'signal', callId: call.id, data: { sdp: pc.localDescription } });
        }
      } else if (d.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => {});
        else call.pending.push(d.candidate);
      }
    } catch (e) { console.error('signal', e); }
  }
  // la señal puede llegar antes de que exista el RTCPeerConnection (quien atiende): se espera un momento
  async function onSignalSafe(m) {
    for (let i = 0; i < 60 && call && !call.pc; i++) await new Promise((r) => setTimeout(r, 50));
    return onSignal(m);
  }

  function startTimer() {
    if (call.startedAt) return;
    call.startedAt = Date.now();
    call.timerInt = setInterval(() => {
      const s = Math.floor((Date.now() - call.startedAt) / 1000);
      $('timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 500);
  }

  function cleanupCall() {
    stopRing(); letSleep();
    if (call) {
      clearInterval(call.timerInt); clearTimeout(call.dropTimer); clearTimeout(call.failTimer);
      if (call.peerId) lastPeer = { id: call.peerId, alias: call.peerAlias };
      if (call.pc) { try { call.pc.close(); } catch (_) {} }
    }
    $('remote').srcObject = null;
    releaseMic();
    $('btn-mute').classList.remove('on'); $('btn-mute').textContent = '🎤';
    banner('');
    call = null; pendingIncoming = null;
  }

  function hangup() {
    if (call && call.id) sendWS({ t: 'hangup', callId: call.id });
    const had = call && call.peerId;
    cleanupCall();
    endScreen('Llamada terminada', 'Gracias por animarte a hablar y a escuchar.', had);
  }
  function cancelSearch() {
    if (call && call.id) { sendWS({ t: 'hangup', callId: call.id }); cleanupCall(); }
    else if (call) { call.cancelled = true; releaseMic(); }
    goHome();
  }
  function endLocally(title, text) { const had = call && call.peerId; cleanupCall(); endScreen(title, text, had); }

  function onEnded(m) {
    if (m.self) return;
    if (!call && !pendingIncoming) return;
    if (m.reason === 'no_one') return; // lo maneja 'no_one'
    if (call && call.id && m.callId && m.callId !== call.id) return;
    const incoming = pendingIncoming && pendingIncoming.callId === m.callId;
    const had = call && call.peerId;
    cleanupCall();
    if (incoming) return goHome();
    if (m.reason === 'banned') return;
    if (m.reason === 'expired' || m.reason === 'disconnected') return endScreen('La llamada se cortó', 'Se perdió la conexión con la otra persona.', had);
    endScreen('La otra persona cortó', 'Gracias por animarte a hablar y a escuchar.', had);
  }

  function endScreen(title, text, canReport) {
    $('end-title').textContent = title; $('end-text').textContent = text;
    $('btn-end-flag').classList.toggle('hidden', !(canReport && lastPeer));
    show('end');
  }
  function goHome() { refreshHome(); show('home'); }

  /* ---------- bloquear / reportar ---------- */
  function flagAndHang() {
    const reason = $('flag-reason').value;
    const target = call && call.peerId ? { id: call.peerId } : lastPeer;
    if (target) {
      if (!blocked.includes(target.id)) { blocked.push(target.id); LS.set('blocked', blocked); }
      if (reason) sendWS({ t: 'report', targetId: target.id, reason });
      pushProfile();
    }
    $('modal-flag').classList.add('hidden'); $('flag-reason').value = '';
    if (call) {
      hangup();
      $('end-title').textContent = 'Persona bloqueada';
      $('end-text').textContent = 'No volverán a emparejarte con ella. Gracias por cuidar este espacio.';
    } else {
      $('btn-end-flag').classList.add('hidden');
      $('end-title').textContent = 'Persona bloqueada';
      $('end-text').textContent = 'No volverán a emparejarte con ella. Gracias por cuidar este espacio.';
    }
  }

  /* ---------- notificaciones push ---------- */
  const b64ToU8 = (s) => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
  async function subscribePush() {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(pushCfg.publicKey) });
    sendWS({ t: 'push_sub', sub: sub.toJSON() });
  }
  async function enablePush() {
    if (!pushCfg) throw new Error('El servidor no tiene notificaciones activadas');
    if (!('PushManager' in window) || !('Notification' in window)) throw new Error('Este navegador no permite notificaciones');
    if (isIOS && !isStandalone) throw new Error('En iPhone primero instalá la app (Compartir → Añadir a pantalla de inicio)');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permiso de notificaciones denegado');
    await subscribePush();
    LS.set('push', true);
  }
  async function disablePush() {
    try { const reg = await navigator.serviceWorker.ready; const s = await reg.pushManager.getSubscription(); if (s) await s.unsubscribe(); } catch (_) {}
    sendWS({ t: 'push_unsub' });
    LS.set('push', false);
  }
  function resyncPush() { // la suscripción puede cambiar: la renovamos al conectar
    if (pushCfg && LS.get('push', false) && 'Notification' in window && Notification.permission === 'granted') subscribePush().catch(() => {});
  }
  function updateSettingsPush() {
    const t = $('push-toggle'); if (!t) return;
    t.checked = !!LS.get('push', false);
    t.disabled = !pushCfg || !('PushManager' in window);
    $('push-note').textContent = !pushCfg
      ? 'Este servidor todavía no tiene las notificaciones activadas.'
      : (isIOS && !isStandalone ? 'En iPhone primero instalá la app en tu pantalla de inicio.' : 'Te llega un aviso aunque tengas la app cerrada, solo dentro de tu horario.');
  }

  /* ---------- perfil / ajustes ---------- */
  function renderLangs(sel) {
    $('langs').innerHTML = '';
    LANG_LIST.forEach(([code, name]) => {
      const l = document.createElement('label'); l.className = 'chip';
      const i = document.createElement('input'); i.type = 'checkbox'; i.value = code; i.checked = sel.includes(code);
      l.append(i, document.createTextNode(name)); $('langs').appendChild(l);
    });
  }
  function selectedLangs() { return Array.from($('langs').querySelectorAll('input:checked')).map((i) => i.value); }
  function defaultLangs() { const c = (navigator.language || 'es').slice(0, 2); return [LANG_LIST.some((l) => l[0] === c) ? c : 'es']; }

  function openSetup(asSettings) {
    settingsMode = !!asSettings;
    $('tz-label').textContent = tz;
    const p = profile || { alias: '', start: toMin('20:00'), end: toMin('23:00'), enabled: true, langs: defaultLangs() };
    $('alias').value = p.alias;
    $('t-start').value = toHHMM(p.start); $('t-end').value = toHHMM(p.end);
    $('allday').checked = p.start === p.end;
    renderLangs(p.langs && p.langs.length ? p.langs : defaultLangs());
    syncTimeInputs();
    $('setup-title').textContent = settingsMode ? 'Ajustes' : 'Tu perfil';
    $('btn-back').classList.toggle('hidden', !settingsMode);
    $('settings-extra').classList.toggle('hidden', !settingsMode);
    $('blocked-info').textContent = blocked.length ? blocked.length + (blocked.length === 1 ? ' persona bloqueada' : ' personas bloqueadas') : 'Ninguna';
    $('btn-unblock').disabled = !blocked.length;
    $('btn-install-2').classList.toggle('hidden', !deferredInstall || isStandalone);
    $('ios-hint').classList.toggle('hidden', !(isIOS && !isStandalone));
    updateSettingsPush();
    show('setup');
  }
  function syncTimeInputs() { const all = $('allday').checked; $('t-start').disabled = all; $('t-end').disabled = all; }

  /* ---------- eventos ---------- */
  function checkWelcome() { $('btn-welcome').disabled = !($('accept').checked && $('age').checked); }
  $('accept').onchange = checkWelcome; $('age').onchange = checkWelcome;
  $('btn-welcome').onclick = () => { LS.set('accepted2', true); openSetup(false); };
  $('allday').onchange = syncTimeInputs;

  $('btn-save').onclick = () => {
    const alias = $('alias').value.trim();
    if (alias.length < 2) return toast('Poné un alias de al menos 2 letras');
    const langs = selectedLangs();
    if (!langs.length) return toast('Elegí al menos un idioma');
    let start = toMin($('t-start').value || '20:00'), end = toMin($('t-end').value || '23:00');
    if ($('allday').checked) { start = 0; end = 0; }
    const first = !profile;
    profile = { alias, start, end, enabled: profile ? profile.enabled : true, langs };
    LS.set('profile', profile);
    if (first) connect(); else pushProfile();
    goHome();
  };
  $('btn-back').onclick = goHome;
  $('btn-settings').onclick = () => openSetup(true);
  $('receive').onchange = (e) => { profile.enabled = e.target.checked; LS.set('profile', profile); pushProfile(); refreshHome(); };
  $('btn-call').onclick = startCall;
  $('btn-cancel').onclick = cancelSearch;
  $('btn-accept').onclick = acceptIncoming;
  $('btn-decline').onclick = declineIncoming;
  $('btn-hang').onclick = hangup;
  $('btn-home').onclick = goHome;
  $('btn-mute').onclick = () => {
    const t = localStream && localStream.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    $('btn-mute').textContent = t.enabled ? '🎤' : '🔇';
    $('btn-mute').classList.toggle('on', !t.enabled);
    $('btn-mute').setAttribute('aria-label', t.enabled ? 'Silenciar micrófono' : 'Activar micrófono');
  };
  $('btn-flag').onclick = () => $('modal-flag').classList.remove('hidden');
  $('btn-end-flag').onclick = () => $('modal-flag').classList.remove('hidden');
  $('flag-cancel').onclick = () => $('modal-flag').classList.add('hidden');
  $('flag-ok').onclick = flagAndHang;
  $('btn-help').onclick = () => $('modal-help').classList.remove('hidden');
  $('help-close').onclick = () => $('modal-help').classList.add('hidden');

  $('push-toggle').onchange = async (e) => {
    const on = e.target.checked;
    try { if (on) await enablePush(); else await disablePush(); toast(on ? 'Notificaciones activadas' : 'Notificaciones desactivadas'); }
    catch (err) { e.target.checked = !on; toast(err.message); }
  };
  $('push-banner').onclick = async () => {
    try { await enablePush(); toast('Notificaciones activadas'); refreshHome(); }
    catch (err) { LS.set('pushBannerOff', true); refreshHome(); toast(err.message); }
  };
  $('btn-unblock').onclick = () => { blocked = []; LS.set('blocked', blocked); pushProfile(); $('blocked-info').textContent = 'Ninguna'; $('btn-unblock').disabled = true; toast('Listo, desbloqueaste a todas'); };
  $('btn-delete').onclick = () => {
    if (!confirm('Esto borra tu perfil, tus bloqueos y tus notificaciones de este dispositivo y del servidor. ¿Seguro?')) return;
    if (wsReady) sendWS({ t: 'delete_me' }); else toast('Necesitás conexión para borrar tus datos');
  };
  const doInstall = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => {}); deferredInstall = null; refreshHome(); $('btn-install-2').classList.add('hidden');
  };
  $('btn-install').onclick = doInstall; $('btn-install-2').onclick = doInstall;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (profile && homeVisible()) refreshHome(); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; });

  document.addEventListener('visibilitychange', () => {
    sendWS({ t: 'visibility', hidden: document.hidden });
    if (!document.hidden && call && call.startedAt) keepAwake();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('modal-flag').classList.add('hidden'); $('modal-help').classList.add('hidden'); }
  });
  setInterval(() => { if (profile && homeVisible()) refreshHome(); }, 30000);
  window.addEventListener('online', () => { if (ws && ws.readyState > 1) { reconnectDelay = 1000; connect(); } });

  /* ---------- arranque ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (/[?&]call=1/.test(location.search)) history.replaceState(null, '', '/'); } catch (_) {}
  if (!LS.get('accepted2', false) || !profile) show('welcome');
  else { connect(); goHome(); }
})();
