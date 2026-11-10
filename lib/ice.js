'use strict';
// Servidores ICE (STUN + TURN). El TURN retransmite el audio cuando la conexión directa
// entre dos celulares no es posible (datos móviles, redes de empresas, NAT estrictos).
// Proveedores soportados (se usa el primero que esté configurado):
//   1) Cloudflare Realtime TURN: CF_TURN_KEY_ID + CF_TURN_API_TOKEN   (credenciales temporales de 24 h)
//   2) Metered / Open Relay:     METERED_APP + METERED_API_KEY
//   3) Manual:                   ICE_SERVERS (JSON con el array iceServers)
// Sin nada configurado se usa solo STUN (funciona en muchas redes, no en todas).
const DEFAULT = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
let cache = null;
let inflight = null;
const SIX_HOURS = 6 * 3600 * 1000;

async function fetchJson(url, opts = {}, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function provider() {
  const e = process.env;
  if (e.CF_TURN_KEY_ID && e.CF_TURN_API_TOKEN) return 'cloudflare';
  if (e.METERED_APP && e.METERED_API_KEY && /^[a-z0-9-]+$/i.test(e.METERED_APP)) return 'metered';
  if (e.ICE_SERVERS) return 'manual';
  return 'solo-stun';
}

async function load() {
  const e = process.env;
  switch (provider()) {
    case 'cloudflare': {
      const j = await fetchJson(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(e.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
        { method: 'POST', headers: { Authorization: 'Bearer ' + e.CF_TURN_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }) });
      const arr = Array.isArray(j.iceServers) ? j.iceServers : (j.iceServers ? [j.iceServers] : []);
      if (!arr.length) throw new Error('Cloudflare no devolvió iceServers');
      return arr;
    }
    case 'metered': {
      const j = await fetchJson(`https://${e.METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(e.METERED_API_KEY)}`);
      if (!Array.isArray(j) || !j.length) throw new Error('Metered no devolvió servidores');
      return j;
    }
    case 'manual': {
      const j = JSON.parse(e.ICE_SERVERS);
      if (!Array.isArray(j)) throw new Error('ICE_SERVERS debe ser un array');
      return j;
    }
    default: return null;
  }
}

async function getIceServers() {
  const now = Date.now();
  if (cache && cache.exp > now) return cache.value;
  if (!inflight) {
    inflight = (async () => {
      try {
        const v = await load();
        cache = { value: v || DEFAULT, exp: Date.now() + (v ? SIX_HOURS : 24 * 3600 * 1000) };
        return cache.value;
      } catch (err) {
        console.error('ICE/TURN:', err.message, '- usando', cache ? 'las credenciales anteriores' : 'solo STUN');
        return cache ? cache.value : DEFAULT;
      } finally { inflight = null; }
    })();
  }
  return inflight;
}

module.exports = { getIceServers, provider, _reset() { cache = null; inflight = null; } };
