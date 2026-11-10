# Prueba end-to-end en Chrome headless con micrófono falso: onboarding, llamada real WebRTC, bloqueo, ajustes.
import json, subprocess, time, os
from playwright.sync_api import sync_playwright

env = dict(os.environ, PORT='3111', DATA_FILE='/tmp/esc-e2e.json')
for k in ('DATABASE_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'): env.pop(k, None)
if os.path.exists('/tmp/esc-e2e.json'): os.remove('/tmp/esc-e2e.json')
srv = subprocess.Popen(['node', 'server.js'], env=env)
time.sleep(1.5)
URL = 'http://127.0.0.1:3111/'
ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox',
        '--allow-loopback-in-peer-connection', '--autoplay-policy=no-user-gesture-required']
ok = lambda m: print('ok ', m)

def prof(alias, langs=('es',)):
    return {'esc_accepted2': 'true', 'esc_clientId': json.dumps('%032x' % (abs(hash(alias)) % (1 << 120))),
            'esc_profile': json.dumps({'alias': alias, 'start': 0, 'end': 0, 'enabled': True, 'langs': list(langs)}),
            'esc_blocked': '[]'}

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS, headless=True)

        # --- onboarding de una persona nueva ---
        nctx = b.new_context(permissions=['microphone']); n = nctx.new_page(); errs_n = []
        n.on('pageerror', lambda e: errs_n.append(str(e)))
        n.on('console', lambda m: errs_n.append(m.text) if 'Content Security Policy' in m.text else None)
        n.goto(URL); n.wait_for_selector('#s-welcome:not(.hidden)')
        assert n.is_disabled('#btn-welcome')
        n.check('#accept'); assert n.is_disabled('#btn-welcome'), 'sin confirmar 18+ no debe dejar seguir'
        n.check('#age'); assert not n.is_disabled('#btn-welcome')
        n.click('#btn-welcome'); n.wait_for_selector('#s-setup:not(.hidden)')
        assert n.locator('#langs input').count() == 6
        n.fill('#alias', 'N'); n.click('#btn-save')
        assert 'alias' in n.inner_text('#toast').lower()
        n.fill('#alias', 'Nueva')
        for i in range(6): n.locator('#langs input').nth(i).uncheck()
        n.click('#btn-save'); assert 'idioma' in n.inner_text('#toast').lower()
        n.locator('#langs input').nth(0).check(); n.check('#allday'); n.click('#btn-save')
        n.wait_for_selector('#s-home:not(.hidden)')
        n.wait_for_selector('#btn-call:not([disabled])', timeout=8000)
        ls = {i['name']: i['value'] for i in nctx.storage_state()['origins'][0]['localStorage']}
        assert json.loads(ls['esc_profile'])['langs'] == ['es'] or json.loads(ls['esc_profile'])['langs']
        ok('onboarding (con la CSP activa, sin violaciones): exige 18+, alias, idioma; guarda perfil y conecta')
        assert not errs_n, errs_n

        # --- llamada entre Ana y Beto ---
        pages = {}
        for alias, langs in (('Ana', ('es', 'en')), ('Beto', ('es',))):
            ctx = b.new_context(permissions=['microphone'], bypass_csp=True)  # el arnés de pruebas usa eval
            ctx.add_init_script('(d=>{if(sessionStorage.getItem("seeded"))return;sessionStorage.setItem("seeded","1");for(const k in d)localStorage.setItem(k,d[k])})(' + json.dumps(prof(alias, langs)) + ')')
            pg = ctx.new_page(); errs = []
            pg.on('pageerror', lambda e, a=alias: errs.append((a, str(e)))); pg.goto(URL); pages[alias] = (pg, errs)
        A, B = pages['Ana'][0], pages['Beto'][0]
        for pg in (A, B): pg.wait_for_function("document.getElementById('btn-call').disabled === false", timeout=8000)
        nctx.close()  # la persona "Nueva" se va; quedan solo Ana y Beto
        time.sleep(0.8)
        ok('contador visto por Ana: ' + A.inner_text('#avail-count'))
        A.click('#btn-call')
        B.wait_for_selector('#s-incoming:not(.hidden)', timeout=8000)
        assert 'Ana' in B.inner_text('#in-alias')
        B.click('#btn-accept')
        for pg in (A, B): pg.wait_for_function("document.getElementById('call-state').textContent === 'En llamada'", timeout=15000)
        assert 'Español' in A.inner_text('#shared-langs'), A.inner_text('#shared-langs')
        ok('WebRTC conectado; idioma en común: ' + A.inner_text('#shared-langs'))
        time.sleep(1.2)
        assert B.evaluate("document.getElementById('remote').srcObject.getAudioTracks().length") == 1
        ok('Beto recibe audio remoto; timers ' + A.inner_text('#timer') + ' / ' + B.inner_text('#timer'))
        A.click('#btn-mute'); assert A.inner_text('#btn-mute') == '🔇'

        # --- Beto bloquea y reporta ---
        B.click('#btn-flag'); B.select_option('#flag-reason', 'falta_de_respeto'); B.click('#flag-ok')
        B.wait_for_selector('#s-end:not(.hidden)'); A.wait_for_selector('#s-end:not(.hidden)', timeout=5000)
        assert len(json.loads(B.evaluate("localStorage.getItem('esc_blocked')"))) == 1
        assert not A.is_hidden('#btn-end-flag'), 'Ana puede reportar tras la llamada'
        ok('bloquear/reportar corta la llamada; Ana ve "' + A.inner_text('#end-title') + '" y el botón de reportar')
        A.click('#btn-home'); time.sleep(2.8); A.click('#btn-call')
        A.wait_for_selector('#s-end:not(.hidden)', timeout=8000)
        assert 'nadie' in A.inner_text('#end-title').lower()
        ok('Ana ya no se empareja con Beto')

        # --- ajustes de Beto ---
        B.click('#btn-home'); B.click('#btn-settings'); B.wait_for_selector('#s-setup:not(.hidden)')
        assert not B.is_hidden('#settings-extra') and '1 persona bloqueada' in B.inner_text('#blocked-info')
        assert B.is_disabled('#push-toggle'), 'sin VAPID en el servidor las notificaciones aparecen desactivadas'
        B.click('#btn-unblock'); assert json.loads(B.evaluate("localStorage.getItem('esc_blocked')")) == []
        B.click('#btn-back'); B.wait_for_selector('#s-home:not(.hidden)')
        ok('ajustes: bloqueadas, desbloquear, notificaciones deshabilitadas sin VAPID')

        # --- Beto borra sus datos ---
        B.on('dialog', lambda d: d.accept())
        B.click('#btn-settings'); B.click('#btn-delete')
        B.wait_for_selector('#s-welcome:not(.hidden)', timeout=8000)
        assert B.evaluate("localStorage.getItem('esc_profile')") is None
        ok('borrar mis datos: limpia el servidor y el dispositivo, vuelve a la bienvenida')

        for alias, (pg, errs) in pages.items(): assert not errs, errs
        ok('sin errores de JavaScript')
        b.close()
    print('\nE2E OK')
finally:
    srv.terminate()
