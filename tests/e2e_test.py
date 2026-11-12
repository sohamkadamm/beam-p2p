"""
End-to-end test for Beam: two real browsers (a "screen" and a "phone") pair through
the QR link and send files both ways. Every received file is checked byte-for-byte.

  pip install playwright && python -m playwright install chromium
  npm run build && ADMIN_PASSWORD=beam-test npm start     # in another terminal
  python tests/e2e_test.py              # BEAM_URL=http://localhost:3000 by default

Run it against a freshly started server: it checks the usage counters from zero.
"""
import base64, hashlib, json, os, time, urllib.error, urllib.request, zipfile
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BEAM_URL', 'http://localhost:3000')
ADMIN_PASSWORD = os.environ.get('BEAM_ADMIN_PASSWORD', 'beam-test')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output')
FIX = os.path.join(OUT, 'fixtures'); SHOTS = os.path.join(OUT, 'screenshots'); DL = os.path.join(OUT, 'downloads')
for d in (FIX, SHOTS, DL): os.makedirs(d, exist_ok=True)

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

# fixtures
big = os.path.join(FIX, 'lecture-recording.bin')
if not os.path.exists(big):
    with open(big, 'wb') as f: f.write(os.urandom(40 * 1024 * 1024))
txt = os.path.join(FIX, 'notes.txt'); open(txt, 'w').write('Beam test notes\n' * 200)
png = os.path.join(FIX, 'photo.png')
open(png, 'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAW0lEQVR4nO3PQQ0AIBDAsANT+JeEDxQsJBXQ9Wbm/g4ckC7ABdIFuEC6ABdIF+AC6QJcIF2AC6QLcIF0AS6QLsAF0gW4QLoAF0gX4ALpAlwgXYALpAtwwfeB5gvYPgGmEiNkAAAAAElFTkSuQmCC'))
proj = os.path.join(FIX, 'WT_Project')
os.makedirs(os.path.join(proj, 'src', 'components'), exist_ok=True)
open(os.path.join(proj, 'README.md'), 'w').write('# WT project\n')
open(os.path.join(proj, 'src', 'App.tsx'), 'w').write('export default function App() { return null }\n')
open(os.path.join(proj, 'src', 'components', 'Card.tsx'), 'w').write('export const Card = () => null\n' * 50)

ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox']
ok = lambda m: print('  PASS', m)

with sync_playwright() as p:
    chrome = os.environ.get('CHROME_PATH')
    browser = p.chromium.launch(executable_path=chrome, args=ARGS) if chrome else p.chromium.launch(args=ARGS)
    hostc = browser.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
    guestc = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2,
        user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36', accept_downloads=True)
    intruder = browser.new_context(viewport={'width': 390, 'height': 844})
    host = hostc.new_page(); guest = guestc.new_page()
    errors = []
    for pg, name in ((host, 'host'), (guest, 'guest')):
        pg.on('pageerror', lambda e, n=name: errors.append(f'{n}: {e}'))
        pg.on('console', lambda m, n=name: m.type == 'error' and errors.append(f'{n} console: {m.text}'))

    print('1. QR screen')
    host.goto(BASE)
    ap = host.locator('figure.aperture[data-room-url]')
    expect(ap).to_be_visible(timeout=10000)
    expect(host.locator('.qr svg')).to_be_visible()
    room_url = ap.get_attribute('data-room-url')
    assert '/r/' in room_url and len(room_url.split('/r/')[1]) >= 20, room_url
    ok(f'QR encodes {room_url}')
    host.wait_for_timeout(1200)
    host.screenshot(path=f'{SHOTS}/1-host-qr.png')
    guest_url = BASE + '/r/' + room_url.split('/r/')[1]

    print('2. Scan + approval')
    guest.goto(guest_url)
    expect(guest.get_by_text('Press Allow on')).to_be_visible(timeout=8000)
    expect(host.get_by_role('alertdialog')).to_be_visible()
    expect(host.get_by_text('Android phone, Chrome wants to connect')).to_be_visible()
    ok('phone waits; screen shows approval with device name')
    intr = intruder.new_page(); intr.goto(guest_url)
    expect(intr.get_by_text('That screen is already connected')).to_be_visible(timeout=8000)
    ok('second scanner blocked while approval pending')
    host.screenshot(path=f'{SHOTS}/2-host-approval.png')
    guest.screenshot(path=f'{SHOTS}/2-guest-waiting.png')
    host.get_by_role('button', name='Allow').click()
    expect(host.get_by_test_id('link-status')).to_contain_text('Connected to', timeout=15000)
    expect(guest.get_by_test_id('link-status')).to_contain_text('Connected to', timeout=15000)
    ok('connected: ' + host.get_by_test_id('link-status').locator('span').nth(1).inner_text())
    hc_code = host.get_by_test_id('safety-code').locator('strong').inner_text()
    gc_code = guest.get_by_test_id('safety-code').locator('strong').inner_text()
    assert hc_code == gc_code and len(hc_code.replace(' ', '')) == 6, (hc_code, gc_code)
    ok(f'safety code matches on both screens: {hc_code}')
    intr.goto(guest_url)
    expect(intr.get_by_text('That screen is already connected')).to_be_visible(timeout=8000)
    ok('room locked after pairing')
    host.screenshot(path=f'{SHOTS}/3-host-connected.png')

    print('3. Screen -> phone: 3 files incl. 40 MB')
    host.get_by_test_id('file-input').set_input_files([big, txt, png])
    expect(host.locator('[data-direction=out]').first).to_have_attribute('data-transfer-status', 'waiting', timeout=5000)
    card = guest.locator('[data-direction=in]').first
    expect(card).to_have_attribute('data-transfer-status', 'pending', timeout=5000)
    guest.screenshot(path=f'{SHOTS}/4-guest-incoming.png')
    t0 = time.time()
    guest.get_by_test_id('accept').click()
    guest.wait_for_timeout(300); host.screenshot(path=f'{SHOTS}/5-host-sending.png')
    expect(card).to_have_attribute('data-transfer-status', 'done', timeout=60000)
    dt = time.time() - t0
    expect(host.locator('[data-direction=out]').first).to_have_attribute('data-transfer-status', 'done', timeout=10000)
    assert card.locator('.verified').count() == 3, card.locator('.verified').count()
    ok(f'40 MB set received + all 3 SHA-256 verified in {dt:.1f}s; sender shows done')
    guest.screenshot(path=f'{SHOTS}/6-guest-received.png', full_page=True)
    with guest.expect_download() as d:
        guest.get_by_test_id('zip').click()
    z = os.path.join(DL, 'set1.zip'); d.value.save_as(z)
    with zipfile.ZipFile(z) as zf:
        names = sorted(zf.namelist())
        for n, src in (('lecture-recording.bin', big), ('notes.txt', txt), ('photo.png', png)):
            assert hashlib.sha256(zf.read(n)).hexdigest() == sha(src), n
    ok(f'ZIP download matches originals byte-for-byte: {names}')

    print('4. Screen -> phone: folder')
    host.get_by_test_id('folder-input').set_input_files(proj)
    card2 = guest.locator('[data-direction=in]').first
    expect(card2).to_have_attribute('data-transfer-status', 'pending', timeout=5000)
    expect(card2.locator('.card-title')).to_have_text('WT_Project')
    card2.get_by_test_id('accept').click()
    expect(card2).to_have_attribute('data-transfer-status', 'done', timeout=20000)
    with guest.expect_download() as d:
        card2.get_by_test_id('zip').click()
    z2 = os.path.join(DL, 'folder.zip'); d.value.save_as(z2)
    with zipfile.ZipFile(z2) as zf:
        names = sorted(zf.namelist())
    assert 'WT_Project/src/components/Card.tsx' in names, names
    assert d.value.suggested_filename == 'WT_Project.zip', d.value.suggested_filename
    ok(f'folder structure kept, ZIP named {d.value.suggested_filename}: {names}')

    print('5. Phone -> screen, decline + accept')
    guest.get_by_test_id('file-input').set_input_files([txt])
    hc = host.locator('[data-direction=in]').first
    expect(hc).to_have_attribute('data-transfer-status', 'pending', timeout=5000)
    hc.get_by_role('button', name='Decline').click()
    expect(guest.locator('[data-direction=out]').first).to_have_attribute('data-transfer-status', 'declined', timeout=5000)
    ok('decline reaches sender')
    guest.get_by_test_id('file-input').set_input_files([png, txt])
    hc = host.locator('[data-direction=in][data-transfer-status=pending]').first
    expect(hc).to_be_visible(timeout=5000)
    hc.get_by_test_id('accept').click()
    expect(host.locator('[data-direction=in]').first).to_have_attribute('data-transfer-status', 'done', timeout=10000)
    ok('phone -> screen transfer done')
    host.screenshot(path=f'{SHOTS}/7-host-received.png')

    print('6. Stop mid-transfer')
    host.get_by_test_id('file-input').set_input_files([big])
    c = guest.locator('[data-direction=in]').first
    expect(c).to_have_attribute('data-transfer-status', 'pending', timeout=5000)
    c.get_by_test_id('accept').click()
    expect(c).to_have_attribute('data-transfer-status', 'active', timeout=5000)
    c.get_by_role('button', name='Stop').click()
    expect(host.locator('[data-direction=out]').first).to_have_attribute('data-transfer-status', 'cancelled', timeout=5000)
    ok('stop from receiver stops sender')

    print('7. Reconnect')
    guest.evaluate('window.__beam.socket.io.engine.close()')
    guest.wait_for_function('window.__beam.socket.connected === false', timeout=3000)
    guest.wait_for_function('window.__beam.socket.connected === true', timeout=10000)
    guest.wait_for_timeout(600)
    intr.goto(guest_url)
    expect(intr.get_by_text('That screen is already connected')).to_be_visible(timeout=8000)
    expect(guest.get_by_test_id('link-status')).to_contain_text('Connected to')
    ok('phone lost its server connection and resumed the same session (room still locked)')
    host.get_by_test_id('file-input').set_input_files([big])
    c = guest.locator('[data-direction=in]').first
    expect(c).to_have_attribute('data-transfer-status', 'pending', timeout=5000)
    c.get_by_test_id('accept').click()
    expect(c).to_have_attribute('data-transfer-status', 'active', timeout=5000)
    host.evaluate('window.__beam.peer.restartIce(true)')
    expect(c).to_have_attribute('data-transfer-status', 'done', timeout=60000)
    assert c.locator('.verified').count() == 1
    expect(host.get_by_test_id('link-status')).to_contain_text('Connected to')
    ok('network route renegotiated (ICE restart) mid-transfer; 40 MB file still arrived verified')

    print('8. Stats login')
    try:
        urllib.request.urlopen(BASE + '/api/stats'); raise AssertionError('stats should need login')
    except urllib.error.HTTPError as e:
        assert e.code == 401, e.code
    ok('stats API refuses requests without login (401)')
    sp = hostc.new_page(); sp.goto(BASE + '/stats')
    expect(sp.get_by_role('heading', name='Sign in to see usage')).to_be_visible(timeout=5000)
    sp.get_by_label('Password').fill('wrong-password'); sp.get_by_role('button', name='Sign in').click()
    expect(sp.get_by_text('Wrong password.')).to_be_visible()
    sp.screenshot(path=f'{SHOTS}/8-signin.png')
    sp.get_by_label('Password').fill(ADMIN_PASSWORD); sp.get_by_role('button', name='Sign in').click()
    expect(sp.get_by_text('Recent transfers')).to_be_visible(timeout=5000)
    ok('wrong password rejected; correct password opens usage')
    s = sp.evaluate("fetch('/api/stats').then(r => r.json())")
    assert s['transfers'] == 4 and s['sessions'] == 1, s
    ok(f"stats: {s['transfers']} transfers, {s['files']} files, {s['bytes']} bytes, avg {s['avgSpeedBps']} B/s")
    sp.wait_for_timeout(500); sp.screenshot(path=f'{SHOTS}/9-stats.png')
    sp.get_by_role('button', name='Sign out').click()
    expect(sp.get_by_role('heading', name='Sign in to see usage')).to_be_visible()
    assert sp.evaluate("fetch('/api/stats').then(r => r.status)") == 401
    ok('sign out works'); sp.close()

    print('9. End session')
    guest.get_by_role('button', name='End session').click()
    expect(host.get_by_test_id('link-status')).to_contain_text('disconnected', timeout=8000)
    expect(host.get_by_role('button', name='Show a new code')).to_be_visible()
    ok('screen sees the phone leave; offers a new code')
    host.get_by_role('button', name='Show a new code').click()
    expect(host.locator('figure.aperture[data-room-url]')).to_be_visible(timeout=8000)
    assert host.locator('figure.aperture').get_attribute('data-room-url') != room_url
    ok('fresh, different QR issued')
    intr.goto(guest_url)
    expect(intr.get_by_text('This code has expired')).to_be_visible(timeout=8000)
    ok('old code no longer works')

    real = [e for e in errors if 'favicon' not in e and 'fonts.g' not in e and 'ERR_TUNNEL' not in e]
    print('page errors:', real or 'none')
    browser.close()
print('ALL TESTS PASSED')
