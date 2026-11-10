'use strict';
// Prueba del almacenamiento en Postgres (requiere DATABASE_URL apuntando a una base vacía de prueba).
const assert = require('assert');
const { Store } = require('../lib/store');
const url = process.env.DATABASE_URL;
if (!url) { console.log('omitido: falta DATABASE_URL'); process.exit(0); }
(async () => {
  const s = new Store({ databaseUrl: url });
  assert.strictEqual(s.kind, 'postgres');
  await s.init();
  s.upsert('abc-0000000000000000', { alias: 'Ana', avail: { start: 0, end: 0, tz: 'UTC', enabled: true }, langs: ['es'], blocked: ['x'], sub: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } }, lastSeen: Date.now() });
  s.addReport({ at: Date.now(), reporter: 'r1', target: 't1', reason: 'acoso' });
  s.addReport({ at: Date.now(), reporter: 'r2', target: 't1', reason: 'acoso' });
  s.setBan('t1', true); s.setBan('t2', true); s.setBan('t2', false);
  s.upsert('viejo-000000000000000', { alias: 'Viejo', lastSeen: Date.now() - 200 * 24 * 3600 * 1000 });
  await new Promise((r) => setTimeout(r, 500));
  await s.close();

  const s2 = new Store({ databaseUrl: url });
  await s2.init();
  const p = s2.getProfile('abc-0000000000000000');
  assert.strictEqual(p.alias, 'Ana'); assert.deepStrictEqual(p.langs, ['es']); assert.ok(p.sub.endpoint);
  assert.strictEqual(s2.distinctReporters('t1', 1e9), 2);
  assert.ok(s2.isBanned('t1')); assert.ok(!s2.isBanned('t2'));
  assert.strictEqual(s2.getProfile('viejo-000000000000000'), null, 'perfiles inactivos >90 días se borran');
  s2.deleteProfile('abc-0000000000000000');
  await new Promise((r) => setTimeout(r, 300));
  await s2.close();
  const s3 = new Store({ databaseUrl: url }); await s3.init();
  assert.strictEqual(s3.getProfile('abc-0000000000000000'), null);
  await s3.close();
  console.log('ok  Postgres: guardar, reiniciar, leer, borrar, suspensiones y limpieza de inactivos');
  process.exit(0);
})().catch((e) => { console.error('FALLO PG:', e.stack || e); process.exit(1); });
