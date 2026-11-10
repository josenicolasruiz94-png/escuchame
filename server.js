'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Store } = require('./lib/store');
const ice = require('./lib/ice');
const push = require('./lib/push');

const env = process.env;
const cfg = {
  PORT: env.PORT || 3000,
  RING_MS: Number(env.RING_MS || 25000),              // cuánto suena para una persona conectada
  PUSH_WAIT_MS: Number(env.PUSH_WAIT_MS || 40000),    // cuánto se espera a que alguien abra la app tras una notificación
  PUSH_COOLDOWN_MS: Number(env.PUSH_COOLDOWN_MS || 90000), // no molestar a la misma persona seguido
  GRACE_MS: Number(env.GRACE_MS || 20000),            // tiempo para reconectar sin cortar una llamada
  SEARCH_MAX_MS: Number(env.SEARCH_MAX_MS || 100000), // máximo buscando a alguien
  MAX_PUSH_TRIES: Number(env.MAX_PUSH_TRIES || 2),
  BAN_THRESHOLD: Number(env.BAN_THRESHOLD || 3),      // reportes de personas distintas (7 días) para suspender
  MAX_CONN_PER_IP: Number(env.MAX_CONN_PER_IP || 200),
};
const LANGS = ['es', 'en', 'pt', 'fr', 'it', 'de'];
const ADMIN_KEY = env.ADMIN_KEY || '';

const store = new Store();
const clients = new Set();
const calls = new Map();       // callId -> { id, caller, callee, state, tried:Set(ids), timer, graceTimers, pendingId, pushTries, startedAt }
const pendingPush = new Map(); // clientId -> callId (esperando que abra la app tras la notificación)
const lastCall = new Map();    // clientId -> última vez que atendió (para repartir las llamadas con equidad)

/* ---------- HTTP ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) { if (/sw\.js$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.get('/healthz', (_req, res) => res.send('ok'));

function adminAuth(req, res, next) {
  if (!ADMIN_KEY) return res.status(404).end();
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(ADMIN_KEY);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: 'clave incorrecta' });
  next();
}
app.get('/admin', (_req, res) => (ADMIN_KEY ? res.sendFile(path.join(__dirname, 'admin', 'admin.html')) : res.status(404).end()));
app.get('/admin/admin.js', (_req, res) => (ADMIN_KEY ? res.sendFile(path.join(__dirname, 'admin', 'admin.js')) : res.status(404).end()));
app.get('/admin/api/state', adminAuth, (_req, res) => {
  const now = Date.now();
  res.json({
    storage: store.kind, turn: ice.provider(), push: push.enabled,
    online: [...clients].filter((c) => c.ready).length,
    availableNow: availableCount(now),
    ...store.counts(),
    banned: store.bannedList(),
    reports: store.recentReports(100),
  });
});
app.get('/admin/api/vapid-keys', adminAuth, (_req, res) => { // claves nuevas para pegar en Render (no se guardan acá)
  res.json(require('web-push').generateVAPIDKeys());
});
app.post('/admin/api/ban', adminAuth, express.json({ limit: '2kb' }), (req, res) => {
  const id = String((req.body && req.body.id) || '');
  if (!/^[a-f0-9-]{16,64}$/i.test(id)) return res.status(400).json({ error: 'id inválido' });
  const banned = !!req.body.banned;
  store.setBan(id, banned);
  if (banned) kick(id);
  res.json({ ok: true });
});

const server = http.createServer(app);
const ipCount = new Map();
// detrás del proxy de Render la IP real viene en X-Forwarded-For (la última entrada la agrega el proxy)
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xf.length ? xf[xf.length - 1] : req.socket.remoteAddress;
}
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient(info, cb) {
    // Solo la propia página puede conectarse (evita que otros sitios usen tu servidor)
    const o = info.origin;
    if (o) { try { if (new URL(o).host !== info.req.headers.host) return cb(false, 403, 'origen no permitido'); } catch (_) { return cb(false, 403); } }
    const ip = clientIp(info.req);
    if ((ipCount.get(ip) || 0) >= cfg.MAX_CONN_PER_IP) return cb(false, 429, 'demasiadas conexiones');
    cb(true);
  },
});

/* ---------- utilidades ---------- */
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function validTz(tz) { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch (_) { return false; } }

function minutesNow(tz, nowMs) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(nowMs));
  return (Number(parts.find((p) => p.type === 'hour').value) % 24) * 60 + Number(parts.find((p) => p.type === 'minute').value);
}

// start/end: minutos desde medianoche en la zona horaria de la persona. start === end = todo el día.
function inWindow(avail, nowMs) {
  try {
    if (avail.start === avail.end) return true;
    const m = minutesNow(avail.tz, nowMs);
    return avail.start < avail.end ? (m >= avail.start && m < avail.end) : (m >= avail.start || m < avail.end);
  } catch (_) { return false; }
}

function cleanAvail(a) {
  if (!a || typeof a !== 'object') return null;
  const start = Math.floor(Number(a.start)), end = Math.floor(Number(a.end)), tz = String(a.tz || '');
  if (!(start >= 0 && start < 1440 && end >= 0 && end < 1440) || !validTz(tz)) return null;
  return { start, end, tz, enabled: !!a.enabled };
}
const cleanAlias = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Anónimo';
const cleanLangs = (l) => (Array.isArray(l) ? [...new Set(l.map(String).filter((x) => LANGS.includes(x)))].slice(0, 6) : []);
const cleanBlocked = (b) => (Array.isArray(b) ? b.slice(0, 500).map(String).filter((x) => /^[a-f0-9-]{16,64}$/i.test(x)) : []);

function sharedLangs(a, b) {
  const A = a.langs || [], B = b.langs || [];
  if (!A.length || !B.length) return null; // sin datos: no se filtra
  return A.filter((x) => B.includes(x));
}
// ¿pueden hablar entre sí? (idioma en común, sin bloqueos, sin suspensión)
function canPair(a, b) {
  if (a.id === b.id) return false;
  if (a.blocked.has(b.id) || b.blocked.has(a.id)) return false;
  if (store.isBanned(a.id) || store.isBanned(b.id)) return false;
  const sh = sharedLangs(a, b);
  return sh === null || sh.length > 0;
}

function isAvailableNow(c, now) {
  return c.ready && !c.detached && c.avail && c.avail.enabled && !c.callId && !store.isBanned(c.id) && inWindow(c.avail, now);
}
function offlineView(p) { return { id: p.id, blocked: new Set(p.blocked || []), avail: p.avail, langs: p.langs || [] }; }
function onlineIds() { const s = new Set(); for (const c of clients) if (c.ready && c.id) s.add(c.id); return s; }

function availableCount(now) {
  const online = onlineIds();
  let n = 0;
  for (const c of clients) if (isAvailableNow(c, now)) n++;
  if (push.enabled) {
    for (const p of store.pushProfiles()) {
      if (online.has(p.id) || !p.avail || !p.avail.enabled || store.isBanned(p.id)) continue;
      if (inWindow(p.avail, now)) n++;
    }
  }
  return n;
}

let statsTimer = null;
function scheduleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    const now = Date.now();
    const total = availableCount(now);
    for (const c of clients) {
      if (!c.ready) continue;
      send(c, { t: 'stats', available: Math.max(0, total - (isAvailableNow(c, now) ? 1 : 0)) });
    }
  }, 300);
  if (statsTimer.unref) statsTimer.unref();
}

/* ---------- llamadas ---------- */
function endCall(call, reason, who) {
  if (!calls.has(call.id)) return;
  calls.delete(call.id);
  clearTimeout(call.timer);
  for (const t of Object.values(call.graceTimers || {})) clearTimeout(t);
  if (call.pendingId) { pendingPush.delete(call.pendingId); call.pendingId = null; }
  for (const p of [call.caller, call.callee]) {
    if (!p) continue;
    if (p.callId === call.id) p.callId = null;
    if (p !== who) send(p, { t: 'ended', callId: call.id, reason });
  }
  if (who) send(who, { t: 'ended', callId: call.id, reason, self: true });
  scheduleStats();
}

function release(call) {
  clearTimeout(call.timer);
  if (call.callee) { if (call.callee.callId === call.id) call.callee.callId = null; call.callee = null; }
  if (call.pendingId) { pendingPush.delete(call.pendingId); call.pendingId = null; }
}

function giveUp(call) {
  const caller = call.caller;
  endCall(call, 'no_one', null);
  send(caller, { t: 'no_one', callId: call.id });
}

function pushPayload(callId) {
  return { title: 'Escúchame', body: 'Alguien necesita ser escuchado/a. Tocá para atender.', callId, url: '/?call=1' };
}
async function pushTo(id) { // avisa por notificación a una persona (si tiene suscripción)
  const p = store.getProfile(id);
  if (!p || !p.sub || !push.enabled) return { skipped: true };
  store.upsert(id, { lastPushAt: Date.now() });
  const r = await push.notify(p.sub, pushPayload());
  if (r.gone) store.upsert(id, { sub: null });
  return r;
}

function ringNext(call) {
  release(call);
  const now = Date.now();
  if (now - call.startedAt > cfg.SEARCH_MAX_MS) return giveUp(call);
  const caller = call.caller;

  // 1) personas conectadas ahora (primero las que tienen la app a la vista, luego las más "descansadas")
  const online = [...clients].filter((c) => c !== caller && !call.tried.has(c.id) && isAvailableNow(c, now) && canPair(caller, c));
  if (online.length) {
    online.sort((a, b) => (a.hidden - b.hidden) || ((lastCall.get(a.id) || 0) - (lastCall.get(b.id) || 0)) || (Math.random() - 0.5));
    const cand = online[0];
    call.tried.add(cand.id);
    call.callee = cand; cand.callId = call.id;
    send(cand, { t: 'incoming', callId: call.id, fromAlias: caller.alias, ringMs: cfg.RING_MS });
    send(caller, { t: 'searching', callId: call.id, phase: 'ring' });
    if (cand.hidden) pushTo(cand.id); // app en segundo plano: además la avisamos por notificación
    call.timer = setTimeout(() => { send(cand, { t: 'missed', callId: call.id }); ringNext(call); }, cfg.RING_MS);
    return;
  }

  // 2) personas con la app cerrada pero con notificaciones activadas y dentro de su horario
  if (push.enabled && call.pushTries < cfg.MAX_PUSH_TRIES) {
    const on = onlineIds();
    const pool = store.pushProfiles().filter((p) =>
      !call.tried.has(p.id) && !pendingPush.has(p.id) && !on.has(p.id) &&
      now - (p.lastPushAt || 0) >= cfg.PUSH_COOLDOWN_MS &&
      p.avail && p.avail.enabled && inWindow(p.avail, now) && canPair(caller, offlineView(p)));
    if (pool.length) {
      pool.sort((a, b) => ((a.lastPushAt || 0) - (b.lastPushAt || 0)) || (Math.random() - 0.5));
      const p = pool[0];
      call.tried.add(p.id); call.pushTries++; call.pendingId = p.id;
      pendingPush.set(p.id, call.id);
      send(caller, { t: 'searching', callId: call.id, phase: 'push' });
      pushTo(p.id).then((r) => { if (r.fail || r.gone) { if (call.pendingId === p.id && calls.has(call.id)) ringNext(call); } });
      call.timer = setTimeout(() => ringNext(call), cfg.PUSH_WAIT_MS);
      return;
    }
  }
  giveUp(call);
}

const otherParty = (call, ws) => (call.caller === ws ? call.callee : call.caller);

function kick(id) { // suspensión: avisa y corta lo que esté en curso
  for (const c of clients) {
    if (c.id !== id) continue;
    send(c, { t: 'banned' });
    const call = c.callId && calls.get(c.callId);
    if (call) endCall(call, 'banned', c);
  }
  scheduleStats();
}

/* ---------- mensajes ---------- */
const lastCallAt = new WeakMap();

async function onHello(ws, msg) {
  const id = String(msg.clientId || '');
  if (!/^[a-f0-9-]{16,64}$/i.test(id)) return;
  const stored = store.getProfile(id) || {};
  ws.id = id;
  ws.alias = cleanAlias(msg.alias || stored.alias);
  ws.avail = cleanAvail(msg.avail) || stored.avail || null;
  ws.langs = Array.isArray(msg.langs) ? cleanLangs(msg.langs) : (stored.langs || []);
  ws.blocked = new Set(Array.isArray(msg.blocked) ? cleanBlocked(msg.blocked) : (stored.blocked || []));
  ws.hidden = !!msg.hidden;
  store.upsert(id, { alias: ws.alias, avail: ws.avail, langs: ws.langs, blocked: [...ws.blocked], lastSeen: Date.now() });
  const servers = await ice.getIceServers();
  if (ws.readyState !== 1) return;
  ws.ready = true;
  send(ws, { t: 'config', iceServers: servers, push: push.enabled ? { publicKey: push.publicKey } : null });
  if (store.isBanned(id)) send(ws, { t: 'banned' });

  // reanudar una llamada cortada por mala conexión (el audio sigue entre ambos celulares)
  if (msg.resume) {
    const call = calls.get(String(msg.resume));
    let done = false;
    if (call && call.state === 'active') {
      for (const role of ['caller', 'callee']) {
        const old = call[role];
        if (old && old.id === id) {
          if (old !== ws) { old.callId = null; old.detached = true; try { old.terminate(); } catch (_) {} }
          call[role] = ws; ws.callId = call.id; ws.lastPeer = old.lastPeer;
          clearTimeout(call.graceTimers[id]); delete call.graceTimers[id];
          send(ws, { t: 'resumed', callId: call.id });
          send(otherParty(call, ws), { t: 'peer_back', callId: call.id });
          done = true;
        }
      }
    }
    if (!done) send(ws, { t: 'ended', callId: String(msg.resume), reason: 'expired' });
  }

  // alguien abrió la app tras recibir la notificación: entregarle la llamada que lo estaba esperando
  const pendingCallId = pendingPush.get(id);
  if (pendingCallId && !ws.callId) {
    const call = calls.get(pendingCallId);
    if (call && call.state === 'ringing' && call.pendingId === id) {
      clearTimeout(call.timer);
      pendingPush.delete(id); call.pendingId = null;
      call.callee = ws; ws.callId = call.id;
      send(ws, { t: 'incoming', callId: call.id, fromAlias: call.caller.alias, ringMs: cfg.RING_MS });
      send(call.caller, { t: 'searching', callId: call.id, phase: 'ring' });
      call.timer = setTimeout(() => { send(ws, { t: 'missed', callId: call.id }); ringNext(call); }, cfg.RING_MS);
    }
  }
  scheduleStats();
}

async function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'hello') return onHello(ws, msg);
  if (!ws.ready) return;

  switch (msg.t) {
    case 'profile': {
      ws.alias = cleanAlias(msg.alias);
      const a = cleanAvail(msg.avail); if (a) ws.avail = a;
      if (Array.isArray(msg.langs)) ws.langs = cleanLangs(msg.langs);
      if (Array.isArray(msg.blocked)) ws.blocked = new Set(cleanBlocked(msg.blocked));
      store.upsert(ws.id, { alias: ws.alias, avail: ws.avail, langs: ws.langs, blocked: [...ws.blocked] });
      scheduleStats();
      break;
    }
    case 'visibility': ws.hidden = !!msg.hidden; break;
    case 'push_sub':
      if (push.enabled && push.validSub(msg.sub)) store.upsert(ws.id, { sub: { endpoint: msg.sub.endpoint, keys: { p256dh: msg.sub.keys.p256dh, auth: msg.sub.keys.auth } } });
      break;
    case 'push_unsub': store.upsert(ws.id, { sub: null }); break;
    case 'delete_me': {
      const call = ws.callId && calls.get(ws.callId);
      if (call) endCall(call, 'hangup', ws);
      store.deleteProfile(ws.id);
      ws.ready = false;
      send(ws, { t: 'deleted' });
      scheduleStats();
      break;
    }
    case 'call': {
      if (ws.callId || store.isBanned(ws.id)) return;
      const now = Date.now();
      if (now - (lastCallAt.get(ws) || 0) < 2500) return send(ws, { t: 'error', code: 'rate' });
      lastCallAt.set(ws, now);
      const call = { id: crypto.randomUUID(), caller: ws, callee: null, state: 'ringing', tried: new Set([ws.id]), timer: null, graceTimers: {}, pendingId: null, pushTries: 0, startedAt: now };
      calls.set(call.id, call);
      ws.callId = call.id;
      ringNext(call);
      break;
    }
    case 'accept': {
      const call = calls.get(msg.callId);
      if (!call || call.callee !== ws || call.state !== 'ringing') return;
      clearTimeout(call.timer);
      call.state = 'active';
      lastCall.set(ws.id, Date.now());
      ws.lastPeer = call.caller.id; call.caller.lastPeer = ws.id;
      const shared = sharedLangs(call.caller, ws) || [];
      send(call.caller, { t: 'matched', callId: call.id, role: 'caller', peerAlias: ws.alias, peerId: ws.id, shared });
      send(ws, { t: 'matched', callId: call.id, role: 'callee', peerAlias: call.caller.alias, peerId: call.caller.id, shared });
      scheduleStats();
      break;
    }
    case 'decline': {
      const call = calls.get(msg.callId);
      if (!call || call.callee !== ws || call.state !== 'ringing') return;
      ringNext(call);
      break;
    }
    case 'hangup': {
      const call = calls.get(msg.callId);
      if (!call || (call.caller !== ws && call.callee !== ws)) return;
      if (call.state === 'ringing' && call.callee === ws) return ringNext(call);
      if (call.state === 'ringing' && call.callee) send(call.callee, { t: 'missed', callId: call.id });
      endCall(call, 'hangup', ws);
      break;
    }
    case 'signal': {
      const call = calls.get(msg.callId);
      if (!call || call.state !== 'active' || (call.caller !== ws && call.callee !== ws)) return;
      send(otherParty(call, ws), { t: 'signal', callId: call.id, data: msg.data });
      break;
    }
    case 'report': {
      const target = String(msg.targetId || '');
      if (!target || target !== ws.lastPeer) return; // solo se puede reportar a quien acabás de hablar
      store.addReport({ at: Date.now(), reporter: ws.id, target, reason: String(msg.reason || '').slice(0, 60) });
      console.log('REPORTE', ws.id, '->', target, String(msg.reason || '').slice(0, 60));
      if (!store.isBanned(target) && store.distinctReporters(target, 7 * 24 * 3600 * 1000) >= cfg.BAN_THRESHOLD) {
        store.setBan(target, true);
        console.log('SUSPENDIDO automáticamente', target);
        kick(target);
      }
      break;
    }
    default:
  }
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  ws.isAlive = true; ws.ready = false; ws.callId = null; ws.blocked = new Set(); ws.hidden = false;
  ws.tokens = 100; ws.tokensAt = Date.now();
  clients.add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (d) => {
    // límite de mensajes: ráfaga 100, 20 por segundo sostenido
    const now = Date.now();
    ws.tokens = Math.min(100, ws.tokens + (now - ws.tokensAt) / 50); ws.tokensAt = now;
    if (--ws.tokens < 0) return ws.terminate();
    onMessage(ws, d.toString()).catch((e) => console.error('mensaje:', e.message));
  });
  ws.on('close', () => {
    clients.delete(ws);
    ipCount.set(ip, Math.max(0, (ipCount.get(ip) || 1) - 1));
    const call = ws.callId && calls.get(ws.callId);
    if (call && (call.caller === ws || call.callee === ws)) {
      if (call.state === 'active') {
        // se cortó la conexión: damos unos segundos para volver sin cortar la llamada
        ws.detached = true;
        const peer = otherParty(call, ws);
        send(peer, { t: 'peer_offline', callId: call.id });
        call.graceTimers[ws.id] = setTimeout(() => endCall(call, 'disconnected', null), cfg.GRACE_MS);
      } else if (call.state === 'ringing' && call.callee === ws) {
        ringNext(call);
      } else {
        endCall(call, 'disconnected', null);
      }
    }
    scheduleStats();
  });
  ws.on('error', () => {});
});

const hb = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25000);
const st = setInterval(scheduleStats, 15000); // las franjas horarias cambian con el reloj
hb.unref(); st.unref();

async function init() {
  push.init();
  await store.init();
  console.log(`Datos: ${store.kind} | TURN: ${ice.provider()} | Push: ${push.enabled ? 'activado' : 'desactivado'} | Admin: ${ADMIN_KEY ? 'activado' : 'desactivado'}`);
}

if (require.main === module) {
  init().then(() => server.listen(cfg.PORT, () => console.log('Escúchame escuchando en puerto ' + cfg.PORT)))
    .catch((e) => { console.error('No pudo iniciar:', e); process.exit(1); });
  const bye = async () => { await store.close(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}

module.exports = { server, wss, init, store, inWindow, calls, push, close: async () => { await store.close(); } };
