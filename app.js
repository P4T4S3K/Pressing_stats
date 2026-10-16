(function () {
  'use strict';

  var STORAGE_KEY = 'pressing-stats-v1';
  var PERIOD_MIN = 15;

  // events: { team: 'A'|'B', result: 'ok'|'ko', ms: match clock in ms, at: wall-clock ISO }
  var state = {
    names: { A: 'Team A', B: 'Team B' },
    events: [],
    clockMs: 0,
    running: false,
    startedAt: null
  };
  var tick = null;

  function $(id) { return document.getElementById(id); }

  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.events)) state = Object.assign(state, saved);
    } catch (e) { /* ignore */ }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function clockNow() {
    return state.running ? state.clockMs + (Date.now() - state.startedAt) : state.clockMs;
  }

  function fmtClock(ms) {
    var s = Math.floor(ms / 1000);
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

  function renderClock() {
    $('clock').textContent = fmtClock(clockNow());
    $('clockBtn').textContent = state.running ? 'Pause clock' : (state.clockMs ? 'Resume clock' : 'Start clock');
  }

  function render() {
    var t = tally(state.events);
    var totA = t.A.ok + t.A.ko;
    var totB = t.B.ok + t.B.ko;
    var all = totA + totB;

    ['A', 'B'].forEach(function (k) {
      var name = state.names[k];
      var tot = t[k].ok + t[k].ko;
      $('name' + k).value = name;
      ['head', 'perHead', 'barLabel'].forEach(function (p) { $(p + k).textContent = name; });
      $('count' + k + '-ok').textContent = t[k].ok;
      $('count' + k + '-ko').textContent = t[k].ko;
      $('tot' + k).textContent = tot;
      $('ok' + k).textContent = t[k].ok;
      $('ko' + k).textContent = t[k].ko;
      $('rate' + k).textContent = pct(t[k].ok, tot);
      $('share' + k).textContent = pct(tot, all);

      var okW = tot ? (t[k].ok / tot) * 100 : 0;
      var koW = tot ? 100 - okW : 0;
      $('barOk' + k).style.width = okW + '%';
      $('barKo' + k).style.width = koW + '%';
      $('barOk' + k).textContent = okW >= 12 ? Math.round(okW) + '%' : '';
      $('barKo' + k).textContent = koW >= 12 ? Math.round(koW) + '%' : '';
    });

    renderPeriods();
    renderLog();
    renderClock();
  }

  function renderPeriods() {
    var body = document.querySelector('#periodTable tbody');
    if (!state.events.length) {
      body.innerHTML = '<tr><td colspan="3" class="empty">No pressing actions recorded yet.</td></tr>';
      return;
    }
    var buckets = {};
    var maxIdx = 0;
    state.events.forEach(function (e) {
      var i = Math.floor(e.ms / 60000 / PERIOD_MIN);
      maxIdx = Math.max(maxIdx, i);
      (buckets[i] = buckets[i] || []).push(e);
    });
    var html = '';
    for (var i = 0; i <= maxIdx; i++) {
      var t = tally(buckets[i] || []);
      var cell = function (k) {
        var tot = t[k].ok + t[k].ko;
        return tot ? t[k].ok + ' / ' + tot + ' (' + pct(t[k].ok, tot) + ')' : '–';
      };
      html += '<tr><td>' + (i * PERIOD_MIN) + '–' + ((i + 1) * PERIOD_MIN) + "'</td><td>" +
        cell('A') + '</td><td>' + cell('B') + '</td></tr>';
    }
    body.innerHTML = html;
  }

  function renderLog() {
    var log = $('log');
    if (!state.events.length) {
      log.innerHTML = '<li class="empty">Empty</li>';
      return;
    }
    var html = '';
    for (var i = state.events.length - 1; i >= 0; i--) {
      var e = state.events[i];
      html += '<li>' + fmtClock(e.ms) + ' — <span class="tag tag-' + e.team.toLowerCase() + '">' +
        esc(state.names[e.team]) + '</span>: <span class="res-' + e.result + '">' +
        (e.result === 'ok' ? 'Successful' : 'Unsuccessful') + '</span></li>';
    }
    log.innerHTML = html;
  }

  function record(team, result, btn) {
    state.events.push({ team: team, result: result, ms: clockNow(), at: new Date().toISOString() });
    save();
    render();
    if (navigator.vibrate) navigator.vibrate(30);
    btn.classList.add('flash');
    setTimeout(function () { btn.classList.remove('flash'); }, 120);
  }

  function toggleClock() {
    if (state.running) {
      state.clockMs = clockNow();
      state.running = false;
      state.startedAt = null;
      clearInterval(tick);
    } else {
      state.running = true;
      state.startedAt = Date.now();
      startTick();
    }
    save();
    renderClock();
  }

  function startTick() {
    clearInterval(tick);
    tick = setInterval(renderClock, 500);
  }

  function exportCsv() {
    var rows = [['#', 'match_time', 'team', 'result', 'timestamp']];
    state.events.forEach(function (e, i) {
      rows.push([i + 1, fmtClock(e.ms), state.names[e.team], e.result === 'ok' ? 'Successful' : 'Unsuccessful', e.at]);
    });
    var t = tally(state.events);
    rows.push([]);
    rows.push(['summary', 'team', 'successful', 'unsuccessful', 'success_rate']);
    ['A', 'B'].forEach(function (k) {
      rows.push(['', state.names[k], t[k].ok, t[k].ko, pct(t[k].ok, t[k].ok + t[k].ko)]);
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

    ['A', 'B'].forEach(function (k) {
      $('name' + k).addEventListener('input', function (ev) {
        state.names[k] = ev.target.value.trim() || 'Team ' + k;
        save();
        ['head', 'perHead', 'barLabel'].forEach(function (p) { $(p + k).textContent = state.names[k]; });
        renderLog();
      });
    });

    $('clockBtn').addEventListener('click', toggleClock);
    $('undoBtn').addEventListener('click', function () {
      if (!state.events.length) return;
      state.events.pop();
      save();
      render();
    });
    $('csvBtn').addEventListener('click', exportCsv);
    $('resetBtn').addEventListener('click', function () {
      if (!confirm('Reset all pressing statistics and the clock?')) return;
      clearInterval(tick);
      state.events = [];
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
