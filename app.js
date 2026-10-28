// Hours web app (iPhone PWA). Same backend and relay format as the Android widget.
const $ = id => document.getElementById(id);
// One-link setup: …/#k=<secret> saves the secret on this device, then removes it from the address bar.
(() => {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('k')) {
    localStorage.hoursSecret = h.get('k').trim();
    if (h.get('mode')) localStorage.hoursMode = h.get('mode');
    localStorage.removeItem('hoursStatus');
    // iPhone home-screen apps get their own storage, separate from Safari. So in a normal Safari tab, keep the
    // link in the address bar until the page is added to the Home Screen (it bookmarks the current address);
    // the home-screen copy saves the secret again and then removes it from its address.
    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (standalone || !/iPhone|iPad|iPod/.test(navigator.userAgent)) history.replaceState(null, '', location.pathname + location.search);
  }
})();
const servedByServer = location.pathname.startsWith('/app/');
const S = {
  get secret() { return localStorage.hoursSecret || ''; },
  get me() { return localStorage.hoursMe || 'Remi'; },
  get other() { return localStorage.hoursOther || 'Wife'; },
  get mode() { return localStorage.hoursMode || (servedByServer ? 'direct' : 'relay'); },
  get url() { return (localStorage.hoursUrl || (servedByServer ? location.origin : '')).replace(/\/+$/, ''); },
  get relay() { return (localStorage.hoursRelay || 'https://ntfy.sh').replace(/\/+$/, ''); },
};
let status = null, busy = false;
try { status = JSON.parse(localStorage.hoursStatus || 'null'); } catch { }

// ---------- relay crypto (matches server/hours_core.py and the Android app) ----------
const enc = new TextEncoder(), dec = new TextDecoder();
const sha = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const topic = async label => 'hours-' + hex(await sha(`hours-relay-v1|${label}|${S.secret}`)).slice(0, 32);
const key = async () => crypto.subtle.importKey('raw', await sha(`hours-relay-v1|key|${S.secret}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
const b64 = u => btoa(String.fromCharCode(...u));
const unb64 = s => Uint8Array.from(atob(s.trim()), c => c.charCodeAt(0));
async function encrypt(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), enc.encode(JSON.stringify(obj))));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12); return b64(all);
}
async function decrypt(text) {
  const all = unb64(text);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await key(), all.slice(12))));
}

// ---------- transport ----------
async function http(method, url, body, auth = true) {
  const headers = {};
  if (auth) headers.Authorization = 'Bearer ' + S.secret;
  if (body && auth) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method, headers, body, cache: 'no-store' });
  if (r.status === 401) throw new Error('Wrong secret code');
  if (!r.ok && r.status !== 409) throw new Error('Server said ' + r.status);
  return r;
}
async function fetchStatus() {
  if (S.mode === 'direct') return (await http('GET', S.url + '/status.json')).json();
  const text = await (await http('GET', `${S.relay}/${await topic('status')}/json?poll=1&since=latest`, null, false)).text();
  const msgs = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.event === 'message');
  if (!msgs.length) throw new Error('No data from the relay yet (is the box running?)');
  return decrypt(msgs[msgs.length - 1].message);
}
async function send(cmd) {
  if (S.mode === 'direct') {
    const j = await (await http('POST', S.url + '/api/clock', JSON.stringify(cmd))).json();
    if (j.status) save(j.status);
    if (j.ok === false && !/already/.test(j.error || '')) throw new Error(j.error);
    return;
  }
  await http('POST', `${S.relay}/${await topic('cmd')}`, await encrypt(cmd), false);
}

// ---------- queue (taps keep their own time if the phone is offline) ----------
const queue = () => JSON.parse(localStorage.hoursQueue || '[]');
const setQueue = q => localStorage.hoursQueue = JSON.stringify(q);
async function flush() {
  let q = queue(), sent = false;
  while (q.length) { await send(q[0]); sent = true; q = q.slice(1); setQueue(q); }
  return sent;
}
function save(st) { status = st; localStorage.hoursStatus = JSON.stringify(st); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sync(lastId) {
  if (!S.secret) { render(); return showBanner('Tap ⚙︎ and enter the secret code to connect.'); }
  busy = true; render();
  try {
    const sent = await flush();
    if (S.mode === 'relay') {
      let st = await fetchStatus(); save(st); render();
      if (!sent) {                         // ask the box for a fresh snapshot (relay copies can be ~10 min old)
        const before = st.relay?.published;
        await send({ id: crypto.randomUUID().slice(0, 12), type: 'refresh' });
        for (let i = 0; i < 6 && st.relay?.published === before; i++) { await sleep(1500); st = await fetchStatus(); }
        save(st);
      } else {                             // wait for the box to run the tap and republish
        for (let i = 0; i < 8 && st.relay?.last_command?.id !== lastId; i++) { await sleep(1500); st = await fetchStatus(); save(st); }
      }
    } else save(await fetchStatus());
    hideBanner();
    const lc = status?.relay?.last_command;
    if (lastId && lc?.id === lastId && !lc.ok) showBanner(lc.error || 'That tap was not logged.', true);
  } catch (e) {
    showBanner((queue().length ? 'Saved your tap — it will be sent with its original time when back online. ' : 'Offline: ') + e.message, true);
  }
  busy = false; render();
}

async function tap(person) {
  const st = status || {};
  const isIn = person === 'me' ? st.clocked_in : st.other_clocked_in;
  const cmd = { id: crypto.randomUUID().slice(0, 12), type: 'clock', person, action: isIn ? 'out' : 'in', at_ms: Date.now(), source: 'iphone' };
  setQueue([...queue(), cmd]);
  if (navigator.vibrate) navigator.vibrate(10);
  await sync(cmd.id);
}

// ---------- render ----------
const fmt = h => { const m = Math.round(Math.max(h || 0, 0) * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const num = h => (Math.round(Math.max(h || 0, 0) * 10) / 10).toString();
const time = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
const day = iso => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
function showBanner(t, err) { const b = $('banner'); b.textContent = t; b.className = 'banner' + (err ? ' err' : ''); b.hidden = false; }
function hideBanner() { $('banner').hidden = true; }

function render() {
  $('today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  $('meName').textContent = S.me; $('otherName').textContent = S.other;
  const st = status, q = queue();
  const pendingFor = p => q.some(c => c.person === p);
  for (const [p, btn] of [['me', $('meBtn')], ['other', $('otherBtn')]]) {
    const isIn = st && (p === 'me' ? st.clocked_in : st.other_clocked_in);
    btn.textContent = pendingFor(p) ? 'Sending…' : isIn ? 'Clock out' : 'Clock in';
    btn.className = 'pill' + (isIn ? ' out' : '');
    btn.disabled = !S.secret || !st || busy || pendingFor(p);
  }
  if (!st) return;
  const cap = st.cap_hours || 19, wk = st.week_hours || 0, lvl = st.alert_level;
  const kind = lvl === 'OVER' ? 'over' : (lvl === 'CLOSE' || lvl === 'LIKELY') ? 'warn' : 'ok';
  $('meWeek').textContent = num(wk); $('capLabel').textContent = `/ ${num(cap)} h`;
  $('chip').textContent = { OK: 'On track', CLOSE: 'Close to cap', LIKELY: 'Likely over', OVER: 'Overtime' }[lvl] || lvl;
  $('chip').className = 'chip ' + kind;
  $('meBar').style.width = Math.min(wk / cap, 1) * 100 + '%'; $('meBar').className = 'fill ' + kind;
  const left = st.remaining_hours, proj = st.projected_hours;
  $('meMsg').textContent = lvl === 'OVER' ? `${fmt(wk - cap)} over the ${num(cap)} h cap this week.`
    : lvl === 'LIKELY' ? `On pace for ${fmt(proj)} by Friday — ${fmt(left)} left before overtime.`
    : lvl === 'CLOSE' ? `Only ${fmt(left)} left before overtime.`
    : `${fmt(left)} left · on pace for ${fmt(proj)} by Friday.`;
  $('meState').textContent = st.today_state; $('meToday').textContent = `${fmt(st.today_hours)} today`;
  $('meDot').className = 'dot' + (st.clocked_in ? ' on' : '');
  const oState = st.other_clocked_in ? `Clocked in since ${st.other_clocked_in_since_display}` : 'Clocked out';
  $('otherState').textContent = oState; $('otherToday').textContent = `${fmt(st.other_today_hours)} today`;
  $('otherDot').className = 'dot' + (st.other_clocked_in ? ' on' : '');
  $('otherWeek').textContent = `${fmt(st.other_week_hours)} this week`;
  const comb = st.combined_week_hours || 0, total = st.total_hours || 38;
  $('combined').textContent = `${fmt(comb)} of ${num(total)} h`;
  $('splitMe').style.width = Math.min(wk / total, 1) * 100 + '%';
  $('splitOther').style.width = Math.min((st.other_week_hours || 0) / total, 1) * 100 + '%';
  $('legMe').textContent = `${S.me} ${st.split_tracked_pct}%`; $('legOther').textContent = `${S.other} ${st.split_other_pct}%`;
  const sh = st.recent_shifts || [];
  $('shifts').innerHTML = sh.length ? sh.slice(0, 8).map(s => `<li><span><span class="who">${esc(s.person === 'other' ? S.other : S.me)}</span><span class="when">${day(s.in)}, ${time(s.in)}–${time(s.out)}</span></span><span class="len">${fmt(s.hours)}</span></li>`).join('') : '<li class="empty">No shifts yet this period.</li>';
  $('updated').textContent = busy ? 'Syncing…' : `Updated ${st.updated_display || ''}`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- settings ----------
function openSettings() {
  $('sSecret').value = S.secret; $('sMe').value = localStorage.hoursMe || ''; $('sOther').value = localStorage.hoursOther || '';
  $('sMode').value = S.mode; $('sUrl').value = localStorage.hoursUrl || (servedByServer ? location.origin : '');
  $('sRelay').value = localStorage.hoursRelay || 'https://ntfy.sh'; toggleFields(); $('settings').showModal();
}
function toggleFields() { const d = $('sMode').value === 'direct'; $('sUrlWrap').hidden = !d; $('sRelayWrap').hidden = d; }
$('sMode').onchange = toggleFields;
$('openSettings').onclick = openSettings;
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  localStorage.hoursSecret = $('sSecret').value.trim();
  localStorage.hoursMe = $('sMe').value.trim(); localStorage.hoursOther = $('sOther').value.trim();
  localStorage.hoursMode = $('sMode').value; localStorage.hoursUrl = $('sUrl').value.trim(); localStorage.hoursRelay = $('sRelay').value.trim();
  localStorage.removeItem('hoursStatus'); status = null; sync();
});
$('meBtn').onclick = () => tap('me');
$('otherBtn').onclick = () => tap('other');
addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden && !busy) sync(); }, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
render(); sync();
