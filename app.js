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

  // Successful / unsuccessful actions per team and situation (press / under).
  function tally(events) {
    var t = {
      A: { press: { ok: 0, ko: 0 }, under: { ok: 0, ko: 0 } },
      B: { press: { ok: 0, ko: 0 }, under: { ok: 0, ko: 0 } }
    };
    events.forEach(function (e) { t[e.team][e.kind][e.result]++; });
    return t;
  }

  var RESULT_LABEL = { ok: 'Successful', ko: 'Unsuccessful' };
  var SITUATION_LABEL = { press: 'when pressing', under: 'under pressure' };

  // ---- Pressing phases ----
  // Each team has two phase kinds: 'press' (we press) and 'under' (we are under pressure).
  // A team has at most one running phase; each operator records only their own team's phases.

  var KINDS = ['press', 'under'];
  var KIND_LABEL = { press: 'we press', under: 'under pressure' };

  function openPhase(team) {
    for (var i = S.phases.length - 1; i >= 0; i--) {
      if (S.phases[i].team === team && S.phases[i].endMs === null) return S.phases[i];
    }
    return null;
  }

  function phaseEnd(p, now) { return p.endMs === null ? Math.max(now, p.startMs) : p.endMs; }

  // Time per team and kind, optionally limited to the window [from, to).
  function phaseTime(now, from, to) {
    var r = { A: { press: 0, under: 0 }, B: { press: 0, under: 0 } };
    S.phases.forEach(function (p) {
      var s = p.startMs, e = phaseEnd(p, now);
      if (from !== undefined) { s = Math.max(s, from); e = Math.min(e, to); }
      if (e > s) r[p.team][p.kind] += e - s;
    });
    return r;
  }

  function phaseStats(team, kind, now) {
    var list = S.phases.filter(function (p) { return p.team === team && p.kind === kind; });
    var total = 0, max = 0;
    list.forEach(function (p) {
      var d = phaseEnd(p, now) - p.startMs;
      total += d;
      max = Math.max(max, d);
    });
    return { count: list.length, total: total, max: max, avg: list.length ? total / list.length : 0 };
  }

  // Tap on "We press" / "Under pressure": starts that phase, ends it when tapped again,
  // and switches directly when the team's other phase is running.
  function togglePhase(team, kind) {
    var now = S.clock.running ? clockNow() : startClock();
    var op = [];
    var open = openPhase(team);
    if (open) {
      store.updatePhase(open.id, { endMs: now });
      op.push({ t: 'end', id: open.id });
    }
    if (!open || open.kind !== kind) {
      op.push({ t: 'start', id: store.addPhase({ team: team, kind: kind, startMs: now }) });
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
    ['A', 'B'].forEach(function (k) {
      var open = openPhase(k);
      KINDS.forEach(function (kind) {
        var active = !!open && open.kind === kind;
        $(kind + k).classList.toggle('active', active);
        $(kind + 'Time' + k).textContent = active ? fmtClock(now - open.startMs) : fmtClock(tot[k][kind]);
      });
      $('status' + k).textContent = open ?
        (open.kind === 'press' ? 'Pressing' : 'Under pressure') + ' since ' + fmtClock(open.startMs) +
          (S.clock.running ? '' : ' (clock paused)') + '. Tap again to end.' :
        'Tap when a phase starts, tap again when it ends.';
    });
  }

  function render() {
    var now = clockNow();
    var t = tally(S.events);
    var ptime = phaseTime(now);
    var bars = '';

    ['A', 'B'].forEach(function (k) {
      var name = S.names[k];
      if (document.activeElement !== $('name' + k)) $('name' + k).value = name;
      ['head', 'perHead', 'balLabel', 'tlName'].forEach(function (p) { $(p + k).textContent = name; });

      KINDS.forEach(function (kind) {
        var c = t[k][kind];
        var tot = c.ok + c.ko;
        var ps = phaseStats(k, kind, now);
        var x = kind === 'press' ? 'p' : 'u';
        $('cnt' + k + '-' + kind + '-ok').textContent = c.ok;
        $('cnt' + k + '-' + kind + '-ko').textContent = c.ko;
        $(x + 'Tot' + k).textContent = tot;
        $(x + 'Ok' + k).textContent = c.ok;
        $(x + 'Ko' + k).textContent = c.ko;
        $(x + 'Rate' + k).textContent = pct(c.ok, tot);
        $(x + 'Time' + k).textContent = fmtClock(ps.total);
        $(x + 'Match' + k).textContent = pct(ps.total, now);
        $(x + 'Count' + k).textContent = ps.count;
        $(x + 'Avg' + k).textContent = ps.count ? fmtClock(ps.avg) : '–';
        $(x + 'Max' + k).textContent = ps.count ? fmtClock(ps.max) : '–';

        var okW = tot ? (c.ok / tot) * 100 : 0;
        var koW = tot ? 100 - okW : 0;
        bars += '<div class="bar-row rate-row"><span class="bar-label tag-' + k.toLowerCase() + '">' + esc(name) +
          '<small>' + (kind === 'press' ? 'we press' : 'under pressure') + '</small></span><div class="bar">' +
          '<div class="bar-ok" style="width:' + okW + '%">' + (okW >= 15 ? Math.round(okW) + '%' : '') + '</div>' +
          '<div class="bar-ko" style="width:' + koW + '%">' + (koW >= 15 ? Math.round(koW) + '%' : '') + '</div></div></div>';
      });

      var pu = ptime[k].press + ptime[k].under;
      var pw = pu ? (ptime[k].press / pu) * 100 : 0;
      var uw = pu ? 100 - pw : 0;
      $('ratio' + k).textContent = pu ? pct(ptime[k].press, pu) + ' / ' + pct(ptime[k].under, pu) : '–';
      $('balPress' + k).style.width = pw + '%';
      $('balUnder' + k).style.width = uw + '%';
      $('balPress' + k).textContent = pw >= 12 ? Math.round(pw) + '%' : '';
      $('balUnder' + k).textContent = uw >= 12 ? Math.round(uw) + '%' : '';
    });
    $('rateBars').innerHTML = bars;

    $('undoBtn').disabled = !ops.length;
    if (!$('combine').hidden) renderSendSummary();
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
      html += '<div class="tl-seg ' + p.team.toLowerCase() + ' ' + p.kind + (p.endMs === null ? ' live' : '') +
        '" style="left:' + x(p.startMs) + ';width:' + Math.max(0.3, ((e - p.startMs) / span) * 100) + '%" title="' +
        esc(S.names[p.team]) + ': ' + KIND_LABEL[p.kind] + ' ' + fmtClock(p.startMs) + '–' + fmtClock(e) + '"></div>';
    });
    S.events.forEach(function (ev) {
      html += '<div class="tl-dot ' + ev.team.toLowerCase() + ' ' + ev.kind + ' ' + ev.result + '" style="left:' + x(ev.ms) +
        '" title="' + fmtClock(ev.ms) + ' ' + esc(S.names[ev.team]) + ': ' + RESULT_LABEL[ev.result] + ' ' +
        SITUATION_LABEL[ev.kind] + '"></div>';
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
        return KINDS.map(function (kind) {
          var c = t[k][kind];
          var tot = c.ok + c.ko;
          var parts = [];
          if (tot) parts.push(c.ok + ' / ' + tot);
          if (pt[k][kind]) parts.push(fmtClock(pt[k][kind]));
          return '<td>' + (parts.length ? parts.join(' · ') : '–') + '</td>';
        }).join('');
      };
      html += '<tr><td>' + (i * PERIOD_MIN) + '–' + ((i + 1) * PERIOD_MIN) + "'</td>" + cell('A') + cell('B') + '</tr>';
    }
    body.innerHTML = html;
  }

  function renderLog() {
    var items = [];
    S.events.forEach(function (e) {
      items.push({ ms: e.ms, html: '<span class="tag tag-' + e.team.toLowerCase() + '">' + esc(S.names[e.team]) +
        '</span>: <span class="res-' + e.result + '">' + RESULT_LABEL[e.result] + '</span> ' + SITUATION_LABEL[e.kind] });
    });
    S.phases.forEach(function (p) {
      var who = '<span class="tag tag-' + p.team.toLowerCase() + '">' + esc(S.names[p.team]) + '</span>';
      items.push({ ms: p.startMs, html: '<span class="phase-ev">▶ ' + who + ': ' + KIND_LABEL[p.kind] + ' starts</span>' });
      if (p.endMs !== null) {
        items.push({ ms: p.endMs, html: '<span class="phase-ev">■ ' + who + ': ' + KIND_LABEL[p.kind] + ' ends after ' +
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
      text = role === 'both' ? 'This device only' : ROLES[role];
      cls = 'local';
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

  function record(team, kind, result, btn) {
    var id = store.addEvent({ team: team, kind: kind, result: result, ms: clockNow(), at: new Date().toISOString() });
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
    var rows = [['#', 'match_time', 'team', 'situation', 'result', 'timestamp']];
    S.events.forEach(function (e, i) {
      rows.push([i + 1, fmtClock(e.ms), S.names[e.team], e.kind === 'press' ? 'We press' : 'Under pressure',
        RESULT_LABEL[e.result], e.at]);
    });
    rows.push([]);
    rows.push(['phase', 'team', 'situation', 'start', 'end', 'duration']);
    S.phases.forEach(function (p, i) {
      var e = phaseEnd(p, now);
      rows.push([i + 1, S.names[p.team], p.kind === 'press' ? 'We press' : 'Under pressure',
        fmtClock(p.startMs), p.endMs === null ? 'running' : fmtClock(p.endMs), fmtClock(e - p.startMs)]);
    });
    var t = tally(S.events);
    rows.push([]);
    rows.push(['summary', 'team', 'situation', 'successful', 'unsuccessful', 'success_rate', 'time', 'phases']);
    ['A', 'B'].forEach(function (k) {
      KINDS.forEach(function (kind) {
        var c = t[k][kind], ps = phaseStats(k, kind, now);
        rows.push(['', S.names[k], kind === 'press' ? 'We press' : 'Under pressure', c.ok, c.ko,
          pct(c.ok, c.ok + c.ko), fmtClock(ps.total), ps.count]);
      });
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

  // ---- Combine stats from both operators (without live sync) ----
  // An operator sends their team's data as a link (report.html#add=<data>) or a file.
  // Adding it on another device replaces that team's data there, so sending again never double-counts.

  function myTeams() { return role === 'A' || role === 'B' ? [role] : ['A', 'B']; }

  function toB64(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64(b64) {
    var s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(atob(s)));
  }

  // Compact payload; times in tenths of a second.
  function buildPayload() {
    var teams = myTeams();
    var d = { v: 2, t: teams, n: {}, c: Math.round(clockNow() / 100), e: [], p: [] };
    teams.forEach(function (k) { d.n[k] = S.names[k]; });
    S.events.forEach(function (e) {
      if (teams.indexOf(e.team) >= 0) {
        d.e.push([e.team, e.result === 'ok' ? 1 : 0, Math.round(e.ms / 100), e.kind === 'under' ? 0 : 1]);
      }
    });
    S.phases.forEach(function (p) {
      if (teams.indexOf(p.team) >= 0) {
        d.p.push([p.team, p.kind === 'press' ? 1 : 0, Math.round(p.startMs / 100),
          p.endMs === null ? -1 : Math.round(p.endMs / 100)]);
      }
    });
    return d;
  }

  function payloadLink(d) {
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'report.html#add=' + toB64(JSON.stringify(d));
  }

  // Accepts a shared link, the bare code after "#add=", or the content of a saved file.
  function parsePayload(text) {
    text = (text || '').trim();
    var d;
    try {
      if (text.charAt(0) === '{') {
        d = JSON.parse(text);
        if (d.pressingStats) d = d.pressingStats;
      } else {
        var i = text.indexOf('#add=');
        d = JSON.parse(fromB64(i >= 0 ? text.slice(i + 5) : text));
      }
    } catch (e) {
      return null;
    }
    var okTeam = function (k) { return k === 'A' || k === 'B'; };
    if (!d || (d.v !== 1 && d.v !== 2) || !Array.isArray(d.t) || !d.t.length || !d.t.every(okTeam) ||
        !Array.isArray(d.e) || !Array.isArray(d.p)) return null;
    // Version 1 links only had pressing phases: [team, start, end].
    if (d.v === 1) d.p = d.p.map(function (x) { return [x[0], 1, x[1], x[2]]; });
    return d;
  }

  function teamsLabel(d) {
    return d.t.map(function (k) { return (d.n && d.n[k]) || S.names[k]; }).join(' + ');
  }

  // Returns a message for the user, or null if they cancelled.
  function addPayload(d) {
    var summary = teamsLabel(d) + ': ' + d.e.length + ' actions, ' + d.p.length +
      ' phases, clock ' + fmtClock((d.c || 0) * 100);
    if (!confirm('Add stats to this report?\n\n' + summary +
        '\n\nEarlier stats of ' + teamsLabel(d) + ' on this device will be replaced.')) return null;

    var fields = {};
    d.t.forEach(function (k) {
      S.events.forEach(function (e) { if (e.team === k) fields['events/' + e.id] = null; });
      S.phases.forEach(function (p) { if (p.team === k) fields['phases/' + p.id] = null; });
      if (d.n && d.n[k]) fields['names/' + k] = String(d.n[k]).slice(0, 60);
    });
    d.e.forEach(function (x) {
      if (d.t.indexOf(x[0]) < 0) return;
      fields['events/' + store.newId('events')] = {
        team: x[0], kind: x[3] === 0 ? 'under' : 'press', result: x[1] ? 'ok' : 'ko', ms: (+x[2] || 0) * 100, at: ''
      };
    });
    d.p.forEach(function (x) {
      if (d.t.indexOf(x[0]) < 0) return;
      var p = { team: x[0], kind: x[1] ? 'press' : 'under', startMs: (+x[2] || 0) * 100 };
      if (x[3] >= 0) p.endMs = x[3] * 100;
      fields['phases/' + store.newId('phases')] = p;
    });
    store.bulk(fields);

    // Show the report up to the latest time received.
    var c = (d.c || 0) * 100;
    if (!S.clock.running && c > S.clock.clockMs) store.setClock({ running: false, clockMs: c, startedAt: null });
    return 'Added ' + summary + '.';
  }

  function showCombineMsg(text, ok) {
    $('combineMsg').textContent = text;
    $('combineMsg').className = 'combine-msg ' + (ok ? 'ok' : 'err');
  }

  function renderSendSummary() {
    var d = buildPayload();
    $('sendSummary').textContent = teamsLabel(d) + ': ' + d.e.length + ' actions (successful / unsuccessful), ' +
      d.p.length + ' phases (we press / under pressure), clock ' + fmtClock(d.c * 100) + '.';
  }

  function openCombine() {
    renderSendSummary();
    $('combine').hidden = false;
    $('combine').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function flash(btn, text) {
    var old = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1500);
  }

  function copyText(text, btn) {
    var fallback = function () {
      $('pasteBox').value = text;
      $('pasteBox').select();
      flash(btn, 'Select & copy the text');
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { flash(btn, 'Copied!'); }, fallback);
    else fallback();
  }

  function shareLink() {
    var d = buildPayload();
    var url = payloadLink(d);
    var title = 'Pressing stats – ' + (role === 'both' ? 'both teams' : ROLES[role]);
    if (navigator.share) {
      navigator.share({ title: title, text: title + ' (' + teamsLabel(d) + '). Open to add to the report:', url: url })
        .catch(function () { /* cancelled */ });
    } else {
      copyText(url, $('shareBtn'));
    }
  }

  function saveFile() {
    var d = buildPayload();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ pressingStats: d })], { type: 'application/json' }));
    a.download = 'pressing-' + teamsLabel(d).replace(/[^A-Za-z0-9]+/g, '-') + '-' +
      new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function addFromText(text) {
    var d = parsePayload(text);
    if (!d) {
      showCombineMsg('This is not a valid stats link or file.', false);
      return;
    }
    var msg = addPayload(d);
    if (msg) {
      showCombineMsg(msg, true);
      $('pasteBox').value = '';
    }
  }

  // A shared link was opened: report.html#add=...
  function addFromHash() {
    if (location.hash.indexOf('#add=') !== 0) return;
    var text = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    var d = parsePayload(text);
    if (!d) {
      alert('This stats link is damaged or incomplete. Ask the operator to send it again.');
      return;
    }
    var msg = addPayload(d);
    if (msg) {
      $('combine').hidden = false;
      showCombineMsg(msg + ' Open the other operator\'s link too to complete the report.', true);
    }
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
      btn.addEventListener('click', function () { record(btn.dataset.team, btn.dataset.kind, btn.dataset.result, btn); });
    });
    document.querySelectorAll('.phase').forEach(function (btn) {
      btn.addEventListener('click', function () { togglePhase(btn.dataset.team, btn.dataset.kind); });
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
    $('combineBtn').addEventListener('click', openCombine);
    $('closeCombineBtn').addEventListener('click', function () { $('combine').hidden = true; });
    $('shareBtn').addEventListener('click', shareLink);
    $('copyBtn').addEventListener('click', function () { copyText(payloadLink(buildPayload()), $('copyBtn')); });
    $('fileBtn').addEventListener('click', saveFile);
    $('pasteBtn').addEventListener('click', function () { addFromText($('pasteBox').value); });
    $('fileInput').addEventListener('change', function (ev) {
      var f = ev.target.files[0];
      if (!f) return;
      f.text().then(addFromText);
      ev.target.value = '';
    });
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
    addFromHash();
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
    if (role === 'A' || role === 'B') $('combineBtn').textContent = 'Send my stats';
    if (role === 'view') $('combineBtn').textContent = 'Add stats';
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
