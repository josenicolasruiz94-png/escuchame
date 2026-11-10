'use strict';
// Pruebas del servidor con clientes WebSocket simulados.
const os = require('os'), path = require('path'), fs = require('fs');
const DATA = path.join(os.tmpdir(), 'esc-test-' + process.pid + '.json');
Object.assign(process.env, {
  RING_MS: '1500', PUSH_WAIT_MS: '2500', GRACE_MS: '1500', PUSH_COOLDOWN_MS: '0',
  DATA_FILE: DATA, ADMIN_KEY: 'clave-test', BAN_THRESHOLD: '3',
});
delete process.env.DATABASE_URL;
const assert = require('assert');
const WebSocket = require('ws');
const { server, init, store, inWindow, push, close } = require('../server');
const { Store } = require('../lib/store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let N = 0;
const uuid = (n) => ('0000000000000000000000000000000' + n.toString(16)).slice(-32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
const TZ = 'America/Argentina/Buenos_Aires';
const ALL = { start: 0, end: 0 };
let port, open = [];

function mk(alias, avail = ALL, opts = {}) {
  const n = opts.n || ++N;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d)));
    ws.on('error', reject);
    ws.on('open', () => {
      const c = {
        ws, inbox, id: uuid(n), n,
        send: (o) => ws.send(JSON.stringify(o)),
        async wait(type, ms = 3000) {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            const i = inbox.findIndex((m) => m.t === type);
            if (i >= 0) return inbox.splice(i, 1)[0];
            await sleep(15);
          }
          throw new Error('timeout esperando "' + type + '" (' + alias + ')');
        },
        has: (type) => inbox.some((m) => m.t === type),
      };
      open.push(c);
      c.send({ t: 'hello', clientId: c.id, alias, avail: { tz: TZ, enabled: true, ...avail },
        langs: opts.langs || ['es'], blocked: opts.blocked || [], hidden: !!opts.hidden, resume: opts.resume });
      c.wait('config').then(() => resolve(c), reject);
    });
  });
}
async function closeAll() { for (const c of open) { try { c.ws.terminate(); } catch (_) {} } open = []; await sleep(250); }
function resetPush() { for (const p of store.pushProfiles()) store.upsert(p.id, { sub: null }); push._setSender(null); }
const sub = (k) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + k, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });

async function scenario(name, fn) {
  resetPush();
  try { await fn(); console.log('ok  ' + name); }
  finally { await closeAll(); }
}
async function connectCall(caller, callee) { // llama y atiende; devuelve callId
  caller.send({ t: 'call' });
  const inc = await callee.wait('incoming');
  callee.send({ t: 'accept', callId: inc.callId });
  await caller.wait('matched'); await callee.wait('matched');
  return inc.callId;
}

(async () => {
  await init();
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;

  // ---- horario ----
  const noon = Date.UTC(2026, 10, 10, 15, 0); // 12:00 en Buenos Aires
  assert.strictEqual(inWindow({ start: 660, end: 780, tz: TZ }, noon), true);
  assert.strictEqual(inWindow({ start: 780, end: 900, tz: TZ }, noon), false);
  assert.strictEqual(inWindow({ start: 1320, end: 360, tz: TZ }, noon), false);
  assert.strictEqual(inWindow({ start: 600, end: 120, tz: TZ }, noon), true);
  assert.strictEqual(inWindow({ start: 0, end: 0, tz: TZ }, noon), true);
  assert.strictEqual(inWindow({ start: 660, end: 780, tz: 'Asia/Tokyo' }, noon), false);
  console.log('ok  horario (cruza medianoche y zonas horarias)');

  await scenario('llamada completa con señalización y colgar', async () => {
    const A = await mk('Ana'), B = await mk('Beto');
    const callId = await connectCall(A, B);
    A.send({ t: 'signal', callId, data: { sdp: { type: 'offer', sdp: 'x' } } });
    assert.strictEqual((await B.wait('signal')).data.sdp.type, 'offer');
    B.send({ t: 'signal', callId, data: { sdp: { type: 'answer', sdp: 'y' } } });
    assert.strictEqual((await A.wait('signal')).data.sdp.type, 'answer');
    B.send({ t: 'hangup', callId });
    assert.strictEqual((await A.wait('ended')).reason, 'hangup');
  });

  await scenario('rechazo sin otros disponibles -> no hay nadie', async () => {
    const A = await mk('Ana'), B = await mk('Beto');
    A.send({ t: 'call' });
    const inc = await B.wait('incoming');
    B.send({ t: 'decline', callId: inc.callId });
    await A.wait('no_one');
  });

  await scenario('respeta horario y "recibir llamadas" apagado', async () => {
    const m = (new Date().getUTCHours() * 60 + 600) % 1440;
    const A = await mk('Ana'), B = await mk('Beto');
    const C = await mk('Fuera', { start: (m + 120) % 1440, end: (m + 180) % 1440 });
    const D = await mk('Apagado', { ...ALL, enabled: false });
    A.send({ t: 'call' });
    const inc = await B.wait('incoming');
    assert.ok(!C.has('incoming') && !D.has('incoming'));
    B.send({ t: 'decline', callId: inc.callId });
    await A.wait('no_one');
  });

  await scenario('bloqueados no se emparejan (de cualquiera de los dos lados)', async () => {
    const A = await mk('Ana'), E = await mk('Bloqueador', ALL, { blocked: [uuid(1000)] });
    const A2 = await mk('Ana2', ALL, { n: 1000 });
    A2.send({ t: 'call' });
    await A2.wait('no_one');          // E lo bloqueó
    A.send({ t: 'call' });
    const inc = await E.wait('incoming'); // pero a Ana sí
    E.send({ t: 'decline', callId: inc.callId });
  });

  await scenario('si no atiende, pasa a otra persona (timeout)', async () => {
    const A = await mk('Ana'), F = await mk('F'), G = await mk('G');
    A.send({ t: 'call' });
    await sleep(200);
    const ringers = [F, G].filter((c) => c.has('incoming'));
    assert.strictEqual(ringers.length, 1);
    const other = ringers[0] === F ? G : F;
    const second = await other.wait('incoming', 3500);
    other.send({ t: 'accept', callId: second.callId });
    await A.wait('matched');
  });

  await scenario('idiomas: solo se emparejan si tienen uno en común', async () => {
    const A = await mk('Ana', ALL, { langs: ['es'] }), X = await mk('Xavier', ALL, { langs: ['en'] });
    A.send({ t: 'call' });
    await A.wait('no_one');
    assert.ok(!X.has('incoming'));
    const Y = await mk('Yago', ALL, { langs: ['en', 'es'] });
    await sleep(2600);
    A.send({ t: 'call' });
    const inc = await Y.wait('incoming');
    Y.send({ t: 'accept', callId: inc.callId });
    const m = await A.wait('matched');
    assert.deepStrictEqual(m.shared, ['es']);
  });

  await scenario('reparto equitativo: suena primero a quien hace más que no atiende', async () => {
    const R = await mk('R'), P = await mk('P');
    const Q = await mk('Q', { ...ALL, enabled: false });          // Q empieza sin recibir llamadas
    const callId = await connectCall(R, P);                        // P atiende ahora
    R.send({ t: 'hangup', callId }); await P.wait('ended');
    Q.send({ t: 'profile', alias: 'Q', avail: { ...ALL, tz: TZ, enabled: true } }); await sleep(2700);
    R.send({ t: 'call' });                                         // Q nunca atendió: le toca antes que a P
    await Q.wait('incoming');
    assert.ok(!P.has('incoming'));
  });

  await scenario('reconexión: la llamada sobrevive a un corte y se reanuda', async () => {
    const A = await mk('Ana'), B = await mk('Beto');
    const callId = await connectCall(A, B);
    B.ws.terminate();
    await A.wait('peer_offline');
    const B2 = await mk('Beto', ALL, { n: B.n, resume: callId });
    await B2.wait('resumed'); await A.wait('peer_back');
    A.send({ t: 'signal', callId, data: { candidate: { c: 1 } } });
    assert.ok((await B2.wait('signal')).data.candidate);
    // si no vuelve a tiempo, se corta
    B2.ws.terminate();
    const e = await A.wait('ended', 4000);
    assert.strictEqual(e.reason, 'disconnected');
  });

  await scenario('push: llama a alguien con la app cerrada y se le entrega al abrir', async () => {
    const sent = [];
    push._setSender(async (s, payload) => { sent.push({ s, payload }); });
    const P = await mk('Pía'); P.send({ t: 'push_sub', sub: sub('pia') }); await sleep(100);
    const pid = P.n; P.ws.terminate(); await sleep(250);
    const A = await mk('Ana');
    A.send({ t: 'call' });
    await sleep(300);
    assert.strictEqual(sent.length, 1, 'debió enviarse 1 notificación');
    assert.strictEqual(sent[0].s.endpoint, sub('pia').endpoint);
    const s = await A.wait('searching');
    assert.strictEqual(s.phase, 'push');
    const P2 = await mk('Pía', ALL, { n: pid }); // abre la app desde la notificación
    const inc = await P2.wait('incoming');
    assert.strictEqual(inc.fromAlias, 'Ana');
    P2.send({ t: 'accept', callId: inc.callId });
    await A.wait('matched');
  });

  await scenario('push: si nadie abre la app, termina como "no hay nadie"', async () => {
    push._setSender(async () => {});
    const P = await mk('Pía'); P.send({ t: 'push_sub', sub: sub('pia2') }); await sleep(100); P.ws.terminate(); await sleep(250);
    const A = await mk('Ana');
    A.send({ t: 'call' });
    await A.wait('no_one', 6000);
  });

  await scenario('push: suscripción vencida (410) se elimina y sigue buscando', async () => {
    push._setSender(async () => { throw { statusCode: 410 }; });
    const P = await mk('Pía'); P.send({ t: 'push_sub', sub: sub('pia3') }); await sleep(100); const pid = P.id; P.ws.terminate(); await sleep(250);
    const A = await mk('Ana');
    A.send({ t: 'call' });
    await A.wait('no_one', 3000);
    assert.strictEqual(store.getProfile(pid).sub, null);
  });

  await scenario('push: app abierta pero en segundo plano -> suena y además notifica', async () => {
    const sent = [];
    push._setSender(async (s, p) => { sent.push(p); });
    const H = await mk('Hidden', ALL, { hidden: true }); H.send({ t: 'push_sub', sub: sub('hid') }); await sleep(100);
    const A = await mk('Ana');
    A.send({ t: 'call' });
    await H.wait('incoming');
    await sleep(100);
    assert.strictEqual(sent.length, 1);
  });

  await scenario('push: rechaza endpoints que no son de servicios de push', async () => {
    push._setSender(async () => {});
    const P = await mk('Mal'); P.send({ t: 'push_sub', sub: { endpoint: 'https://127.0.0.1/x', keys: { p256dh: 'a', auth: 'b' } } });
    await sleep(100);
    assert.ok(!store.getProfile(P.id).sub);
  });

  await scenario('reportes: solo a quien hablaste; 3 personas distintas suspenden', async () => {
    const T = await mk('Tóxico');
    const off = { ...ALL, enabled: false };
    const R = [await mk('R1', off), await mk('R2', off), await mk('R3', off)];
    const Z = await mk('Ajeno', off);
    Z.send({ t: 'report', targetId: T.id, reason: 'falta_de_respeto' }); // nunca habló con T: se ignora
    await sleep(100);
    assert.strictEqual(store.distinctReporters(T.id, 1e9), 0);
    for (const r of R) {
      const callId = await connectCall(r, T);
      r.send({ t: 'hangup', callId }); await T.wait('ended');
      r.send({ t: 'report', targetId: T.id, reason: 'acoso' }); await sleep(80);
    }
    await T.wait('banned');
    assert.ok(store.isBanned(T.id));
    const Y = await mk('Y', { ...ALL, enabled: false });
    Y.send({ t: 'call' });
    await Y.wait('no_one');            // T suspendido ya no recibe llamadas
    const T2 = await mk('Tóxico', ALL, { n: T.n });
    await T2.wait('banned');           // y al reconectar sigue suspendido
    T2.send({ t: 'call' }); await sleep(150);
    assert.ok(!T2.has('searching'));
    store.setBan(T.id, false);
  });

  await scenario('panel de moderación: clave, estado y reactivar', async () => {
    const base = 'http://127.0.0.1:' + port;
    assert.strictEqual((await fetch(base + '/admin/api/state')).status, 401);
    const h = { Authorization: 'Bearer clave-test', 'Content-Type': 'application/json' };
    const st = await (await fetch(base + '/admin/api/state', { headers: h })).json();
    assert.ok('online' in st && Array.isArray(st.reports));
    const id = uuid(99999);
    await fetch(base + '/admin/api/ban', { method: 'POST', headers: h, body: JSON.stringify({ id, banned: true }) });
    assert.ok(store.isBanned(id));
    await fetch(base + '/admin/api/ban', { method: 'POST', headers: h, body: JSON.stringify({ id, banned: false }) });
    assert.ok(!store.isBanned(id));
    const k = await (await fetch(base + '/admin/api/vapid-keys', { headers: h })).json();
    assert.ok(k.publicKey.length > 60 && k.privateKey.length > 30);
    assert.strictEqual((await fetch(base + '/healthz')).status, 200);
  });

  await scenario('borrar mis datos', async () => {
    const A = await mk('Ana');
    assert.ok(store.getProfile(A.id));
    A.send({ t: 'delete_me' });
    await A.wait('deleted');
    assert.strictEqual(store.getProfile(A.id), null);
  });

  await scenario('seguridad: se rechaza otro origen y llega con cabeceras CSP', async () => {
    await new Promise((resolve, reject) => {
      const w = new WebSocket('ws://127.0.0.1:' + port + '/ws', { origin: 'http://sitio-malo.example' });
      w.on('open', () => reject(new Error('no debió conectar')));
      w.on('error', () => resolve());
    });
    const r = await fetch('http://127.0.0.1:' + port + '/');
    assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
  });

  // ---- persistencia en archivo ----
  await close();
  const s2 = new Store({ file: DATA });
  await s2.init();
  assert.ok(Object.keys(s2.state.profiles).length > 0, 'los perfiles deben sobrevivir al reinicio');
  console.log('ok  persistencia en archivo');

  console.log('\nTODAS LAS PRUEBAS PASARON');
  process.exit(0);
})().catch((e) => { console.error('FALLO:', e && e.stack || e); process.exit(1); });
