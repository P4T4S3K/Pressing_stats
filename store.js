// Match data storage: on this device only (localStorage) or shared live via Firebase.
// Both stores keep the same tree:
//   names:  { A, B }
//   clock:  { running, clockMs, startedAt }   startedAt is in (server) wall-clock ms
//   events: { id: { team, result, ms, at } }  pressing actions
//   phases: { id: { side, startMs, endMs } }  pressing phases, endMs missing while running
(function () {
  'use strict';

  var FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    return {
      names: { A: 'Team A', B: 'Team B' },
      clock: { running: false, clockMs: 0, startedAt: null },
      events: [],
      phases: []
    };
  }

  function byTime(key) {
    return function (a, b) { return (a[key] - b[key]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); };
  }

  // Tree -> sorted arrays the UI works with.
  function normalize(raw) {
    var s = emptyState();
    if (!raw) return s;
    if (raw.names) {
      s.names.A = raw.names.A || 'Team A';
      s.names.B = raw.names.B || 'Team B';
    }
    if (raw.clock) {
      s.clock = {
        running: !!raw.clock.running,
        clockMs: raw.clock.clockMs || 0,
        startedAt: typeof raw.clock.startedAt === 'number' ? raw.clock.startedAt : null
      };
    }
    var events = raw.events || {};
    Object.keys(events).forEach(function (id) {
      var e = events[id];
      if (!e || (e.team !== 'A' && e.team !== 'B')) return;
      s.events.push({ id: id, team: e.team, result: e.result === 'ok' ? 'ok' : 'ko', ms: e.ms || 0, at: e.at || '' });
    });
    var phases = raw.phases || {};
    Object.keys(phases).forEach(function (id) {
      var p = phases[id];
      if (!p || (p.side !== 'A' && p.side !== 'B')) return;
      s.phases.push({ id: id, side: p.side, startMs: p.startMs || 0, endMs: typeof p.endMs === 'number' ? p.endMs : null });
    });
    s.events.sort(byTime('ms'));
    s.phases.sort(byTime('startMs'));
    return s;
  }

  // Shared API on top of a backend that writes paths like "events/<id>".
  function makeStore(backend) {
    var listeners = [];
    var statusListeners = [];
    var store = {
      mode: backend.mode,
      state: emptyState(),
      status: backend.mode === 'local' ? 'local' : 'connecting',
      now: backend.now,
      onChange: function (fn) { listeners.push(fn); },
      onStatus: function (fn) { statusListeners.push(fn); },
      addEvent: function (e) { var id = backend.newId('events'); backend.set('events/' + id, e); return id; },
      removeEvent: function (id) { backend.remove('events/' + id); },
      addPhase: function (p) { var id = backend.newId('phases'); backend.set('phases/' + id, p); return id; },
      updatePhase: function (id, fields) { backend.update('phases/' + id, fields); },
      removePhase: function (id) { backend.remove('phases/' + id); },
      setName: function (k, v) { backend.set('names/' + k, v); },
      setClock: function (c) { backend.set('clock', c); },
      newId: function (col) { return backend.newId(col); },
      // Many changes in one write, keys are paths like "events/<id>" (null deletes).
      bulk: function (fields) { backend.update('', fields); },
      reset: function () { backend.update('', { events: null, phases: null, clock: null }); }
    };
    backend.onData(function (raw) {
      store.state = normalize(raw);
      listeners.forEach(function (fn) { fn(store.state); });
    });
    backend.onStatus(function (st) {
      store.status = st;
      statusListeners.forEach(function (fn) { fn(st); });
    });
    return store;
  }

  // ---- This device only ----

  function setPath(root, path, value) {
    var parts = path ? path.split('/') : [];
    var obj = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    var last = parts[parts.length - 1];
    if (value === null || value === undefined) delete obj[last];
    else obj[last] = value;
  }

  // Data saved by the first version of the app (arrays instead of id maps).
  function migrate(old) {
    var raw = {
      names: old.names,
      clock: { running: !!old.running, clockMs: old.clockMs || 0, startedAt: old.startedAt || null },
      events: {},
      phases: {}
    };
    old.events.forEach(function (e) { raw.events[uid()] = { team: e.team, result: e.result, ms: e.ms, at: e.at }; });
    (old.phases || []).forEach(function (p) {
      raw.phases[uid()] = { side: p.side, startMs: p.startMs, endMs: p.endMs };
    });
    return raw;
  }

  function localStore(key) {
    var raw;
    var dataCb = function () {};

    function load() {
      try { raw = JSON.parse(localStorage.getItem(key)); } catch (e) { raw = null; }
      if (raw && Array.isArray(raw.events)) raw = migrate(raw);
      if (!raw || typeof raw !== 'object') raw = {};
    }
    function commit() {
      try { localStorage.setItem(key, JSON.stringify(raw)); } catch (e) { /* ignore */ }
      dataCb(raw);
    }

    load();
    // Keep several tabs on the same device in step.
    window.addEventListener('storage', function (ev) {
      if (ev.key === key) { load(); dataCb(raw); }
    });

    var store = makeStore({
      mode: 'local',
      now: function () { return Date.now(); },
      newId: uid,
      set: function (path, v) { setPath(raw, path, v); commit(); },
      update: function (path, fields) {
        Object.keys(fields).forEach(function (k) { setPath(raw, path ? path + '/' + k : k, fields[k]); });
        commit();
      },
      remove: function (path) { setPath(raw, path, null); commit(); },
      onData: function (cb) { dataCb = cb; cb(raw); },
      onStatus: function () {}
    });
    return Promise.resolve(store);
  }

  // ---- Live sync via Firebase ----

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function firebaseStore(config, matchCode) {
    var ready = window.firebase && window.firebase.database ? Promise.resolve() :
      loadScript(FIREBASE_SDK + 'firebase-app-compat.js').then(function () {
        return loadScript(FIREBASE_SDK + 'firebase-database-compat.js');
      });

    return ready.then(function () {
      var fb = window.firebase;
      if (!fb.apps.length) fb.initializeApp(config);
      var db = fb.database();
      var ref = db.ref('matches/' + matchCode);
      var offset = 0;
      var statusCb = function () {};

      db.ref('.info/serverTimeOffset').on('value', function (s) { offset = s.val() || 0; });

      function failed(err) { if (err) statusCb('error: ' + err.message); }
      function child(path) { return path ? ref.child(path) : ref; }

      return makeStore({
        mode: 'firebase',
        now: function () { return Date.now() + offset; },
        newId: function (col) { return ref.child(col).push().key; },
        set: function (path, v) { child(path).set(v, failed); },
        update: function (path, fields) { child(path).update(fields, failed); },
        remove: function (path) { child(path).remove(failed); },
        onData: function (cb) {
          ref.on('value', function (s) { cb(s.val()); }, failed);
        },
        onStatus: function (cb) {
          statusCb = cb;
          db.ref('.info/connected').on('value', function (s) { cb(s.val() ? 'online' : 'offline'); });
        }
      });
    });
  }

  window.PressingStore = { local: localStore, firebase: firebaseStore };
})();
