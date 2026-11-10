(function () {
  var $ = function (id) { return document.getElementById(id); };
  var key = sessionStorage.getItem('adm') || '';
  function api(path, opts) {
    opts = opts || {}; opts.headers = Object.assign({ Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, opts.headers);
    return fetch(path, opts).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setBan(id, banned) { return api('/admin/api/ban', { method: 'POST', body: JSON.stringify({ id: id, banned: banned }) }).then(load); }
  window.__ban = setBan;
  function load() {
    return api('/admin/api/state').then(function (s) {
      $('login').hidden = true; $('app').hidden = false;
      var items = [['Conectados', s.online], ['Disponibles', s.availableNow], ['Perfiles', s.profiles], ['Con notificaciones', s.withPush],
        ['Suspendidos', s.banned.length], ['Datos en', s.storage], ['TURN', s.turn], ['Push', s.push ? 'sí' : 'no']];
      $('stats').innerHTML = items.map(function (i) { return '<div><small>' + i[0] + '</small><b>' + esc(i[1]) + '</b></div>'; }).join('');
      $('banned').innerHTML = s.banned.length ? s.banned.map(function (id) {
        return '<div class="row"><code>' + esc(id) + '</code><button data-un="' + esc(id) + '">Reactivar</button></div>'; }).join('') : '<small>Nadie</small>';
      $('reports').innerHTML = s.reports.length ? s.reports.map(function (r) {
        return '<div class="row"><span><small>' + new Date(r.at).toLocaleString() + '</small> · ' + esc(r.reason || 'solo bloqueo') + '<br><code>→ ' + esc(r.target) + '</code></span><button class="warn" data-b="' + esc(r.target) + '">Suspender</button></div>'; }).join('') : '<small>Sin reportes</small>';
    }).catch(function () { sessionStorage.removeItem('adm'); $('login').hidden = false; $('app').hidden = true; });
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.un) setBan(t.dataset.un, false);
    if (t.dataset && t.dataset.b && confirm('¿Suspender a esta persona?')) setBan(t.dataset.b, true);
  });
  $('go').onclick = function () { key = $('key').value; sessionStorage.setItem('adm', key); load(); };
  $('ban').onclick = function () { if ($('manual').value) setBan($('manual').value.trim(), true); };
  $('unban').onclick = function () { if ($('manual').value) setBan($('manual').value.trim(), false); };
  $('vapid').onclick = function () {
    api('/admin/api/vapid-keys').then(function (k) {
      $('vapid-out').textContent = 'VAPID_PUBLIC_KEY=' + k.publicKey + '\nVAPID_PRIVATE_KEY=' + k.privateKey + '\nVAPID_SUBJECT=mailto:TU_CORREO@ejemplo.com';
    });
  };
  if (key) load();
})();
