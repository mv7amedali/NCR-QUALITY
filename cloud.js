/* ACROW NCR · طبقة المزامنة مع قاعدة البيانات (Supabase)
   لا تغيّر شكل أو منطق النظام: بتحفظ نفس البيانات في السيرفر وبتجيب تحديثات باقي الأجهزة. */
(function () {
  'use strict';
  const C = window.ACRO_CLOUD || {};
  const enabled = !!(C.url && C.key);
  const BASE = String(C.url || '').replace(/\/+$/, '') + '/rest/v1/';
  const POLL = 3000, OVERLAP = 10000;
  const COLL = { user: 'users', memo: 'memos', audit: 'audit', attachment: 'attachments', notification: 'notifications' };
  const VIEWS = ['dashboard', 'memos', 'newMemo', 'users', 'workflow', 'notifications', 'reports', 'overview', 'detail'];
  const snap = new Map();
  let ready = false, lastMs = 0, flushing = false, again = false, pulling = false, pushTimer = null, cur = 'dashboard', pending = false, lastErrToast = 0;

  const sig = o => JSON.stringify(o, (k, v) => (k === 'data' && typeof v === 'string' && v.length > 200) ? v.length + ':' + v.slice(-40) : v);
  const ms = t => Date.parse(String(t).replace(/(\.\d{3})\d+/, '$1'));

  function hdr(extra) {
    const h = { apikey: C.key, 'Content-Type': 'application/json' };
    if (/^eyJ/.test(C.key)) h.Authorization = 'Bearer ' + C.key;
    return Object.assign(h, extra);
  }
  async function api(path, opt) {
    opt = opt || {};
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 60000);
    try {
      const r = await fetch(BASE + path, Object.assign({}, opt, { headers: hdr(opt.headers), signal: ac.signal }));
      if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
      return r.status === 204 ? null : await r.json();
    } finally { clearTimeout(t); }
  }

  function metaData() { return { areas: db.areas, workflow: db.workflow || {} }; }
  function localRecords() {
    const out = [];
    for (const k in COLL) (db[COLL[k]] || []).forEach(x => out.push({ kind: k, id: String(x.id), data: x }));
    out.push({ kind: 'meta', id: 'config', data: metaData() });
    return out;
  }

  /* ---------- رفع التغييرات المحلية ---------- */
  async function flush() {
    if (!ready) return;
    if (flushing) { again = true; return; }
    flushing = true;
    try {
      do {
        again = false;
        const dirty = new Map();
        for (const r of localRecords()) {
          const k = r.kind + '/' + r.id, s = sig(r.data), o = snap.get(k);
          if (!o || o.sig !== s) dirty.set(k, { r, s });
        }
        const items = [...dirty.values()];
        let i = 0;
        while (i < items.length) {
          const batch = []; let size = 0;
          while (i < items.length && (batch.length === 0 || size < 2500000)) {
            const it = items[i++]; batch.push(it);
            size += it.s.length + (it.r.data.defectImage ? it.r.data.defectImage.data.length : 0) + (it.r.data.repairImage ? it.r.data.repairImage.data.length : 0);
          }
          const res = await api('records?on_conflict=kind,id&select=kind,id,updated_at', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify(batch.map(b => b.r))
          });
          res.forEach(x => { const b = dirty.get(x.kind + '/' + x.id); if (b) snap.set(x.kind + '/' + x.id, { sig: b.s, ts: x.updated_at }); });
        }
      } while (again);
    } catch (e) {
      if (Date.now() - lastErrToast > 30000) { lastErrToast = Date.now(); try { toast('تعذر الحفظ على السيرفر — سيتم إعادة المحاولة تلقائيًا'); } catch (_) {} }
    } finally { flushing = false; }
  }
  function push() { if (!ready) return; clearTimeout(pushTimer); pushTimer = setTimeout(flush, 250); }

  /* ---------- جلب تغييرات الأجهزة الأخرى ---------- */
  async function pull(first) {
    if (pulling) return null;
    pulling = true;
    try {
      const filter = lastMs ? '&updated_at=gt.' + encodeURIComponent(new Date(lastMs - OVERLAP).toISOString()) : '';
      const base = 'records?select=kind,id,updated_at&order=updated_at.asc,kind.asc,id.asc&limit=1000' + filter;
      const changed = []; let off = 0, maxMs = lastMs;
      for (;;) {
        const rows = await api(base + '&offset=' + off);
        rows.forEach(r => {
          maxMs = Math.max(maxMs, ms(r.updated_at));
          const o = snap.get(r.kind + '/' + r.id);
          if (!o || o.ts !== r.updated_at) changed.push(r);
        });
        if (rows.length < 1000) break;
        off += 1000;
      }
      const byKind = {};
      changed.forEach(r => (byKind[r.kind] = byKind[r.kind] || []).push(r.id));
      const got = [];
      for (const k in byKind) {
        const ids = byKind[k], step = k === 'memo' ? 5 : 50;
        for (let i = 0; i < ids.length; i += step) {
          const list = encodeURIComponent(ids.slice(i, i + step).map(x => '"' + x + '"').join(','));
          const rows = await api('records?select=kind,id,data,updated_at&kind=eq.' + encodeURIComponent(k) + '&id=in.(' + list + ')');
          got.push(...rows);
        }
      }
      if (first && got.length) { // السيرفر فيه بيانات: بيانات السيرفر هي المرجع
        db.users = []; db.memos = []; db.audit = []; db.attachments = []; db.notifications = [];
      }
      const newN = apply(got);
      lastMs = maxMs;
      return { n: got.length, newN };
    } finally { pulling = false; }
  }

  function apply(rows) {
    const idx = {}, newN = [];
    rows.forEach(r => {
      if (r.kind === 'meta') {
        if (r.id === 'config' && r.data) {
          if (Array.isArray(r.data.areas) && r.data.areas.length) db.areas.splice(0, db.areas.length, ...r.data.areas);
          db.workflow = r.data.workflow || {};
          snap.set('meta/config', { sig: sig(metaData()), ts: r.updated_at });
        }
        return;
      }
      const name = COLL[r.kind]; if (!name) return;
      const arr = db[name] || (db[name] = []);
      const ix = idx[name] || (idx[name] = new Map(arr.map((x, i) => [String(x.id), i])));
      const p = ix.get(r.id);
      if (p === undefined) { ix.set(r.id, arr.length); arr.push(r.data); if (r.kind === 'notification') newN.push(r.data); }
      else arr[p] = r.data;
      snap.set(r.kind + '/' + r.id, { sig: sig(r.data), ts: r.updated_at });
    });
    db.nextUser = db.users.reduce((m, u) => Math.max(m, Number(u.id) + 1), db.nextUser || 1);
    db.nextMemo = db.memos.reduce((m, x) => Math.max(m, Number(x.id) + 1), db.nextMemo || 1);
    return newN;
  }

  /* ---------- تحديث الشاشة بدون ما نضيّع اللي المستخدم بيكتبه ---------- */
  function editing() {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    return [...document.querySelectorAll('#app textarea, #app input:not([type=radio]):not([type=checkbox]):not([type=hidden])')]
      .some(e => e.type === 'file' ? e.files.length : e.value);
  }
  function refresh() {
    if (editing()) { pending = true; return; }
    pending = false;
    if (!me) { render(); return; }
    const f = window[cur]; (typeof f === 'function' ? f : window.dashboard)();
  }
  function onRemote(r) {
    if (!r || !r.n) return;
    try {
      if (me) {
        const u = db.users.find(x => x.id === me.id); if (u) me = u;
        r.newN.filter(n => n.userId === me.id && !n.read).forEach(n => toast(n.title + ': ' + n.text));
      }
    } catch (_) {}
    refresh();
  }

  async function tick() {
    if (!ready || document.hidden) return;
    try { await flush(); onRemote(await pull(false)); } catch (_) {}
  }

  async function start() {
    const app = document.getElementById('app');
    try { await pull(true); }
    catch (e) {
      app.innerHTML = '<div class="loading">تعذر الاتصال بقاعدة البيانات. تأكد من الإنترنت — جاري إعادة المحاولة...</div>';
      setTimeout(start, 5000); return;
    }
    ready = true;
    render();
    flush(); // لو السيرفر فاضي بيرفع البيانات الموجودة على الجهاز
    setInterval(tick, POLL);
    setInterval(() => { if (pending && !editing()) refresh(); }, 2000);
    document.addEventListener('visibilitychange', () => { document.hidden ? flush() : tick(); });
    window.addEventListener('online', tick);
    window.addEventListener('pagehide', flush);
  }

  function boot() {
    if (!enabled) { render(); return; }
    VIEWS.forEach(n => { const f = window[n]; if (typeof f === 'function') window[n] = function () { cur = n; return f.apply(this, arguments); }; });
    start();
  }

  window.CloudSync = { enabled, boot, push };
})();
