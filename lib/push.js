'use strict';
// Notificaciones push (Web Push + VAPID). Se activan solo si existen VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.
// Generar claves una vez con:  npm run keys
let webpush = null;
let enabled = false;
let publicKey = null;
let sender = null; // para pruebas

function init() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);
    enabled = true; publicKey = pub;
  } catch (e) { console.error('Push desactivado:', e.message); }
  return enabled;
}

// Solo se aceptan endpoints de los servicios de push de los navegadores (evita que alguien
// haga que el servidor envíe peticiones a direcciones internas).
const HOSTS = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;

function validSub(sub) {
  try {
    if (!sub || typeof sub !== 'object') return false;
    const u = new URL(sub.endpoint);
    if (u.protocol !== 'https:' || !HOSTS.test(u.hostname) || sub.endpoint.length > 1000) return false;
    const k = sub.keys || {};
    return typeof k.p256dh === 'string' && typeof k.auth === 'string' && k.p256dh.length < 200 && k.auth.length < 100;
  } catch (_) { return false; }
}

// Devuelve { ok } | { gone } (suscripción vencida) | { fail }
async function notify(sub, payload) {
  try {
    if (sender) { await sender(sub, payload); return { ok: true }; }
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      JSON.stringify(payload), { TTL: 45, urgency: 'high' });
    return { ok: true };
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) return { gone: true };
    console.error('push:', e && (e.statusCode || e.message));
    return { fail: true };
  }
}

module.exports = {
  init, validSub, notify,
  get enabled() { return enabled; },
  get publicKey() { return publicKey; },
  _setSender(fn) { sender = fn; enabled = !!fn; publicKey = fn ? 'TEST_KEY' : null; },
};
