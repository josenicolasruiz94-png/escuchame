'use strict';
// Almacenamiento: todo vive en memoria (rápido) y se guarda en disco (archivo JSON)
// o en Postgres si existe DATABASE_URL. En Render (disco efímero) usar Postgres para
// que perfiles, suscripciones push, bloqueos y suspensiones sobrevivan a reinicios.
const fs = require('fs');
const path = require('path');

const NINETY_DAYS = 90 * 24 * 3600 * 1000;

class FileAdapter {
  constructor(file) { this.file = file; this.state = null; this.t = null; }
  async load() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) {}
    this.state = { profiles: s.profiles || {}, reports: s.reports || [], bans: s.bans || {} };
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch (_) {}
    return this.state;
  }
  _flush() { clearTimeout(this.t); this.t = setTimeout(() => this.flushNow(), 400); if (this.t.unref) this.t.unref(); }
  flushNow() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('No se pudo guardar el archivo de datos:', e.message); }
  }
  putProfile() { this._flush(); }
  delProfile() { this._flush(); }
  addReport() { this._flush(); }
  setBan() { this._flush(); }
  async close() { clearTimeout(this.t); if (this.state) this.flushNow(); }
}

class PgAdapter {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /host=\/|sslmode=disable/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
    this.pool.on('error', (e) => console.error('pg:', e.message));
  }
  async load() {
    await this.pool.query(`
      create table if not exists profiles(id text primary key, data jsonb not null);
      create table if not exists reports(id bigserial primary key, data jsonb not null);
      create table if not exists bans(id text primary key, at bigint not null);`);
    const state = { profiles: {}, reports: [], bans: {} };
    for (const r of (await this.pool.query('select id, data from profiles')).rows) state.profiles[r.id] = r.data;
    for (const r of (await this.pool.query('select data from reports order by id desc limit 5000')).rows.reverse()) state.reports.push(r.data);
    for (const r of (await this.pool.query('select id, at from bans')).rows) state.bans[r.id] = Number(r.at);
    return state;
  }
  _q(sql, params) { this.pool.query(sql, params).catch((e) => console.error('pg:', e.message)); }
  putProfile(id, p) { this._q('insert into profiles(id,data) values($1,$2) on conflict (id) do update set data=excluded.data', [id, JSON.stringify(p)]); }
  delProfile(id) { this._q('delete from profiles where id=$1', [id]); }
  addReport(r) { this._q('insert into reports(data) values($1)', [JSON.stringify(r)]); }
  setBan(id, v) {
    if (v) this._q('insert into bans(id,at) values($1,$2) on conflict (id) do update set at=excluded.at', [id, Date.now()]);
    else this._q('delete from bans where id=$1', [id]);
  }
  async close() { await this.pool.end().catch(() => {}); }
}

class Store {
  constructor(opts = {}) {
    const url = opts.databaseUrl || process.env.DATABASE_URL;
    this.kind = url ? 'postgres' : 'archivo';
    this.adapter = url ? new PgAdapter(url) : new FileAdapter(opts.file || process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json'));
    this.state = null;
  }
  async init() {
    this.state = await this.adapter.load();
    const limit = Date.now() - NINETY_DAYS; // no guardamos perfiles inactivos más de 90 días
    for (const [id, p] of Object.entries(this.state.profiles)) {
      if ((p.lastSeen || 0) < limit) { delete this.state.profiles[id]; this.adapter.delProfile(id); }
    }
  }
  getProfile(id) { return this.state.profiles[id] || null; }
  upsert(id, patch) {
    const cur = this.state.profiles[id] || { id, createdAt: Date.now() };
    const next = Object.assign(cur, patch, { id });
    this.state.profiles[id] = next;
    this.adapter.putProfile(id, next);
    return next;
  }
  deleteProfile(id) { delete this.state.profiles[id]; this.adapter.delProfile(id); }
  pushProfiles() { return Object.values(this.state.profiles).filter((p) => p.sub); }
  counts() {
    const all = Object.values(this.state.profiles);
    return { profiles: all.length, withPush: all.filter((p) => p.sub).length, banned: Object.keys(this.state.bans).length, reports: this.state.reports.length };
  }
  addReport(r) { this.state.reports.push(r); if (this.state.reports.length > 5000) this.state.reports.shift(); this.adapter.addReport(r); }
  recentReports(n = 100) { return this.state.reports.slice(-n).reverse(); }
  distinctReporters(target, sinceMs) {
    const since = Date.now() - sinceMs;
    return new Set(this.state.reports.filter((r) => r.target === target && r.at >= since).map((r) => r.reporter)).size;
  }
  isBanned(id) { return !!this.state.bans[id]; }
  setBan(id, v) { if (v) this.state.bans[id] = Date.now(); else delete this.state.bans[id]; this.adapter.setBan(id, v); }
  bannedList() { return Object.keys(this.state.bans); }
  async close() { await this.adapter.close(); }
}

module.exports = { Store };
