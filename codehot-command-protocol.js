/* CodeHot Command Protocol V14
 * Two pillars for the CodeHot AI Agent, built only on APIs that really exist:
 *   1. Command Protocol   — AI/Chat -> Command -> Parser -> Validator -> Executor -> CodeHot Core
 *   2. Query Layer        — AI/Chat -> Query -> Real CodeHot State (source of truth)
 *
 * Rules honored:
 *   - No invented state. Every executor calls a real API verified in index.html
 *     (CodeHotTools, CodeHotScene, _sceneEditorManager, ThemeManager, ProjectState...).
 *   - Identity is object.id. Display names are resolved through the entity resolver, never used as identity.
 *   - Chat is just one producer of commands: any source can call
 *     CodeHotCommandProtocol.dispatch(...) or runScript("@@...@@END").
 *   - A command is registered only when it has a real executor (no imaginary SET_DIRECTION:
 *     direction in CodeHot is derived from language, there is no independent direction API).
 */
(function (global) {
  'use strict';
  if (!global) return;

  var VERSION = '14.0.0';
  var HISTORY_KEY = 'codehot-command-protocol-history';
  var HISTORY_LIMIT = 100;

  /* ── Small utils ─────────────────────────────────────────────── */
  function copy(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; } }
  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function requestId() { return 'cmd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function normalizeFa(s) {
    return String(s == null ? '' : s)
      .replace(/[\u200c\u200d\u200e\u200f]/g, ' ')
      .replace(/\u064a/g, '\u06cc').replace(/\u0643/g, '\u06a9')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /* ── Read-only access to the real stores ─────────────────────── */
  function sceneData() {
    try {
      if (global.CodeHotScene && typeof global.CodeHotScene.getSceneData === 'function') {
        var d = global.CodeHotScene.getSceneData();
        if (d && Array.isArray(d.objects)) return { objects: d.objects, selectedId: d.selectedId || null };
      }
    } catch (e) {}
    try {
      if (global.SCENE_STATE && Array.isArray(global.SCENE_STATE.objects)) {
        return { objects: global.SCENE_STATE.objects, selectedId: global.SCENE_STATE.selectedId || null };
      }
    } catch (e) {}
    return { objects: [], selectedId: null };
  }
  function readScripts() {
    try {
      if (global.CodeHotScriptStore && typeof global.CodeHotScriptStore.getAll === 'function') {
        var all = global.CodeHotScriptStore.getAll(sceneData().objects);
        if (all && typeof all === 'object') return all;
      }
    } catch (e) {}
    try { return JSON.parse(global.localStorage.getItem('codehot-script-bindings') || '{}') || {}; } catch (e) { return {}; }
  }
  function readAssets() {
    try {
      if (global.CodeHotAssets && typeof global.CodeHotAssets.getAll === 'function') return copy(global.CodeHotAssets.getAll()) || [];
    } catch (e) {}
    try {
      var raw = global.localStorage.getItem('codehot-assets');
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.assets) ? parsed.assets : []);
    } catch (e) { return []; }
  }
  function readAnimations() {
    try {
      if (global.CodeHotAnimationStore && typeof global.CodeHotAnimationStore.getAll === 'function') return copy(global.CodeHotAnimationStore.getAll()) || [];
    } catch (e) {}
    return [];
  }
  function runtimeState() {
    try {
      if (global.CodeHotScene && typeof global.CodeHotScene.getRuntimeState === 'function') {
        var rs = global.CodeHotScene.getRuntimeState();
        if (rs) return { isPlaying: !!rs.isPlaying, isPaused: !!rs.isPaused, state: rs.state || (rs.isPlaying ? (rs.isPaused ? 'paused' : 'running') : 'editor') };
      }
    } catch (e) {}
    return { isPlaying: false, isPaused: false, state: 'editor' };
  }
  function cameraState() {
    try {
      if (global.CodeHotScene && typeof global.CodeHotScene.getCameraState === 'function') return copy(global.CodeHotScene.getCameraState());
    } catch (e) {}
    return null;
  }
  function manager() { return global._sceneEditorManager || null; }
  function readSettings() {
    try { return JSON.parse(global.localStorage.getItem('codehot-settings') || '{}') || {}; } catch (e) { return {}; }
  }
  function readConsoleLogs(limit) {
    try {
      var arr = JSON.parse(global.localStorage.getItem('codehot-console-logs') || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.slice(-(limit || 50)).map(function (e) {
        return { time: e.time || e.timestamp || null, level: e.level || e.type || 'log', text: String(e.message || e.text || e.args || '') };
      });
    } catch (e) { return []; }
  }

  /* ════════════════════════════════════════════════════════════
     1. QUERY LAYER — CodeHotQuerySystem (source of truth)
     ════════════════════════════════════════════════════════════ */
  function objectView(o) {
    var scripts = readScripts();
    return {
      id: o.id,
      name: o.name,
      type: o.type,
      parentId: o.parentId || null,
      position: copy(o.position) || { x: 0, y: 0, z: 0 },
      rotation: copy(o.rotation) || { x: 0, y: 0, z: 0 },
      scale: copy(o.scale) || { x: 1, y: 1, z: 1 },
      visible: o.visible !== false,
      assetId: o.assetId || null,
      hasScript: !!(scripts[o.id] && scripts[o.id].code),
      animations: readAnimations()
        .filter(function (a) { return (a.linkedObjectIds || []).indexOf(o.id) !== -1 || a.sourceObjectId === o.id; })
        .map(function (a) { return { id: a.id, name: a.name, clipName: a.clipName || null, duration: a.duration || 0, loop: a.loop !== false }; })
    };
  }
  function queryScene() {
    var scene = sceneData();
    return { id: 'codehot-scene', name: 'Main Scene', selectedId: scene.selectedId, objectCount: scene.objects.length, objects: scene.objects.map(objectView) };
  }

  var QuerySystem = {
    version: 'codehot-query-v14',
    run(name, arg) {
      var fn = this.queries[String(name || '').toUpperCase()];
      if (!fn) return { ok: false, error: 'unknown_query', query: name, available: Object.keys(this.queries) };
      try {
        return { ok: true, query: name, data: fn.call(this, arg) };
      } catch (e) {
        return { ok: false, query: name, error: 'query_failed', message: String(e && e.message || e) };
      }
    },
    queries: {
      QUERY_PROJECT: function () {
        var ps = global.CodeHotProjectState;
        var data = null;
        try { data = ps && ps._data ? copy(ps._data) : null; } catch (e) {}
        return {
          name: 'CodeHot Project', protocolVersion: VERSION,
          scenes: data && Array.isArray(data.scenes) ? data.scenes.map(function (s) { return { id: s.id, name: s.name, objects: (s.objects || []).length }; }) : [{ id: 'default', name: 'Scene 1', objects: sceneData().objects.length }],
          activeSceneId: data ? data.activeSceneId : 'default',
          totals: {
            objects: sceneData().objects.length, assets: readAssets().length,
            animations: readAnimations().length, scripts: Object.keys(readScripts()).length
          },
          savedAt: data ? data.timestamp : null
        };
      },
      QUERY_SCENE: function () { return queryScene(); },
      QUERY_OBJECTS: function () {
        return { count: sceneData().objects.length, objects: sceneData().objects.map(function (o) { var v = objectView(o); return { id: v.id, name: v.name, type: v.type, position: v.position, visible: v.visible, hasScript: v.hasScript }; }) };
      },
      QUERY_OBJECT: function (spec) {
        var res = Resolver.resolve(spec, queryScene());
        if (!res.ok) return { error: res.reason, matches: res.matches || null, lookedFor: res.lookedFor || null };
        var full = sceneData().objects.find(function (o) { return o.id === res.object.id; });
        var s = readScripts()[res.object.id];
        return { object: objectView(full || res.object), script: s ? copy(s) : null };
      },
      QUERY_SELECTION: function () {
        var scene = sceneData();
        if (!scene.selectedId) return { selected: null };
        var o = scene.objects.find(function (x) { return x.id === scene.selectedId; });
        return { selectedId: scene.selectedId, selected: o ? objectView(o) : null };
      },
      QUERY_ASSETS: function () {
        return { count: readAssets().length, assets: readAssets().map(function (a) { return { id: a.id, name: a.name, type: a.type, size: a.size || 0, payloadKey: a.payloadKey || null, linkedObjectIds: (a.linkedObjectIds || []).slice() }; }) };
      },
      QUERY_ANIMATIONS: function () {
        return { count: readAnimations().length, animations: readAnimations().map(function (a) { return { id: a.id, name: a.name, sourceObjectId: a.sourceObjectId || null, linkedObjectIds: (a.linkedObjectIds || []).slice(), clipName: a.clipName || null, duration: a.duration || 0, loop: a.loop !== false }; }) };
      },
      QUERY_SCRIPTS: function () {
        var map = readScripts();
        return { count: Object.keys(map).length, scripts: Object.keys(map).map(function (id) {
          var s = map[id] || {};
          var obj = sceneData().objects.find(function (o) { return o.id === id; });
          return { objectId: id, objectName: obj ? obj.name : (s.objectName || null), codeLength: String(s.code || '').length, code: s.code || '' };
        }) };
      },
      QUERY_CAMERA: function () {
        var c = cameraState();
        return { camera: c || null, locked: !!(c && c.locked) };
      },
      QUERY_RUNTIME: function () {
        var rs = runtimeState();
        var rt = global.CodeHotRuntime;
        return { isPlaying: rs.isPlaying, isPaused: rs.isPaused, state: rs.state, canEdit: !rs.isPlaying, time: rt ? (function () { try { return rt.getTime(); } catch (e) { return 0; } })() : 0 };
      },
      QUERY_THEME: function () {
        var tm = global.CodeHotThemeManager;
        return { theme: (tm && typeof tm.getCurrent === 'function') ? tm.getCurrent() : (readSettings().theme || 'dark') };
      },
      QUERY_LANGUAGE: function () { return { language: readSettings().language === 'en' ? 'en' : 'fa' }; },
      QUERY_SETTINGS: function () {
        var s = readSettings();
        return { settings: s, theme: (global.CodeHotThemeManager && global.CodeHotThemeManager.getCurrent) ? global.CodeHotThemeManager.getCurrent() : (s.theme || 'dark'), direction: document.documentElement.dir || 'ltr' };
      },
      QUERY_UI: function () {
        var active = null;
        try { var el = document.querySelector('.tab-panel.tp-active'); active = el ? el.dataset.tab : null; } catch (e) {}
        return { activeTab: active, theme: (global.CodeHotThemeManager && global.CodeHotThemeManager.getCurrent) ? global.CodeHotThemeManager.getCurrent() : null, direction: document.documentElement.dir || 'ltr' };
      },
      QUERY_LOGS: function (arg) {
        var h = history();
        var limit = Math.max(1, Math.min(50, num(arg && arg.limit) || 10));
        var logs = readConsoleLogs(50);
        return {
          protocol: h.slice(-limit),
          console: logs,
          errors: logs.filter(function (e) { return e.level === 'error' || e.level === 'pageerror'; }).slice(-5)
        };
      },
      QUERY_UNDO: function () {
        var m = manager();
        var s = global.SCENE_STATE || {};
        return {
          canUndo: !!m && typeof m.undo === 'function' && (!s.undoStack || s.undoStack.length > 0),
          canRedo: !!m && typeof m.redo === 'function' && (!s.redoStack || s.redoStack.length > 0)
        };
      },
      QUERY_CAPABILITIES: function () { return Protocol.capabilities(); }
    }
  };

  /* ════════════════════════════════════════════════════════════
     2. ENTITY RESOLVER — id / name / selection / type / last
     Never invents entities. Returns the real object record.
     ════════════════════════════════════════════════════════════ */
  var Resolver = {
    resolve(spec, scene) {
      scene = scene || queryScene();
      var objects = scene.objects || [];
      if (!spec) return { ok: false, reason: 'no-target' };
      if (typeof spec === 'string') spec = { name: spec };

      if (spec.id) {
        var byId = objects.find(function (o) { return o.id === spec.id; });
        return byId ? { ok: true, object: byId } : { ok: false, reason: 'not-found', lookedFor: spec.id };
      }
      if (spec.selection === true) {
        if (scene.selectedId) {
          var sel = objects.find(function (o) { return o.id === scene.selectedId; });
          if (sel) return { ok: true, object: sel };
        }
        return { ok: false, reason: 'no-selection' };
      }
      if (spec.last === true) {
        try {
          var last = (global.AIContext && global.AIContext._lastTargets && global.AIContext._lastTargets.length) ? global.AIContext._lastTargets[global.AIContext._lastTargets.length - 1] : null;
          if (last) {
            var found = objects.find(function (o) { return o.id === last.id; });
            if (found) return { ok: true, object: found };
          }
        } catch (e) {}
        return { ok: false, reason: 'no-previous-target' };
      }
      if (spec.type) {
        var TYPE_ALIASES = {
          cube: ['cube', 'box', 'مکعب', 'مربع'], sphere: ['sphere', 'کره', 'گوی'],
          cylinder: ['cylinder', 'استوانه'], cone: ['cone', 'مخروط'],
          plane: ['plane', 'صفحه', 'سطح'], model: ['model', 'glb', 'مدل', 'group', 'گروه']
        };
        var wanted = null, n = normalizeFa(spec.type);
        Object.keys(TYPE_ALIASES).forEach(function (k) { if (TYPE_ALIASES[k].some(function (a) { return a === n; })) wanted = k; });
        if (!wanted) return { ok: false, reason: 'unknown-type', lookedFor: spec.type };
        var byType = objects.filter(function (o) { return o.type === wanted || (wanted === 'model' && o.type === 'group'); });
        if (byType.length === 1) return { ok: true, object: byType[0] };
        if (byType.length > 1) return { ok: false, reason: 'ambiguous', matches: byType.map(function (o) { return { id: o.id, name: o.name }; }) };
        return { ok: false, reason: 'not-found', lookedFor: spec.type };
      }
      if (spec.name) {
        var needle = normalizeFa(spec.name);
        var exact = objects.filter(function (o) { return normalizeFa(o.name) === needle; });
        if (exact.length === 1) return { ok: true, object: exact[0] };
        if (exact.length > 1) return { ok: false, reason: 'ambiguous', matches: exact.map(function (o) { return { id: o.id, name: o.name }; }) };
        var contains = objects.filter(function (o) { return normalizeFa(o.name).indexOf(needle) !== -1; });
        if (contains.length === 1) return { ok: true, object: contains[0] };
        if (contains.length > 1) return { ok: false, reason: 'ambiguous', matches: contains.map(function (o) { return { id: o.id, name: o.name }; }) };
        return { ok: false, reason: 'not-found', lookedFor: spec.name };
      }
      return { ok: false, reason: 'no-target' };
    }
  };

  /* ════════════════════════════════════════════════════════════
     3. COMMAND REGISTRY — one entry per real executor
     ════════════════════════════════════════════════════════════ */
  function fail(msg) { return { ok: false, message: msg }; }
  function toolsReady() { return !!(global.CodeHotTools && typeof global.CodeHotTools.CREATE_OBJECT === 'function'); }
  function playingGuard() { return runtimeState().isPlaying ? fail('Cannot edit while playing. Stop first. / در زمان Play امکان ویرایش نیست.') : null; }

  function requireTarget(params) {
    var res = Resolver.resolve(params.__target, queryScene());
    if (!res.ok) {
      if (res.reason === 'ambiguous') return { error: fail('Multiple matches: ' + res.matches.map(function (m) { return m.name; }).join(', ')) };
      if (res.reason === 'no-selection') return { error: fail('Nothing is selected and no target was given. / چیزی انتخاب نشده و هدفی مشخص نشده است.') };
      if (res.reason === 'no-previous-target') return { error: fail('No previous target. / هدف قبلی وجود ندارد.') };
      return { error: fail('Target not found: ' + JSON.stringify(res.lookedFor != null ? res.lookedFor : (params.__target || ''))) };
    }
    return { id: res.object.id, object: res.object, res: res };
  }

  var Registry = {
    commands: {},
    register(def) { this.commands[def.name] = def; return this; },
    get(name) { return this.commands[String(name || '').toUpperCase()] || null; },
    names() { return Object.keys(this.commands); }
  };

  // ── Scene object commands (executors = CodeHotTools / SceneEditorManager) ──
  Registry.register({
    name: 'CREATE_OBJECT', undoable: true,
    params: { TYPE: { type: 'string', enum: ['cube', 'sphere', 'cylinder', 'cone', 'plane'] }, NAME: { type: 'string' }, X: { type: 'number' }, Y: { type: 'number' }, Z: { type: 'number' } },
    executor(params) {
      var g = playingGuard(); if (g) return g;
      if (!toolsReady()) return fail('CodeHotTools unavailable');
      var p = { type: params.TYPE || 'cube' };
      if (params.NAME) p.name = params.NAME;
      ['x', 'y', 'z'].forEach(function (k) { if (num(params[k.toUpperCase()]) !== null) p[k] = params[k.toUpperCase()]; });
      return global.CodeHotTools.CREATE_OBJECT(p);
    }
  });
  Registry.register({
    name: 'DELETE_OBJECT', undoable: true, target: 'object',
    params: {},
    executor(params) {
      var g = playingGuard(); if (g) return g;
      var t = requireTarget(params); if (t.error) return t.error;
      return global.CodeHotTools.DELETE_OBJECT({ id: t.id });
    }
  });
  Registry.register({
    name: 'RENAME_OBJECT', undoable: true, target: 'object',
    params: { NEW_NAME: { type: 'string', required: true } },
    executor(params) {
      var g = playingGuard(); if (g) return g;
      var t = requireTarget(params); if (t.error) return t.error;
      return global.CodeHotTools.RENAME_OBJECT({ id: t.id, newName: params.NEW_NAME });
    }
  });
  function transformExecutor(kind) {
    return function (params) {
      var g = playingGuard(); if (g) return g;
      var t = requireTarget(params); if (t.error) return t.error;
      var change = {};
      if (kind === 'move') {
        var pos = {};
        ['x', 'y', 'z'].forEach(function (k) {
          var v = num(params[k.toUpperCase()]);
          if (v !== null) pos[k] = (params.DELTA === true) ? t.object.position[k] + v : v;
        });
        if (Object.keys(pos).length) change.position = pos;
      } else if (kind === 'rotate') {
        var rot = {};
        ['x', 'y', 'z'].forEach(function (k) {
          var v = num(params[k.toUpperCase()]);
          if (v !== null) {
            // Degrees, editor convention: SCENE_STATE.rotation is stored in
            // degrees and converted to radians only when meshes are built
            // (see degToRad at mesh construction). Keep the boundary honest.
            rot[k] = (params.DELTA === true) ? t.object.rotation[k] + v : v;
          }
        });
        if (Object.keys(rot).length) change.rotation = rot;
      } else { // scale — absolute
        var scl = {};
        ['x', 'y', 'z'].forEach(function (k) { var v = num(params[k.toUpperCase()]); if (v !== null) scl[k] = v; });
        if (num(params.UNIFORM) !== null) scl = { x: params.UNIFORM, y: params.UNIFORM, z: params.UNIFORM };
        if (Object.keys(scl).length) change.scale = scl;
      }
      if (!Object.keys(change).length) return fail('No axis values given. / هیچ محوری مشخص نشده.');
      return global.CodeHotTools.SET_TRANSFORM({ id: t.id, change: change });
    };
  }
  Registry.register({ name: 'MOVE_OBJECT', undoable: true, target: 'object', params: { X: { type: 'number' }, Y: { type: 'number' }, Z: { type: 'number' }, DELTA: { type: 'boolean' } }, executor: transformExecutor('move') });

  // Read-only QUERY commands. The system prompt advertises @@QUERY_SCENE and
  // @@QUERY_SCRIPTS to the model; these registry entries make that contract
  // real (previously @@QUERY_* blocks failed with unknown_command). Queries
  // never mutate the scene and are excluded from undo/history mutation flags.
  function queryExecutor(qname) {
    return function () {
      var res = global.CodeHotQuerySystem ? global.CodeHotQuerySystem.run(qname) : { ok: false, error: 'query_system_unavailable' };
      if (!res || !res.ok) return { ok: false, message: 'Query failed: ' + ((res && (res.error || res.message)) || 'unknown') };
      return { ok: true, query: qname, data: res.data };
    };
  }
  Registry.register({ name: 'QUERY_SCENE', query: true, params: {}, executor: queryExecutor('QUERY_SCENE') });
  Registry.register({ name: 'QUERY_SCRIPTS', query: true, params: {}, executor: queryExecutor('QUERY_SCRIPTS') });
  Registry.register({ name: 'QUERY_OBJECTS', query: true, params: {}, executor: queryExecutor('QUERY_OBJECTS') });

  Registry.register({ name: 'ROTATE_OBJECT', undoable: true, target: 'object', params: { X: { type: 'number' }, Y: { type: 'number' }, Z: { type: 'number' }, DELTA: { type: 'boolean' } }, executor: transformExecutor('rotate') });
  Registry.register({ name: 'SCALE_OBJECT', undoable: true, target: 'object', params: { X: { type: 'number' }, Y: { type: 'number' }, Z: { type: 'number' }, UNIFORM: { type: 'number' } }, executor: transformExecutor('scale') });
  Registry.register({
    name: 'SELECT_OBJECT', undoable: false, target: 'object', params: {},
    executor(params) {
      var t = requireTarget(params); if (t.error) return t.error;
      var res = global.CodeHotTools.SELECT_OBJECT({ id: t.id });
      if (res.ok) return res;
      try { if (global.CodeHotScene.selectObject(t.id)) return { ok: true, message: t.object.name + ' selected. / انتخاب شد.' }; } catch (e) {}
      return res;
    }
  });
  Registry.register({
    name: 'FOCUS_OBJECT', undoable: false, target: 'object', params: {},
    executor(params) {
      var t = requireTarget(params); if (t.error) return t.error;
      var sel = global.CodeHotTools.SELECT_OBJECT({ id: t.id });
      try {
        var m = manager();
        if (m && typeof m.focusObject === 'function') { m.focusObject(t.id); return { ok: true, message: 'Focused on ' + t.object.name + ' / روی ' + t.object.name + ' فوکوس شد.' }; }
      } catch (e) {}
      return sel.ok ? sel : fail('Focus unavailable / فوکوس ممکن نیست.');
    }
  });

  // ── Camera commands (real API: CodeHotTools.SET_CAMERA -> manager.applyCameraData) ──
  function cameraExecutor(mode) {
    return function (params) {
      if (!global.CodeHotTools || typeof global.CodeHotTools.SET_CAMERA !== 'function') return fail('Camera API unavailable');
      var p = {};
      if (mode === 'position' || mode === 'all') { ['x', 'y', 'z'].forEach(function (k) { var v = num(params[k.toUpperCase()]); if (v !== null) p[k] = v; }); }
      if (mode === 'target' || mode === 'all') { ['tx', 'ty', 'tz'].forEach(function (k) { var v = num(params[k.toUpperCase()]); if (v !== null) p[k] = v; }); }
      if (mode === 'fov') { var f = num(params.FOV); if (f === null) return fail('FOV value required'); p.fov = clamp(f, 15, 120); }
      else if (mode === 'all') { var fov = num(params.FOV); if (fov !== null) p.fov = clamp(fov, 15, 120); }
      if (!Object.keys(p).length) return fail('No camera values given');
      return global.CodeHotTools.SET_CAMERA(p);
    };
  }
  Registry.register({ name: 'SET_CAMERA_POSITION', undoable: false, params: { X: { type: 'number' }, Y: { type: 'number' }, Z: { type: 'number' } }, executor: cameraExecutor('position') });
  Registry.register({ name: 'SET_CAMERA_TARGET', undoable: false, params: { TX: { type: 'number' }, TY: { type: 'number' }, TZ: { type: 'number' } }, executor: cameraExecutor('target') });
  Registry.register({ name: 'SET_CAMERA_FOV', undoable: false, params: { FOV: { type: 'number', required: true, min: 15, max: 120 } }, executor: cameraExecutor('fov') });
  Registry.register({ name: 'SET_CAMERA', undoable: false, params: { X: { type: 'number' }, Y: { type: 'number' }, Z: { type: 'number' }, TX: { type: 'number' }, TY: { type: 'number' }, TZ: { type: 'number' }, FOV: { type: 'number', min: 15, max: 120 } }, executor: cameraExecutor('all') });

  // ── App commands ──
  Registry.register({
    name: 'SET_THEME', undoable: false,
    params: { VALUE: { type: 'string', required: true, enum: ['dark', 'light'] } },
    executor(params) {
      var tm = global.CodeHotThemeManager;
      if (!tm || typeof tm.apply !== 'function') return fail('ThemeManager unavailable');
      tm.apply(params.VALUE); // real API: applies CSS vars, persists, emits theme:changed
      try {
        var s = readSettings(); s.theme = params.VALUE;
        global.localStorage.setItem('codehot-settings', JSON.stringify(s));
        if (global.CodeHotProjectState && global.CodeHotProjectState._data && global.CodeHotProjectState._data.settings) global.CodeHotProjectState._data.settings.theme = params.VALUE;
      } catch (e) {}
      try { document.body.dataset.theme = params.VALUE; } catch (e) {}
      return { ok: true, message: 'Theme set to ' + params.VALUE + ' / تم روی ' + params.VALUE + ' تنظیم شد.' };
    }
  });
  Registry.register({
    name: 'SET_LANGUAGE', undoable: false,
    params: { VALUE: { type: 'string', required: true, enum: ['fa', 'en'] } },
    executor(params) {
      // Real application path: settings store + dir/lang (same as SettingsUIManager.applyLanguage).
      try {
        var s = readSettings(); s.language = params.VALUE;
        global.localStorage.setItem('codehot-settings', JSON.stringify(s));
        if (global.CodeHotProjectState && global.CodeHotProjectState._data && global.CodeHotProjectState._data.settings) global.CodeHotProjectState._data.settings.language = params.VALUE;
        document.documentElement.dir = params.VALUE === 'fa' ? 'rtl' : 'ltr';
        document.documentElement.lang = params.VALUE;
      } catch (e) { return fail('Could not apply language: ' + (e.message || e)); }
      try {
        if (global.CodeHotEventBus && global.CodeHotEventBus.emit) {
          global.CodeHotEventBus.emit('settings:changed', { key: 'language', value: params.VALUE });
          global.CodeHotEventBus.emit('ui:refresh');
        }
      } catch (e) {}
      return { ok: true, message: 'Language set to ' + params.VALUE + ' / زبان روی ' + params.VALUE + ' تنظیم شد.' };
    }
  });
  Registry.register({
    name: 'SET_DIRECTION', undoable: false,
    params: { VALUE: { type: 'string', required: true, enum: ['rtl', 'ltr'] } },
    executor(params) {
      // V12: direction is an independent preference (never a side effect of language).
      try {
        var s = readSettings(); s.direction = params.VALUE;
        global.localStorage.setItem('codehot-settings', JSON.stringify(s));
        document.documentElement.dir = params.VALUE;
      } catch (e) { return fail('Could not set direction: ' + (e.message || e)); }
      try {
        if (global.CodeHotEventBus && global.CodeHotEventBus.emit) {
          global.CodeHotEventBus.emit('settings:changed', { key: 'direction', value: params.VALUE });
          global.CodeHotEventBus.emit('ui:refresh');
        }
      } catch (e) {}
      return { ok: true, message: 'Direction set to ' + params.VALUE + ' / جهت صفحه روی ' + params.VALUE + ' تنظیم شد.' };
    }
  });
  Registry.register({
    name: 'SAVE_PROJECT', undoable: false, params: {},
    executor() {
      var saved = { scene: false, project: false };
      try { if (global.CodeHotScene && typeof global.CodeHotScene.saveToStorage === 'function') { global.CodeHotScene.saveToStorage(); saved.scene = true; } } catch (e) {}
      try {
        var ps = global.CodeHotProjectState;
        if (ps && ps._data) {
          var scene = sceneData();
          if (ps._data.scenes && ps._data.scenes[0]) {
            ps._data.scenes[0].objects = scene.objects;
            ps._data.scenes[0].camera = cameraState();
          }
          try { var raw = global.localStorage.getItem('codehot-script-bindings'); if (raw) ps._data.scripts = JSON.parse(raw); } catch (e) {}
          try { var raw2 = global.localStorage.getItem('codehot-animation-state'); if (raw2) ps._data.animations = JSON.parse(raw2); } catch (e) {}
          ps.save();
          saved.project = true;
        }
      } catch (e) {}
      return saved.scene || saved.project
        ? { ok: true, message: 'Project saved / پروژه ذخیره شد.' + (!saved.project || !saved.scene ? ' (' + (saved.project ? 'project state' : 'scene') + ')' : '') }
        : fail('Nothing to save / چیزی برای ذخیره نبود.');
    }
  });
  Registry.register({
    name: 'UNDO', undoable: false, params: {},
    executor() {
      var m = manager();
      if (m && typeof m.undo === 'function') {
        if (global.SCENE_STATE && Array.isArray(global.SCENE_STATE.undoStack) && global.SCENE_STATE.undoStack.length === 0) return fail('Nothing to undo / چیزی برای برگرداندن نیست.');
        try { m.undo(); return { ok: true, message: 'Undone / برگشت.' }; } catch (e) { return fail('Undo failed: ' + (e.message || e)); }
      }
      if (global.CodeHotCommandManager && typeof global.CodeHotCommandManager.undo === 'function') {
        return global.CodeHotCommandManager.undo() ? { ok: true, message: 'Undone / برگشت.' } : fail('Nothing to undo / چیزی برای برگرداندن نیست.');
      }
      return fail('Undo unavailable');
    }
  });
  Registry.register({
    name: 'REDO', undoable: false, params: {},
    executor() {
      var m = manager();
      if (m && typeof m.redo === 'function') {
        if (global.SCENE_STATE && Array.isArray(global.SCENE_STATE.redoStack) && global.SCENE_STATE.redoStack.length === 0) return fail('Nothing to redo / چیزی برای اجرای مجدد نیست.');
        try { m.redo(); return { ok: true, message: 'Redone / اجرای مجدد شد.' }; } catch (e) { return fail('Redo failed: ' + (e.message || e)); }
      }
      return fail('Redo unavailable');
    }
  });

  // ── Runtime lifecycle commands (real API: CodeHotRuntime.start/stop) ──
  // V12: PAUSE/RESUME are REAL runtime states (RuntimeEngine.pause/resume,
  // state machine RUNNING<->PAUSED). The animation player is only a fallback
  // for builds without runtime pause, and PAUSE/RESUME honestly fail when
  // nothing is playing.
  Registry.register({
    name: 'PLAY', undoable: false, params: {},
    executor() {
      var rt = global.CodeHotRuntime;
      if (!rt || typeof rt.start !== 'function') return fail('Runtime unavailable');
      if (runtimeState().isPlaying) return { ok: true, message: 'Already playing / در حال اجراست.' };
      // Resume-first semantics: Play on a paused runtime continues it.
      if (typeof rt.isPaused === 'function' && rt.isPaused()) {
        var resumedEarly = false;
        try { resumedEarly = rt.resume() === true; } catch (e) {}
        if (resumedEarly) return { ok: true, message: 'Resumed / ادامه پخش.' };
      }
      var started = false;
      try { started = rt.start() === true; } catch (e) { return fail('Play failed: ' + (e.message || e)); }
      return started ? { ok: true, message: 'Play / اجرا شروع شد.' } : fail('Play failed: runtime refused to start.');
    }
  });
  Registry.register({
    name: 'STOP', undoable: false, params: {},
    executor() {
      var rt = global.CodeHotRuntime;
      if (!rt || typeof rt.stop !== 'function') return fail('Runtime unavailable');
      if (!runtimeState().isPlaying) return { ok: true, message: 'Not playing / در حال اجرا نیست.' };
      try { rt.stop(); } catch (e) { return fail('Stop failed: ' + (e.message || e)); }
      var after = runtimeState();
      return after.isPlaying ? fail('Stop did not take effect / توقف اعمال نشد.') : { ok: true, message: 'Stopped / متوقف شد.' }; 
    }
  });
  Registry.register({
    name: 'PAUSE', undoable: false, params: {},
    executor() {
      var rt = global.CodeHotRuntime;
      // Preferred: real runtime pause (freezes simulation time).
      if (rt && typeof rt.pause === 'function') {
        if (!runtimeState().isPlaying) return fail('Not playing / در حال اجرا نیست.');
        if (typeof rt.isPaused === 'function' && rt.isPaused()) return { ok: true, message: 'Already paused / قبلاً متوقف شده است.' };
        var okRt = false;
        try { okRt = rt.pause() === true; } catch (e) { return fail('Pause failed: ' + (e.message || e)); }
        return okRt ? { ok: true, message: 'Paused / متوقف موقت.' } : fail('Pause did not take effect.');
      }
      // Fallback: animation player pause in builds without runtime pause.
      var am = global.CodeHotAnimationBridge || null;
      var pauseFn = (am && typeof am.pause === 'function') ? am.pause : null;
      if (!pauseFn) return fail('Pause is unavailable in this build / توقف موقت در این نسخه پشتیبانی نمی‌شود.');
      var ok = false;
      try { ok = pauseFn() === true; } catch (e) { return fail('Pause failed: ' + (e.message || e)); }
      return ok ? { ok: true, message: 'Paused / متوقف موقت.' } : fail('Nothing to pause / چیزی برای توقف موقت نیست.');
    }
  });
  Registry.register({
    name: 'RESUME', undoable: false, params: {},
    executor() {
      var rt = global.CodeHotRuntime;
      // Preferred: real runtime resume.
      if (rt && typeof rt.resume === 'function') {
        if (!runtimeState().isPlaying) return fail('Not playing / در حال اجرا نیست.');
        if (typeof rt.isPaused === 'function' && !rt.isPaused()) return { ok: true, message: 'Not paused / متوقف نشده بود.' };
        var okRt = false;
        try { okRt = rt.resume() === true; } catch (e) { return fail('Resume failed: ' + (e.message || e)); }
        return okRt ? { ok: true, message: 'Resumed / ادامه پخش.' } : fail('Resume did not take effect.');
      }
      // Fallback: animation player resume.
      var am = global.CodeHotAnimationBridge || null;
      var resumeFn = (am && typeof am.resume === 'function') ? am.resume : null;
      if (!resumeFn) return fail('Resume is unavailable in this build / ادامه پخش در این نسخه پشتیبانی نمی‌شود.');
      var ok = false;
      try { ok = resumeFn() === true; } catch (e) { return fail('Resume failed: ' + (e.message || e)); }
      return ok ? { ok: true, message: 'Resumed / ادامه پخش.' } : fail('Nothing to resume / چیزی برای ادامه نیست.');
    }
  });

  // ── Script commands (real API: CodeHotScriptStore + CodeHotRuntime.validateScript) ──
  // Model-emitted CODE values arrive with escaped newlines ("\n"). The real
  // script source must contain actual line breaks, so unescape the common
  // sequences before validation/storage.
  function unescapeScriptCode(code) {
    return String(code || '')
      .replace(/\\r\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  function storeScript(id, code, objectName) {
    // Contract: { objectId, objectName, code, updatedAt } — writer/reader agree.
    return global.CodeHotScriptStore.set(id, { objectId: id, objectName: objectName, code: code, updatedAt: Date.now() }, sceneData().objects);
  }
  function validateAndStore(id, code, objectName) {
    var rt = global.CodeHotRuntime;
    if (rt && typeof rt.validateScript === 'function') {
      var check = rt.validateScript(code);
      if (!check.ok) return fail('Script validation failed: ' + (check.error || 'syntax error'));
    }
    var saved = storeScript(id, code, objectName);
    if (!saved) return fail('Could not persist script binding.');
    // V12 fix: reload must be called as a METHOD. Capturing the bare function
    // reference (var refreshApi = rt.reload; refreshApi()) ran it with `this`
    // undefined, so the live behavior was never replaced while playing.
    try {
      if (runtimeState().isPlaying && global.CodeHotRuntime && typeof global.CodeHotRuntime.reload === 'function') {
        global.CodeHotRuntime.reload();
      }
    } catch (e) {}
    try { if (global.CodeHotEventBus && global.CodeHotEventBus.emit) global.CodeHotEventBus.emit('script:changed', { objectId: id, code: code }); } catch (e) {}
    return null;
  }
  Registry.register({
    name: 'CREATE_SCRIPT', undoable: true, target: 'object',
    params: { CODE: { type: 'string', required: true }, NAME: { type: 'string' } },
    executor(params) {
      // V12: script commands are allowed during Play — behavior code is hot-
      // swapped through validateAndStore/reload, unlike scene transforms which
      // stay guarded against edit-while-playing.
      var t = requireTarget(params); if (t.error) return t.error;
      var err = validateAndStore(t.id, unescapeScriptCode(params.CODE), t.object.name);
      if (err) return err;
      return { ok: true, message: 'Script attached to ' + t.object.name + ' / اسکریپت به ' + t.object.name + ' متصل شد.' };
    }
  });
  Registry.register({
    name: 'UPDATE_SCRIPT', undoable: true, target: 'object',
    params: { CODE: { type: 'string', required: true } },
    executor(params) {
      // V12: script commands are allowed during Play — behavior code is hot-
      // swapped through validateAndStore/reload, unlike scene transforms which
      // stay guarded against edit-while-playing.
      var t = requireTarget(params); if (t.error) return t.error;
      var err = validateAndStore(t.id, unescapeScriptCode(params.CODE), t.object.name);
      if (err) return err;
      return { ok: true, message: 'Script updated on ' + t.object.name + ' / اسکریپت ' + t.object.name + ' به‌روزرسانی شد.' };
    }
  });
  Registry.register({
    name: 'DELETE_SCRIPT', undoable: true, target: 'object',
    params: {},
    executor(params) {
      // V12: script commands are allowed during Play — behavior code is hot-
      // swapped through validateAndStore/reload, unlike scene transforms which
      // stay guarded against edit-while-playing.
      var t = requireTarget(params); if (t.error) return t.error;
      var had = !!(readScripts()[t.id] && readScripts()[t.id].code);
      if (!had) return fail('No script on ' + t.object.name + ' / اسکریپتی روی ' + t.object.name + ' نیست.');
      var removed = false;
      try { removed = global.CodeHotScriptStore.remove(t.id, sceneData().objects) !== false; } catch (e) {}
      try { if (global.CodeHotEventBus && global.CodeHotEventBus.emit) global.CodeHotEventBus.emit('script:changed', { objectId: t.id, code: '' }); } catch (e) {}
      // V12 fix: removing a script while playing must also stop its live
      // behavior — reload the runtime so the behavior map no longer has it.
      try {
        if (runtimeState().isPlaying && global.CodeHotRuntime && typeof global.CodeHotRuntime.reload === 'function') {
          global.CodeHotRuntime.reload();
        }
      } catch (e) {}
      return removed ? { ok: true, message: 'Script removed from ' + t.object.name + ' / اسکریپت از ' + t.object.name + ' حذف شد.' } : fail('Could not remove script binding.');
    }
  });

  // ── Animation commands (real clips only — resolver never invents clips) ──
  function clipsFor(objectId) {
    try {
      if (global.CodeHotAnimationStore && typeof global.CodeHotAnimationStore.getForObject === 'function') {
        return (global.CodeHotAnimationStore.getForObject(objectId) || []).map(function (a) { return String(a.name || a.clipName || ''); }).filter(Boolean);
      }
    } catch (e) {}
    return [];
  }
  Registry.register({
    name: 'PLAY_ANIMATION', undoable: false, target: 'object',
    params: { CLIP: { type: 'string', required: true } },
    executor(params) {
      var t = requireTarget(params); if (t.error) return t.error;
      var clips = clipsFor(t.id);
      if (!clips.length) return fail(t.object.name + ' has no animations / ' + t.object.name + ' هیچ انیمیشنی ندارد.');
      var wanted = normalizeFa(params.CLIP).toLowerCase();
      var match = clips.find(function (c) { return normalizeFa(c).toLowerCase() === wanted; })
        || clips.find(function (c) { return normalizeFa(c).toLowerCase().indexOf(wanted) !== -1; });
      if (!match) return fail('No clip named "' + params.CLIP + '". Available: ' + clips.join(', ') + ' / چنین کلیپی وجود ندارد.');
      if (!toolsReady()) return fail('CodeHotTools unavailable');
      return global.CodeHotTools.PLAY_ANIMATION({ id: t.id, animation: { name: match } });
    }
  });
  Registry.register({
    name: 'STOP_ANIMATION', undoable: false, target: 'object',
    params: {},
    executor(params) {
      var t = requireTarget(params); if (t.error) return t.error;
      if (!toolsReady()) return fail('CodeHotTools unavailable');
      return global.CodeHotTools.STOP_ANIMATION({ id: t.id });
    }
  });

  // ── Every query is also a command (pass-through to the Query System) ──
  Object.keys(QuerySystem.queries).forEach(function (q) {
    Registry.register({
      name: q, query: true, undoable: false,
      params: q === 'QUERY_OBJECT' ? { VALUE: { type: 'string' }, ID: { type: 'string' } } : (q === 'QUERY_LOGS' ? { LIMIT: { type: 'number' } } : {}),
      executor(params, envelope) {
        var arg = null;
        if (q === 'QUERY_OBJECT') {
          var v = params.VALUE || params.ID || (envelope.target && (envelope.target.name || envelope.target.id));
          arg = v ? { name: v } : (envelope.target || null);
        }
        if (q === 'QUERY_LOGS') arg = { limit: num(params.LIMIT) || 10 };
        var res = QuerySystem.run(q, arg);
        return res.ok ? { ok: true, message: q + ' ok', data: res.data, query: true } : { ok: false, message: String(res.error || 'query failed') + (res.message ? ': ' + res.message : ''), query: true };
      }
    });
  });

  /* ════════════════════════════════════════════════════════════
     4. PARSER — @@COMMAND\nKEY: VALUE\n@@END
     ════════════════════════════════════════════════════════════ */
  function parseValue(v) {
    var s = String(v).trim();
    if (/^"[^]*"$/.test(s) || /^'[^]*'$/.test(s)) return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '') return null;
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
    return s;
  }
  var Parser = {
    parse(text) {
      var raw = String(text || '').replace(/\r\n/g, '\n');
      var commands = [], errors = [];
      var re = /@@\s*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\n([\s\S]*?)(?:@@END|@@\s*[A-Za-z_][A-Za-z0-9_]*[ \t]*\n|$)/g;
      var m;
      while ((m = re.exec(raw)) !== null) {
        var name = m[1].toUpperCase();
        var body = m[2] || '';
        if (body.indexOf('@@END') !== -1) body = body.slice(0, body.indexOf('@@END'));
        if (!Registry.get(name)) {
          errors.push({ command: name, error: 'unknown_command', available: Registry.names() });
          continue;
        }
        var params = {}, malformed = [];
        body.split('\n').forEach(function (line) {
          if (!line.trim()) return;
          var pm = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/);
          if (!pm) { malformed.push(line.trim()); return; }
          params[pm[1].toUpperCase()] = parseValue(pm[2]);
        });
        commands.push({ command: name, params: params, malformed: malformed });
      }
      if (!commands.length && !errors.length && /@@/.test(raw)) {
        errors.push({ error: 'no_command_found', hint: 'Expected @@COMMAND ... @@END' });
      }
      return { ok: errors.length === 0, commands: commands, errors: errors };
    }
  };

  /* ════════════════════════════════════════════════════════════
     5. VALIDATOR
     ════════════════════════════════════════════════════════════ */
  function validateStrict(def, params) {
    var fatal = [], warnings = [];
    var schema = def.params || {};
    Object.keys(schema).forEach(function (key) {
      var rule = schema[key], val = params[key];
      if (val === undefined || val === null) {
        if (rule.required) fatal.push({ param: key, problem: 'required' });
        return;
      }
      if (rule.type === 'number') {
        var n = typeof val === 'number' ? val : parseFloat(val);
        if (!Number.isFinite(n)) { fatal.push({ param: key, problem: 'must be a number' }); return; }
        params[key] = n;
        if (rule.min !== undefined && n < rule.min) fatal.push({ param: key, problem: 'must be >= ' + rule.min });
        if (rule.max !== undefined && n > rule.max) fatal.push({ param: key, problem: 'must be <= ' + rule.max });
      } else if (rule.type === 'boolean') {
        params[key] = (val === true || val === 'true');
      } else if (rule.type === 'string') {
        params[key] = String(val);
        if (rule.enum && rule.enum.indexOf(params[key]) === -1) fatal.push({ param: key, problem: 'must be one of: ' + rule.enum.join(', ') });
      }
    });
    Object.keys(params).forEach(function (key) {
      if (schema[key] === undefined) { warnings.push({ param: key, problem: 'unknown parameter (ignored)' }); delete params[key]; }
    });
    return { ok: fatal.length === 0, fatal: fatal, warnings: warnings };
  }

  /* ════════════════════════════════════════════════════════════
     6. PROTOCOL — envelope, dispatch, history, capabilities, verify
     ════════════════════════════════════════════════════════════ */
  function history() {
    try { return JSON.parse(global.localStorage.getItem(HISTORY_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function saveHistory(entry) {
    try { global.localStorage.setItem(HISTORY_KEY, JSON.stringify(history().concat(entry).slice(-HISTORY_LIMIT))); } catch (e) {}
  }
  function emitRefresh() {
    try { if (global.CodeHotEventBus && global.CodeHotEventBus.emit) global.CodeHotEventBus.emit('ui:refresh'); } catch (e) {}
  }

  var Protocol = {
    version: VERSION,
    parser: Parser,
    registry: Registry,
    resolver: Resolver,

    capabilities() {
      return {
        protocolVersion: VERSION,
        commands: Registry.names().filter(function (n) { var d = Registry.get(n); return d && !d.query; }),
        queries: Object.keys(QuerySystem.queries),
        targetResolution: ['id', 'name', 'type', 'selection', 'last'],
        targetKeys: ['OBJECT', 'ID', 'TYPE', 'SELECTED', 'LAST'],
        identity: 'object.id',
        envelopeSchema: {
          command: 'string', version: 'string',
          target: '{ id? | name? | type? | selection? | last? }',
          parameters: 'object', source: 'string', timestamp: 'number', requestId: 'string'
        }
      };
    },

    parse(text) { return Parser.parse(text); },

    // One envelope -> result { ok, command, message, data?, requestId, verification? }
    executeEnvelope(envelope) {
      var started = Date.now();
      var out = { command: envelope.command, requestId: envelope.requestId || requestId(), ok: false, message: '' };
      var def = Registry.get(envelope.command);
      if (!def) { out.message = 'Unknown command / دستور ناشناخته'; out.error = 'unknown_command'; return out; }

      var params = copy(envelope.parameters) || {};

      // Target selectors (OBJECT/ID/TYPE/SELECTED/LAST/TARGET) fold into
      // envelope.target. TARGET is an accepted alias for OBJECT (models and
      // scripts frequently write TARGET:"Name"). NAME is a target alias ONLY
      // for commands that do not declare NAME as a real parameter
      // (CREATE_OBJECT uses NAME for the new object; CREATE_SCRIPT uses it for
      // the script name) — otherwise that parameter must survive.
      if (!envelope.target) {
        var t = null;
        if (params.ID !== undefined) t = { id: params.ID };
        else if (params.OBJECT !== undefined) t = { name: params.OBJECT };
        else if (params.TARGET !== undefined) t = { name: params.TARGET };
        else if (params.NAME !== undefined && !(def.params && def.params.NAME)) t = { name: params.NAME };
        else if (params.TYPE !== undefined && def.target === 'object') t = { type: params.TYPE };
        else if (params.SELECTED === true || params.SELECTED === 'true') t = { selection: true };
        else if (params.LAST === true || params.LAST === 'true') t = { last: true };
        if (t) envelope.target = t;
      }
      if (def.target === 'object') {
        var targetKeys = ['ID', 'OBJECT', 'TYPE', 'SELECTED', 'LAST', 'TARGET'];
        if (envelope.target && envelope.target.name && params.NAME === envelope.target.name && !(def.params && def.params.NAME)) targetKeys.push('NAME');
        targetKeys.forEach(function (k) { if (k in params) delete params[k]; });
        // Remember the resolved before-identity so verify() can assert absence/presence.
        var pre = Resolver.resolve(envelope.target, queryScene());
        if (pre.ok) envelope.__beforeTargetId = pre.object.id;
      }

      var v = validateStrict(def, params);
      if (!v.ok) { out.message = 'Invalid parameters: ' + v.fatal.map(function (p) { return p.param + ' ' + p.problem; }).join('; '); out.validation = v; return out; }
      if (v.warnings.length) out.warnings = v.warnings;

      params.__target = copy(envelope.target) || null;
      try {
        var res = def.executor(params, envelope);
        out.ok = !!(res && res.ok);
        out.message = (res && res.message) || '';
        if (res && res.data !== undefined) out.data = res.data;
        if (res && res.query) out.query = true;
      } catch (e) {
        out.ok = false; out.message = 'Executor error: ' + String(e && e.message || e); out.error = 'executor_error';
      }
      out.durationMs = Date.now() - started;
      return out;
    },

    // Build a schema-conformant envelope and execute it.
    dispatch(name, parameters, target, source) {
      var envelope = {
        command: String(name || '').toUpperCase(),
        version: '1.0',
        target: target || null,
        parameters: parameters || {},
        source: source || 'api',
        timestamp: Date.now(),
        requestId: requestId()
      };
      var result = this.executeEnvelope(envelope);
      saveHistory({
        id: result.requestId, time: Date.now(), source: envelope.source,
        envelope: { command: envelope.command, version: envelope.version, target: envelope.target, parameters: parameters || {}, source: envelope.source, timestamp: envelope.timestamp, requestId: envelope.requestId },
        result: { ok: result.ok, message: result.message },
        verified: verify(envelope, result)
      });
      return result;
    },

    // Run a whole @@...@@END script (chat-friendly). Returns array of results.
    runScript(text, source) {
      var parsed = Parser.parse(text);
      var results = [];
      parsed.errors.forEach(function (e) {
        results.push({ ok: false, command: e.command || '?', message: 'Parse error: ' + (e.error || 'invalid') + (e.hint ? ' — ' + e.hint : '') });
      });
      var anyMutation = false;
      parsed.commands.forEach(function (c) {
        var r = this.dispatch(c.command, c.params, null, source || 'script');
        if (r.ok && !Registry.get(c.command).query) anyMutation = true;
        results.push(r);
      }, this);
      if (anyMutation) emitRefresh();
      return results;
    },

    // Direct convenience API: execute one command by name.
    run(name, parameters, target) { return this.dispatch(name, parameters, target, 'api'); },

    query(name, arg) { return QuerySystem.run(name, arg); },

    resolveTarget(spec) { return Resolver.resolve(spec); }
  };

  // Post-execution verification against the Query layer (source of truth).
  function verify(envelope, result) {
    var check = { ok: true, reason: 'read-only or not asserted', targetId: envelope.__beforeTargetId || null };
    if (!result || !result.ok) return { ok: false, reason: 'command reported failure' };
    if (envelope.command.indexOf('QUERY_') === 0) return check;
    var q = QuerySystem.queries, p = envelope.parameters || {};
    function resolveAfter() { return Resolver.resolve(envelope.target, queryScene()); }
    try {
      switch (envelope.command) {
        case 'CREATE_OBJECT':
          if (p.NAME) {
            var c = Resolver.resolve({ name: p.NAME }, queryScene());
            check.ok = !!c.ok; check.reason = c.ok ? 'created object is present in live state' : 'created object not found';
            check.targetId = c.ok ? c.object.id : null;
          } else { check.reason = 'created (auto name not asserted)'; }
          break;
        case 'DELETE_OBJECT': {
          if (envelope.__beforeTargetId) {
            var gone = queryScene().objects.some(function (o) { return o.id === envelope.__beforeTargetId; });
            check.ok = !gone; check.reason = gone ? 'deleted object still exists' : 'object identity is absent';
          } else { check.reason = 'delete without resolvable before-id (not asserted)'; }
          break;
        }
        case 'RENAME_OBJECT': {
          var t = resolveAfter();
          // Identity assertion: the object that existed before the rename must
          // still exist (same id) and carry the new label — this catches
          // "renamed the wrong object" and "renamed a copy" regressions.
          if (envelope.__beforeTargetId) {
            var stillThere = queryScene().objects.some(function (o) { return o.id === envelope.__beforeTargetId; });
            if (!stillThere) { check.ok = false; check.reason = 'renamed object disappeared'; break; }
          }
          check.ok = t.ok && t.object.name === p.NEW_NAME && (!envelope.__beforeTargetId || !envelope.target || !envelope.target.id || t.object.id === envelope.__beforeTargetId);
          check.reason = check.ok ? 'identity retained, label changed' : 'renamed object does not carry the new label';
          break;
        }
        case 'MOVE_OBJECT': case 'ROTATE_OBJECT': case 'SCALE_OBJECT': {
          var t2 = resolveAfter();
          if (!t2.ok) { check.ok = false; check.reason = 'target disappeared'; break; }
          var obj = queryScene().objects.find(function (o) { return o.id === t2.object.id; });
          var same = function (a, b) { return Math.abs((num(a) || 0) - (num(b) || 0)) < 0.0001; };
          var good = true;
          ['position', 'rotation', 'scale'].forEach(function (grp) {
            ['x', 'y', 'z'].forEach(function (ax) {
              if (p[ax.toUpperCase()] !== undefined) good = good && same(obj[grp][ax], p[ax.toUpperCase()]);
            });
          });
          if (p.UNIFORM !== undefined) good = good && same(obj.scale.x, p.UNIFORM) && same(obj.scale.y, p.UNIFORM) && same(obj.scale.z, p.UNIFORM);
          check.ok = good; check.reason = good ? 'live state matches requested transform' : 'live transform does not match request';
          break;
        }
        case 'SELECT_OBJECT': {
          var sel = q.QUERY_SELECTION();
          check.ok = !!(sel.selected && envelope.__beforeTargetId && sel.selected.id === envelope.__beforeTargetId);
          check.reason = check.ok ? 'selection matches request' : 'selection is not the requested object';
          break;
        }
        case 'SET_THEME': { check.ok = q.QUERY_THEME().theme === p.VALUE; check.reason = check.ok ? 'theme matches live state' : 'theme did not persist'; break; }
        case 'SET_LANGUAGE': { check.ok = q.QUERY_LANGUAGE().language === p.VALUE; check.reason = check.ok ? 'language matches live state' : 'language did not persist'; break; }
        case 'SET_CAMERA_FOV': {
          var cam = q.QUERY_CAMERA().camera;
          check.ok = !!(cam && Math.abs(cam.fov - num(p.FOV)) < 0.01);
          check.reason = check.ok ? 'fov matches live camera' : 'fov did not persist';
          break;
        }
        case 'SAVE_PROJECT': {
          var ps = global.CodeHotProjectState;
          check.ok = !!(ps && ps._data && ps._data.timestamp && Date.now() - ps._data.timestamp < 5000);
          check.reason = check.ok ? 'project state timestamp is fresh' : 'project timestamp not updated';
          break;
        }
      }
    } catch (e) { check.ok = false; check.reason = 'verification error: ' + String(e && e.message || e); }
    return check;
  }

  /* ── Expose globals ──────────────────────────────────────────── */
  global.CodeHotCommandProtocol = Protocol;
  global.CodeHotCommandRegistry = Registry;
  global.CodeHotQuerySystem = QuerySystem;
  global.CodeHotEntityResolver = Resolver;
  global.CodeHotCommandHistory = { list: history, clear: function () { try { global.localStorage.removeItem(HISTORY_KEY); } catch (e) {} } };
})(typeof window !== 'undefined' ? window : null);
