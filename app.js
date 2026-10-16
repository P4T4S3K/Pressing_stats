(function () {
  'use strict';

  var LOCAL_KEY = 'pressing-stats-v1';
  var PERIOD_MIN = 15;
  var PERIOD_MS = PERIOD_MIN * 60000;
  var QR_LIB = 'vendor/qrcode.js';
  var LAST_CODE_KEY = 'pressing-last-code';
  var ROLES = { A: 'Operator 1 · Team A', B: 'Operator 2 · Team B', view: 'Report only', both: 'Both teams' };
  // Each role is its own installable app: entry page, manifest, icon, home-screen title and colour.
  var APPS = {
    A: { page: 'operator1.html', icon: 'a', title: 'Press Op 1', color: '#1e5bd8' },
    B: { page: 'operator2.html', icon: 'b', title: 'Press Op 2', color: '#e07a10' },
    view: { page: 'report.html', icon: 'view', title: 'Press Report', color: '#1c2230' },
    both: { page: 'index.html', icon: 'both', title: 'Pressing', color: '#1c2230' }
  };

  // Team A = my team, Team B = opponent.
  // Roles: A / B = one operator per team (live sync), view = report only, both = one device for everything.
  var params = new URLSearchParams(location.search);
  var config = window.PRESSING_FIREBASE_CONFIG;
  var syncAvailable = !!(config && config.databaseURL);
  var localOnly = !syncAvailable || params.get('local') === '1';
  var matchCode = sanitizeCode(params.get('m'));
  var role = ROLES[params.get('r')] ? params.get('r') : 'both';
  var lockedRole = role !== 'both';   // opened from the Operator 1 / Operator 2 / Report app

  var store = null;
  var S = null;          // current match state from the store
  var ops = [];          // this device's undo history; each entry lists the changes made by one tap
  var opsKey = 'pressing-undo:' + (localOnly ? 'local' : matchCode + ':' + role);
  var tickCount = 0;

  function $(id) { return document.getElementById(id); }

  function sanitizeCode(c) {
    return (c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
  }

  function randomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var c = '';
    for (var i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  function roleUrl(code, r) {
    var dir = location.origin + location.pathname.replace(/[^/]*$/, '');
    return dir + APPS[r].page + '?m=' + encodeURIComponent(code);
  }

  function loadOps() {
    try { ops = JSON.parse(localStorage.getItem(opsKey)) || []; } catch (e) { ops = []; }
  }

  function saveOps() {
    try { localStorage.setItem(opsKey, JSON.stringify(ops.slice(-200))); } catch (e) { /* ignore */ }
  }

  function clockNow() {
    var c = S.clock;
    return c.running && c.startedAt !== null ? c.clockMs + Math.max(0, store.now() - c.startedAt) : c.clockMs;
  }

  function fmtClock(ms) {
    var s = Math.floor(Math.max(0, ms) / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function pct(n, d) { return d ? Math.round((n / d) * 100) + '%' : '–'; }

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function tally(events) {
    var t = { A: { ok: 0, ko: 0 }, B: { ok: 0, ko: 0 } };
    events.forEach(function (e) { t[e.team][e.result]++; });
    return t;
  }

  function mySides() { return role === 'A' || role === 'B' ? [role] : role === 'both' ? ['A', 'B'] : []; }

  // ---- Pressing phases ----

  function openPhase(side) {
    for (var i = S.phases.length - 1; i >= 0; i--) {
      if (S.phases[i].side === side && S.phases[i].endMs === null) return S.phases[i];
    }
    return null;
  }

  function phaseEnd(p, now) { return p.endMs === null ? Math.max(now, p.startMs) : p.endMs; }

  // Pressing time per side, optionally limited to the window [from, to).
  function phaseTime(now, from, to) {
    var r = { A: 0, B: 0 };
    S.phases.forEach(function (p) {
      var s = p.startMs, e = phaseEnd(p, now);
      if (from !== undefined) { s = Math.max(s, from); e = Math.min(e, to); }
      if (e > s) r[p.side] += e - s;
    });
    return r;
  }

  function phaseStats(side, now) {
    var list = S.phases.filter(function (p) { return p.side === side; });
    var total = 0, max = 0;
    list.forEach(function (p) {
      var d = phaseEnd(p, now) - p.startMs;
      total += d;
      max = Math.max(max, d);
    });
    return { count: list.length, total: total, max: max, avg: list.length ? total / list.length : 0 };
  }

  function togglePhase(side) {
    var now = S.clock.running ? clockNow() : startClock();
    var op = [];
    var open = openPhase(side);
    if (open) {
      store.updatePhase(open.id, { endMs: now });
      op.push({ t: 'end', id: open.id });
    } else {
      // One device recording both sides: starting one side's phase ends the other's.
      var other = role === 'both' ? openPhase(side === 'A' ? 'B' : 'A') : null;
      if (other) {
        store.updatePhase(other.id, { endMs: now });
        op.push({ t: 'end', id: other.id });
      }
      op.push({ t: 'start', id: store.addPhase({ side: side, startMs: now }) });
    }
    ops.push(op);
    saveOps();
    $('undoBtn').disabled = false;
    if (navigator.vibrate) navigator.vibrate(40);
  }

  // ---- Rendering ----

  function renderLive() {
    var now = clockNow();
    $('clock').textContent = fmtClock(now);
    $('clockBtn').textContent = S.clock.running ? 'Pause clock' : (S.clock.clockMs ? 'Resume clock' : 'Start clock');

    var tot = phaseTime(now);
    var openA = openPhase('A'), openB = openPhase('B');
    [['A', openA], ['B', openB]].forEach(function (x) {
      var k = x[0], open = x[1];
      $('phase' + k).classList.toggle('active', !!open);
      $('phaseTime' + k).textContent = open ? fmtClock(now - open.startMs) : fmtClock(tot[k]);
    });

    var parts = [];
    if (openA) parts.push('We are pressing since ' + fmtClock(openA.startMs));
    if (openB) parts.push('We are under pressure since ' + fmtClock(openB.startMs));
    var status = parts.length ? parts.join(' · ') + (S.clock.running ? '' : ' (clock paused)') :
      'No pressing phase running.';
    var mine = mySides();
    if (mine.length === 1) {
      status += mine[0] === 'A' ? ' Tap "We press" when ' : ' Tap "Under pressure" when ';
      status += S.names[mine[0]] + ' starts pressing, tap again when it ends.';
    } else if (!parts.length) {
      status += ' Tap a button when a pressing phase starts, tap it again when it ends.';
    }
    $('phaseStatus').textContent = status;
  }

  function render() {
    var now = clockNow();
    var t = tally(S.events);
    var all = t.A.ok + t.A.ko + t.B.ok + t.B.ko;
    var ptime = phaseTime(now);
    var pall = ptime.A + ptime.B;

    ['A', 'B'].forEach(function (k) {
      var name = S.names[k];
      var tot = t[k].ok + t[k].ko;
      if (document.activeElement !== $('name' + k)) $('name' + k).value = name;
      ['head', 'perHead', 'barLabel', 'leg', 'tlName'].forEach(function (p) { $(p + k).textContent = name; });
      $('phaseSub' + k).textContent = name + ' pressing';
      $('count' + k + '-ok').textContent = t[k].ok;
      $('count' + k + '-ko').textContent = t[k].ko;
      $('tot' + k).textContent = tot;
      $('ok' + k).textContent = t[k].ok;
      $('ko' + k).textContent = t[k].ko;
      $('rate' + k).textContent = pct(t[k].ok, tot);
      $('share' + k).textContent = pct(tot, all);

      var ps = phaseStats(k, now);
      $('ptime' + k).textContent = fmtClock(ps.total);
      $('pmatch' + k).textContent = pct(ps.total, now);
      $('pshare' + k).textContent = pct(ps.total, pall);
      $('pcount' + k).textContent = ps.count;
      $('pavg' + k).textContent = ps.count ? fmtClock(ps.avg) : '–';
      $('pmax' + k).textContent = ps.count ? fmtClock(ps.max) : '–';

      var okW = tot ? (t[k].ok / tot) * 100 : 0;
      var koW = tot ? 100 - okW : 0;
      $('barOk' + k).style.width = okW + '%';
      $('barKo' + k).style.width = koW + '%';
      $('barOk' + k).textContent = okW >= 12 ? Math.round(okW) + '%' : '';
      $('barKo' + k).textContent = koW >= 12 ? Math.round(koW) + '%' : '';

      var bw = pall ? (ptime[k] / pall) * 100 : 0;
      $('bal' + k).style.width = bw + '%';
      $('bal' + k).textContent = bw >= 12 ? Math.round(bw) + '% · ' + fmtClock(ptime[k]) : '';
    });

    $('undoBtn').disabled = !ops.length;
    renderTimeline(now);
    renderPeriods(now);
    renderLog();
    renderLive();
  }

  function renderTimeline(now) {
    var lastMs = now;
    S.events.forEach(function (e) { lastMs = Math.max(lastMs, e.ms); });
    S.phases.forEach(function (p) { lastMs = Math.max(lastMs, phaseEnd(p, now)); });
    var span = Math.max(PERIOD_MS, Math.ceil(lastMs / PERIOD_MS) * PERIOD_MS);
    var x = function (ms) { return (ms / span) * 100 + '%'; };

    var html = '';
    S.phases.forEach(function (p) {
      var e = phaseEnd(p, now);
      html += '<div class="tl-seg ' + p.side.toLowerCase() + (p.endMs === null ? ' live' : '') +
        '" style="left:' + x(p.startMs) + ';width:' + Math.max(0.3, ((e - p.startMs) / span) * 100) + '%" title="' +
        esc(S.names[p.side]) + ' pressing ' + fmtClock(p.startMs) + '–' + fmtClock(e) + '"></div>';
    });
    S.events.forEach(function (ev) {
      html += '<div class="tl-dot ' + ev.team.toLowerCase() + ' ' + ev.result + '" style="left:' + x(ev.ms) +
        '" title="' + fmtClock(ev.ms) + ' ' + esc(S.names[ev.team]) + ': ' +
        (ev.result === 'ok' ? 'Successful' : 'Unsuccessful') + '"></div>';
    });
    if (now > 0) html += '<div class="tl-now" style="left:' + x(now) + '"></div>';
    $('timeline').innerHTML = html;

    var step = span <= 30 * 60000 ? 5 : 15;
    var axis = '';
    for (var m = 0; m <= span / 60000; m += step) {
      axis += '<span style="left:' + x(m * 60000) + '">' + m + "'</span>";
    }
    $('timelineAxis').innerHTML = axis;
  }

  function renderPeriods(now) {
    var body = document.querySelector('#periodTable tbody');
    if (!S.events.length && !S.phases.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">Nothing recorded yet.</td></tr>';
      return;
    }
    var lastMs = 0;
    S.events.forEach(function (e) { lastMs = Math.max(lastMs, e.ms); });
    S.phases.forEach(function (p) { lastMs = Math.max(lastMs, phaseEnd(p, now)); });
    var maxIdx = Math.floor(Math.max(0, lastMs - 1) / PERIOD_MS);

    var html = '';
    for (var i = 0; i <= maxIdx; i++) {
      var from = i * PERIOD_MS, to = from + PERIOD_MS;
      var t = tally(S.events.filter(function (e) {
        return Math.min(Math.floor(e.ms / PERIOD_MS), maxIdx) === i;
      }));
      var pt = phaseTime(now, from, to);
      var cell = function (k) {
        var tot = t[k].ok + t[k].ko;
        return '<td>' + (tot ? t[k].ok + ' / ' + tot + ' (' + pct(t[k].ok, tot) + ')' : '–') + '</td>' +
          '<td>' + (pt[k] ? fmtClock(pt[k]) : '–') + '</td>';
      };
      html += '<tr><td>' + (i * PERIOD_MIN) + '–' + ((i + 1) * PERIOD_MIN) + "'</td>" + cell('A') + cell('B') + '</tr>';
    }
    body.innerHTML = html;
  }

  function renderLog() {
    var items = [];
    S.events.forEach(function (e) {
      items.push({ ms: e.ms, html: '<span class="tag tag-' + e.team.toLowerCase() + '">' + esc(S.names[e.team]) +
        '</span>: <span class="res-' + e.result + '">' + (e.result === 'ok' ? 'Successful' : 'Unsuccessful') + '</span> press' });
    });
    S.phases.forEach(function (p) {
      var who = '<span class="tag tag-' + p.side.toLowerCase() + '">' + esc(S.names[p.side]) + '</span>';
      var what = p.side === 'A' ? 'we press' : 'we are under pressure';
      items.push({ ms: p.startMs, html: '<span class="phase-ev">▶ ' + who + ' pressing phase starts (' + what + ')</span>' });
      if (p.endMs !== null) {
        items.push({ ms: p.endMs, html: '<span class="phase-ev">■ ' + who + ' pressing phase ends after ' +
          fmtClock(p.endMs - p.startMs) + '</span>' });
      }
    });
    if (!items.length) {
      $('log').innerHTML = '<li class="empty">Empty</li>';
      return;
    }
    // Stable sort, newest first.
    items = items.map(function (it, i) { return { it: it, i: i }; })
      .sort(function (a, b) { return (b.it.ms - a.it.ms) || (b.i - a.i); })
      .map(function (x) { return x.it; });
    $('log').innerHTML = items.map(function (it) {
      return '<li>' + fmtClock(it.ms) + ' — ' + it.html + '</li>';
    }).join('');
  }

  function renderSync(status) {
    var pill = $('syncPill');
    var text, cls;
    if (store.mode === 'local') {
      text = role === 'both' ? 'This device only' : ROLES[role] + ' · not synced (this phone only)';
      cls = role === 'both' ? 'local' : 'offline';
    } else if (status === 'online') {
      text = 'Live · ' + matchCode + ' · ' + ROLES[role];
      cls = 'online';
    } else if (status === 'offline') {
      text = 'Offline – will sync · ' + ROLES[role];
      cls = 'offline';
    } else if (status === 'connecting') {
      text = 'Connecting… · ' + matchCode;
      cls = 'offline';
    } else {
      text = 'Sync problem: ' + status.replace(/^error: /, '');
      cls = 'error';
    }
    pill.textContent = text;
    pill.className = 'sync-pill ' + cls;
  }

  // ---- Actions ----

  function record(team, result, btn) {
    var id = store.addEvent({ team: team, result: result, ms: clockNow(), at: new Date().toISOString() });
    ops.push([{ t: 'event', id: id }]);
    saveOps();
    $('undoBtn').disabled = false;
    if (navigator.vibrate) navigator.vibrate(30);
    btn.classList.add('flash');
    setTimeout(function () { btn.classList.remove('flash'); }, 120);
  }

  function exists(list, id) {
    return list.some(function (x) { return x.id === id; });
  }

  // Undo this device's last tap. Skips taps whose data is already gone (e.g. after a reset).
  function undo() {
    while (ops.length) {
      var op = ops.pop();
      var applied = false;
      for (var i = op.length - 1; i >= 0; i--) {
        var c = op[i];
        if (c.t === 'event' && exists(S.events, c.id)) { store.removeEvent(c.id); applied = true; }
        else if (c.t === 'start' && exists(S.phases, c.id)) { store.removePhase(c.id); applied = true; }
        else if (c.t === 'end' && exists(S.phases, c.id)) { store.updatePhase(c.id, { endMs: null }); applied = true; }
      }
      if (applied) break;
    }
    saveOps();
    render();
  }

  // Starts the shared match clock and returns the match time it starts from.
  function startClock() {
    store.setClock({ running: true, clockMs: S.clock.clockMs, startedAt: store.now() });
    return S.clock.clockMs;
  }

  function toggleClock() {
    if (S.clock.running) store.setClock({ running: false, clockMs: clockNow(), startedAt: null });
    else startClock();
  }

  function exportCsv() {
    var now = clockNow();
    var rows = [['#', 'match_time', 'team', 'result', 'timestamp']];
    S.events.forEach(function (e, i) {
      rows.push([i + 1, fmtClock(e.ms), S.names[e.team], e.result === 'ok' ? 'Successful' : 'Unsuccessful', e.at]);
    });
    rows.push([]);
    rows.push(['phase', 'pressing_team', 'situation', 'start', 'end', 'duration']);
    S.phases.forEach(function (p, i) {
      var e = phaseEnd(p, now);
      rows.push([i + 1, S.names[p.side], p.side === 'A' ? 'We press' : 'Under pressure',
        fmtClock(p.startMs), p.endMs === null ? 'running' : fmtClock(p.endMs), fmtClock(e - p.startMs)]);
    });
    var t = tally(S.events);
    rows.push([]);
    rows.push(['summary', 'team', 'successful', 'unsuccessful', 'success_rate', 'pressing_time', 'phases']);
    ['A', 'B'].forEach(function (k) {
      var ps = phaseStats(k, now);
      rows.push(['', S.names[k], t[k].ok, t[k].ko, pct(t[k].ok, t[k].ok + t[k].ko), fmtClock(ps.total), ps.count]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'pressing-stats-' + (matchCode && !localOnly ? matchCode + '-' : '') +
      new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function resetMatch() {
    var msg = store.mode === 'local' ? 'Reset all pressing statistics, phases and the clock?' :
      'Reset match ' + matchCode + ' for ALL devices? All pressing actions, phases and the clock will be deleted.';
    if (!confirm(msg)) return;
    store.reset();
    ops = [];
    saveOps();
  }

  // ---- Match setup (live sync) ----

  function showSetup(inMatch) {
    $('setup').hidden = false;
    $('main').hidden = !inMatch;
    $('closeSetupBtn').hidden = !inMatch;
    var last = '';
    try { last = localStorage.getItem(LAST_CODE_KEY) || ''; } catch (e) { /* ignore */ }
    $('matchCode').value = matchCode || last || randomCode();
    // Operator apps only offer their own role.
    document.querySelectorAll('.role').forEach(function (b) {
      b.hidden = lockedRole && b.dataset.role !== role;
    });
    if (lockedRole) {
      $('setupHint').innerHTML = '<b>' + esc(ROLES[role]) + '</b>: enter the <b>same match code</b> as the other ' +
        'operator, then tap the button below. Operator 1 can show a QR code with the code under <b>Match</b>.';
    }
    if (inMatch) renderShare();
    window.scrollTo(0, 0);
  }

  function hideSetup() {
    $('setup').hidden = true;
    $('main').hidden = false;
  }

  function joinAs(r) {
    var code = sanitizeCode($('matchCode').value);
    if (!code) {
      $('matchCode').focus();
      return;
    }
    try { localStorage.setItem(LAST_CODE_KEY, code); } catch (e) { /* ignore */ }
    location.href = roleUrl(code, r);
  }

  function loadQrLib() {
    if (window.qrcode) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = QR_LIB;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function renderShare() {
    $('share').hidden = false;
    $('shareCode').textContent = matchCode;
    var html = '';
    ['A', 'B', 'view'].forEach(function (r) {
      var url = roleUrl(matchCode, r);
      html += '<div class="share-card share-' + r + '">' +
        '<b>' + ROLES[r] + '</b>' +
        '<div class="qr" data-url="' + esc(url) + '"></div>' +
        '<input readonly value="' + esc(url) + '">' +
        '<button class="ctrl copy" data-url="' + esc(url) + '">Copy link</button></div>';
    });
    $('shareGrid').innerHTML = html;
    $('shareGrid').querySelectorAll('.copy').forEach(function (b) {
      b.addEventListener('click', function () {
        var url = b.dataset.url;
        var done = function () { b.textContent = 'Copied!'; setTimeout(function () { b.textContent = 'Copy link'; }, 1500); };
        if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
          navigator.share({ title: 'Pressing Stats ' + matchCode, url: url }).catch(function () {});
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(done, function () { b.previousSibling.select(); });
        } else {
          b.previousSibling.select();
        }
      });
    });
    loadQrLib().then(function () {
      $('shareGrid').querySelectorAll('.qr').forEach(function (el) {
        var qr = window.qrcode(0, 'M');
        qr.addData(el.dataset.url);
        qr.make();
        el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      });
    }).catch(function () { /* links still work without QR codes */ });
  }

  // ---- Start-up ----

  function bindUi() {
    document.querySelectorAll('.press').forEach(function (btn) {
      btn.addEventListener('click', function () { record(btn.dataset.team, btn.dataset.result, btn); });
    });
    document.querySelectorAll('.phase').forEach(function (btn) {
      btn.addEventListener('click', function () { togglePhase(btn.dataset.side); });
    });
    ['A', 'B'].forEach(function (k) {
      $('name' + k).addEventListener('change', function (ev) {
        store.setName(k, ev.target.value.trim() || 'Team ' + k);
      });
    });
    $('clockBtn').addEventListener('click', toggleClock);
    $('undoBtn').addEventListener('click', undo);
    $('csvBtn').addEventListener('click', exportCsv);
    $('resetBtn').addEventListener('click', resetMatch);
    $('matchBtn').addEventListener('click', function () { showSetup(!!store); });
    $('closeSetupBtn').addEventListener('click', hideSetup);
    $('newCodeBtn').addEventListener('click', function () { $('matchCode').value = randomCode(); });
    document.querySelectorAll('.role').forEach(function (btn) {
      btn.addEventListener('click', function () { joinAs(btn.dataset.role); });
    });
  }

  function start(s) {
    store = s;
    S = store.state;
    loadOps();
    store.onChange(function (state) { S = state; render(); });
    store.onStatus(renderSync);
    renderSync(store.status);
    render();
    setInterval(function () {
      tickCount++;
      // Live counters every tick; the whole report every 5 s while the clock runs.
      if (S.clock.running && tickCount % 10 === 0) render();
      else renderLive();
    }, 500);
  }

  function applyAppIdentity() {
    var app = APPS[role];
    document.title = (role === 'both' ? '' : ROLES[role] + ' – ') + 'Pressing Stats';
    if (role !== 'both') $('appTitle').textContent = role === 'view' ? 'Pressing Report' : ROLES[role].split(' · ')[0];
    $('manifestLink').href = 'manifest-' + app.icon + '.webmanifest';
    $('favicon').href = $('appleIcon').href = 'icons/' + app.icon + '-192.png';
    $('appleTitle').content = app.title;
    $('themeColor').content = app.color;
  }

  function init() {
    document.body.className = 'role-' + role;
    applyAppIdentity();
    bindUi();
    $('matchBtn').hidden = !syncAvailable;
    $('localLink').hidden = !syncAvailable;
    $('localLink').href = '?local=1' + (lockedRole ? '&r=' + role : '');
    if (matchCode && !localOnly) {
      try { localStorage.setItem(LAST_CODE_KEY, matchCode); } catch (e) { /* ignore */ }
    }

    if (localOnly) {
      PressingStore.local(LOCAL_KEY).then(start);
      return;
    }
    if (!matchCode) {
      $('clockBtn').hidden = true;
      $('syncPill').textContent = 'Choose match & role';
      showSetup(false);
      return;
    }
    PressingStore.firebase(config, matchCode).then(start, function (err) {
      $('syncPill').textContent = 'Sync problem: ' + err.message;
      $('syncPill').className = 'sync-pill error';
    });
  }

  init();
})();
