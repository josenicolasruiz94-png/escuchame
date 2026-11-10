'use strict';
// Prueba del proveedor de TURN con respuestas simuladas (no hace llamadas reales a Cloudflare/Metered).
const assert = require('assert');
const ice = require('../lib/ice');
const calls = [];
const realFetch = global.fetch;
let mode = 'ok';
global.fetch = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (mode === 'fail') return { ok: false, status: 500, json: async () => ({}) };
  if (url.includes('cloudflare.com')) return { ok: true, json: async () => ({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] }) };
  return { ok: true, json: async () => ([{ urls: 'stun:stun.relay.metered.ca:80' }, { urls: 'turn:global.relay.metered.ca:80', username: 'mu', credential: 'mc' }]) };
};
(async () => {
  for (const k of ['CF_TURN_KEY_ID', 'CF_TURN_API_TOKEN', 'METERED_APP', 'METERED_API_KEY', 'ICE_SERVERS']) delete process.env[k];
  ice._reset();
  assert.strictEqual(ice.provider(), 'solo-stun');
  assert.ok((await ice.getIceServers())[0].urls.startsWith('stun:'));

  Object.assign(process.env, { CF_TURN_KEY_ID: 'KEY123', CF_TURN_API_TOKEN: 'TOKEN' }); ice._reset();
  assert.strictEqual(ice.provider(), 'cloudflare');
  const cf = await ice.getIceServers();
  assert.ok(cf.some((s) => s.username === 'u'));
  assert.strictEqual(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/KEY123/credentials/generate-ice-servers');
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer TOKEN');
  assert.strictEqual(JSON.parse(calls[0].opts.body).ttl, 86400);
  await ice.getIceServers(); assert.strictEqual(calls.length, 1, 'se cachea');

  for (const k of ['CF_TURN_KEY_ID', 'CF_TURN_API_TOKEN']) delete process.env[k];
  Object.assign(process.env, { METERED_APP: 'miapp', METERED_API_KEY: 'K' }); ice._reset(); calls.length = 0;
  assert.strictEqual(ice.provider(), 'metered');
  assert.ok((await ice.getIceServers()).some((s) => s.username === 'mu'));
  assert.strictEqual(calls[0].url, 'https://miapp.metered.live/api/v1/turn/credentials?apiKey=K');

  process.env.METERED_APP = 'mala/app?x'; assert.strictEqual(ice.provider(), 'solo-stun', 'nombre de app inválido se ignora');
  delete process.env.METERED_APP; delete process.env.METERED_API_KEY;
  process.env.ICE_SERVERS = JSON.stringify([{ urls: 'turn:mio:3478', username: 'a', credential: 'b' }]); ice._reset();
  assert.strictEqual(ice.provider(), 'manual');
  assert.strictEqual((await ice.getIceServers())[0].username, 'a');

  delete process.env.ICE_SERVERS; Object.assign(process.env, { CF_TURN_KEY_ID: 'K', CF_TURN_API_TOKEN: 'T' }); ice._reset(); mode = 'fail';
  const fb = await ice.getIceServers();
  assert.ok(fb[0].urls.startsWith('stun:'), 'si falla el proveedor, cae a STUN y la app sigue funcionando');
  console.log('ok  TURN: Cloudflare, Metered, manual, caché y fallback a STUN');
  global.fetch = realFetch; process.exit(0);
})().catch((e) => { console.error('FALLO ICE:', e.stack || e); process.exit(1); });
