(function () {
  'use strict';

  var STORAGE_KEY = 'pressing-stats-v1';
  var PERIOD_MIN = 15;
  var PERIOD_MS = PERIOD_MIN * 60000;

  // Team A = my team, Team B = opponent.
  // events: pressing actions { team: 'A'|'B', result: 'ok'|'ko', ms: match clock in ms, at: wall-clock ISO }
  // phases: pressing phases  { side: 'A'|'B', startMs, endMs (null while running) }
  // ops:    undo history, each entry is a list of primitive changes made by one tap
  var state = {
    names: { A: 'Team A', B: 'Team B' },
    events: [],
    phases: [],
    ops: [],
    clockMs: 0,
    running: false,
    startedAt: null
  };
  var tick = null;

  function $(id) { return document.getElementById(id); }

  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.events)) {
        state = Object.assign(state, saved);
        if (!Array.isArray(state.phases)) state.phases = [];
        if (!Array.isArray(state.ops)) state.ops = state.events.map(function () { return [{ t: 'event' }]; });
      }
    } catch (e) { /* ignore */ }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function clockNow() {
    return state.running ? state.clockMs + (Date.now() - state.startedAt) : state.clockMs;
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

  // ---- Pressing phases ----

  function currentPhase() {
    var last = state.phases[state.phases.length - 1];
    return last && last.endMs === null ? last : null;
  }

  function phaseEnd(p, now) { return p.endMs === null ? now : p.endMs; }

  // Pressing time per side, optionally limited to the window [from, to).
  function phaseTime(now, from, to) {
    var r = { A: 0, B: 0 };
    state.phases.forEach(function (p) {
      var s = p.startMs, e = phaseEnd(p, now);
      if (from !== undefined) { s = Math.max(s, from); e = Math.min(e, to); }
      if (e > s) r[p.side] += e - s;
    });
    return r;
  }

  function phaseStats(side, now) {
    var list = state.phases.filter(function (p) { return p.side === side; });
    var total = 0, max = 0;
    list.forEach(function (p) {
      var d = phaseEnd(p, now) - p.startMs;
      total += d;
      max = Math.max(max, d);
    });
    return { count: list.length, total: total, max: max, avg: list.length ? total / list.length : 0 };
  }

  function togglePhase(side) {
    if (!state.running) startClock();
    var now = clockNow();
    var cur = currentPhase();
    var op = [];
    if (cur) {
      cur.endMs = now;
      op.push({ t: 'end', idx: state.phases.length - 1 });
    }
    if (!cur || cur.side !== side) {
      state.phases.push({ side: side, startMs: now, endMs: null });
      op.push({ t: 'start' });
    }
    state.ops.push(op);
    save();
    render();
    if (navigator.vibrate) navigator.vibrate(40);
  }

  // ---- Rendering ----

  function renderLive() {
    var now = clockNow();
    $('clock').textContent = fmtClock(now);
    $('clockBtn').textContent = state.running ? 'Pause clock' : (state.clockMs ? 'Resume clock' : 'Start clock');

    var cur = currentPhase();
    var tot = phaseTime(now);
    ['A', 'B'].forEach(function (k) {
      var active = cur && cur.side === k;
      $('phase' + k).classList.toggle('active', !!active);
      $('phaseTime' + k).textContent = active ? fmtClock(now - cur.startMs) : fmtClock(tot[k]);
    });
    var status;
    if (!cur) {
      status = 'No pressing phase running. Tap a button when a pressing phase starts, tap it again when it ends.';
    } else {
      status = (cur.side === 'A' ? 'We are pressing' : 'We are under pressure') +
        ' since ' + fmtClock(cur.startMs) + (state.running ? '' : ' (clock paused)') +
        '. Tap again to end, or tap the other button to switch.';
    }
    $('phaseStatus').textContent = status;
  }

  function render() {
    var now = clockNow();
    var t = tally(state.events);
    var totA = t.A.ok + t.A.ko;
    var totB = t.B.ok + t.B.ko;
    var all = totA + totB;
    var ptime = phaseTime(now);
    var pall = ptime.A + ptime.B;

    ['A', 'B'].forEach(function (k) {
      var name = state.names[k];
      var tot = t[k].ok + t[k].ko;
      if (document.activeElement !== $('name' + k)) $('name' + k).value = name;
      renderNames(k);
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

    renderTimeline(now);
    renderPeriods(now);
    renderLog();
    renderLive();
  }

  function renderNames(k) {
    var name = state.names[k];
    ['head', 'perHead', 'barLabel', 'leg', 'tlName'].forEach(function (p) { $(p + k).textContent = name; });
    $('phaseSub' + k).textContent = name + ' pressing';
  }

  function renderTimeline(now) {
    var lastMs = now;
    state.events.forEach(function (e) { lastMs = Math.max(lastMs, e.ms); });
    var span = Math.max(PERIOD_MS, Math.ceil(lastMs / PERIOD_MS) * PERIOD_MS);
    var x = function (ms) { return (ms / span) * 100 + '%'; };

    var html = '';
    state.phases.forEach(function (p) {
      var e = phaseEnd(p, now);
      html += '<div class="tl-seg ' + p.side.toLowerCase() + (p.endMs === null ? ' live' : '') +
        '" style="left:' + x(p.startMs) + ';width:' + Math.max(0.3, ((e - p.startMs) / span) * 100) + '%" title="' +
        esc(state.names[p.side]) + ' pressing ' + fmtClock(p.startMs) + '–' + fmtClock(e) + '"></div>';
    });
    state.events.forEach(function (ev) {
      html += '<div class="tl-dot ' + ev.team.toLowerCase() + ' ' + ev.result + '" style="left:' + x(ev.ms) +
        '" title="' + fmtClock(ev.ms) + ' ' + esc(state.names[ev.team]) + ': ' +
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
    if (!state.events.length && !state.phases.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">Nothing recorded yet.</td></tr>';
      return;
    }
    var lastMs = 0;
    state.events.forEach(function (e) { lastMs = Math.max(lastMs, e.ms); });
    state.phases.forEach(function (p) { lastMs = Math.max(lastMs, phaseEnd(p, now)); });
    var maxIdx = Math.floor(Math.max(0, lastMs - 1) / PERIOD_MS);

    var html = '';
    for (var i = 0; i <= maxIdx; i++) {
      var from = i * PERIOD_MS, to = from + PERIOD_MS;
      var t = tally(state.events.filter(function (e) {
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
    state.events.forEach(function (e) {
      items.push({ ms: e.ms, html: '<span class="tag tag-' + e.team.toLowerCase() + '">' + esc(state.names[e.team]) +
        '</span>: <span class="res-' + e.result + '">' + (e.result === 'ok' ? 'Successful' : 'Unsuccessful') + '</span> press' });
    });
    state.phases.forEach(function (p) {
      var who = '<span class="tag tag-' + p.side.toLowerCase() + '">' + esc(state.names[p.side]) + '</span>';
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

  // ---- Actions ----

  function record(team, result, btn) {
    state.events.push({ team: team, result: result, ms: clockNow(), at: new Date().toISOString() });
    state.ops.push([{ t: 'event' }]);
    save();
    render();
    if (navigator.vibrate) navigator.vibrate(30);
    btn.classList.add('flash');
    setTimeout(function () { btn.classList.remove('flash'); }, 120);
  }

  function undo() {
    var op = state.ops.pop();
    if (!op) return;
    for (var i = op.length - 1; i >= 0; i--) {
      var c = op[i];
      if (c.t === 'event') state.events.pop();
      else if (c.t === 'start') state.phases.pop();
      else if (c.t === 'end') state.phases[c.idx].endMs = null;
    }
    save();
    render();
  }

  function startClock() {
    state.running = true;
    state.startedAt = Date.now();
    startTick();
  }

  function toggleClock() {
    if (state.running) {
      state.clockMs = clockNow();
      state.running = false;
      state.startedAt = null;
      clearInterval(tick);
    } else {
      startClock();
    }
    save();
    render();
  }

  function startTick() {
    clearInterval(tick);
    tick = setInterval(function () {
      // Refresh the whole report every 5 s while a phase runs, the live counters every tick.
      if (currentPhase() && Math.floor(Date.now() / 500) % 10 === 0) render();
      else renderLive();
    }, 500);
  }

  function exportCsv() {
    var now = clockNow();
    var rows = [['#', 'match_time', 'team', 'result', 'timestamp']];
    state.events.forEach(function (e, i) {
      rows.push([i + 1, fmtClock(e.ms), state.names[e.team], e.result === 'ok' ? 'Successful' : 'Unsuccessful', e.at]);
    });
    rows.push([]);
    rows.push(['phase', 'pressing_team', 'situation', 'start', 'end', 'duration']);
    state.phases.forEach(function (p, i) {
      var e = phaseEnd(p, now);
      rows.push([i + 1, state.names[p.side], p.side === 'A' ? 'We press' : 'Under pressure',
        fmtClock(p.startMs), p.endMs === null ? 'running' : fmtClock(p.endMs), fmtClock(e - p.startMs)]);
    });
    var t = tally(state.events);
    rows.push([]);
    rows.push(['summary', 'team', 'successful', 'unsuccessful', 'success_rate', 'pressing_time', 'phases']);
    ['A', 'B'].forEach(function (k) {
      var ps = phaseStats(k, now);
      rows.push(['', state.names[k], t[k].ok, t[k].ko, pct(t[k].ok, t[k].ok + t[k].ko), fmtClock(ps.total), ps.count]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'pressing-stats-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function init() {
    load();

    document.querySelectorAll('.press').forEach(function (btn) {
      btn.addEventListener('click', function () { record(btn.dataset.team, btn.dataset.result, btn); });
    });
    document.querySelectorAll('.phase').forEach(function (btn) {
      btn.addEventListener('click', function () { togglePhase(btn.dataset.side); });
    });

    ['A', 'B'].forEach(function (k) {
      $('name' + k).addEventListener('input', function (ev) {
        state.names[k] = ev.target.value.trim() || 'Team ' + k;
        save();
        render();
      });
    });

    $('clockBtn').addEventListener('click', toggleClock);
    $('undoBtn').addEventListener('click', undo);
    $('csvBtn').addEventListener('click', exportCsv);
    $('resetBtn').addEventListener('click', function () {
      if (!confirm('Reset all pressing statistics, phases and the clock?')) return;
      clearInterval(tick);
      state.events = [];
      state.phases = [];
      state.ops = [];
      state.clockMs = 0;
      state.running = false;
      state.startedAt = null;
      save();
      render();
    });

    if (state.running) startTick();
    render();
  }

  init();
})();
