/* CodeHot Agent Protocol V13
 * Compatibility boundary around the existing live CodeHot agent.
 * It does not invent entities and it never uses a display name as identity.
 */
(function (global) {
  'use strict';
  if (!global || !global.CodeHotAgent) return;

  var agent = global.CodeHotAgent;
  var originalProcess = agent.processRequest;
  var originalPlan = agent.plan;
  var HISTORY_KEY = 'codehot-agent-history';
  var HISTORY_LIMIT = 100;

  function copy(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
  }
  function safeArray(value) { return Array.isArray(value) ? value : []; }
  function num(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function same(a, b) { return a === b || (num(a) !== null && num(b) !== null && Math.abs(a - b) < 0.0001); }
  function stateObjects() {
    var data = null;
    try {
      if (global.CodeHotScene && typeof global.CodeHotScene.getSceneData === 'function') data = global.CodeHotScene.getSceneData();
    } catch (e) {}
    if (!data && global.SCENE_STATE) data = global.SCENE_STATE;
    return data || { objects: [], selectedId: null };
  }
  function readScripts() {
    try { return JSON.parse(global.localStorage.getItem('codehot-script-bindings') || '{}') || {}; } catch (e) { return {}; }
  }
  function readAssets() {
    try {
      if (global.CodeHotAssets && typeof global.CodeHotAssets.getAll === 'function') return copy(global.CodeHotAssets.getAll()) || [];
    } catch (e) {}
    try {
      var raw = global.localStorage.getItem('codehot-assets');
      var parsed = raw ? JSON.parse(raw) : [];
      return safeArray(parsed && parsed.assets ? parsed.assets : parsed);
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
        var value = global.CodeHotScene.getRuntimeState();
        if (value) return { isPlaying: !!value.isPlaying, isPaused: !!value.isPaused, state: value.state || null };
      }
    } catch (e) {}
    return { isPlaying: false, isPaused: false, state: 'editor' };
  }
  function query() {
    var scene = stateObjects();
    var objects = safeArray(scene.objects).map(function (object) {
      var scripts = readScripts();
      var animations = readAnimations().filter(function (animation) {
        return safeArray(animation.linkedObjectIds).indexOf(object.id) !== -1 || animation.sourceObjectId === object.id;
      });
      return {
        id: object.id,
        name: object.name,
        type: object.type,
        parentId: object.parentId || null,
        position: copy(object.position) || { x: 0, y: 0, z: 0 },
        rotation: copy(object.rotation) || { x: 0, y: 0, z: 0 },
        scale: copy(object.scale) || { x: 1, y: 1, z: 1 },
        visible: object.visible !== false,
        enabled: object.enabled !== false,
        assetId: object.assetId || null,
        hasScript: !!(scripts[object.id] && scripts[object.id].code),
        script: scripts[object.id] ? { objectName: scripts[object.id].objectName || object.name, code: scripts[object.id].code || '' } : null,
        animations: animations.map(function (animation) { return { id: animation.id, name: animation.name, clipName: animation.clipName || null, duration: animation.duration || 0, loop: animation.loop !== false }; })
      };
    });
    var selectedId = scene.selectedId || null;
    var assets = readAssets().map(function (asset) { return { id: asset.id, name: asset.name, type: asset.type, payloadKey: asset.payloadKey || null, linkedObjectIds: safeArray(asset.linkedObjectIds).slice() }; });
    return {
      version: 'codehot-agent-context-v13',
      scene: { id: 'codehot-scene', name: 'Main Scene', selectedId: selectedId, objects: objects },
      selection: selectedId ? objects.find(function (object) { return object.id === selectedId; }) || null : null,
      assets: assets,
      animations: readAnimations().map(function (animation) { return { id: animation.id, name: animation.name, sourceObjectId: animation.sourceObjectId || null, linkedObjectIds: safeArray(animation.linkedObjectIds).slice(), duration: animation.duration || 0 }; }),
      runtime: runtimeState(),
      settings: (function () { try { return copy(JSON.parse(global.localStorage.getItem('codehot-settings') || '{}')) || {}; } catch (e) { return {}; } }()),
      capabilities: capabilities()
    };
  }
  function capabilities() {
    var scene = global.CodeHotScene || {};
    var tools = global.CodeHotTools || {};
    return {
      query: ['scene', 'selection', 'assets', 'animations', 'scripts', 'runtime', 'settings'],
      commands: Object.keys(tools),
      officialSceneApi: ['getSceneData', 'selectObject', 'deleteObject', 'addModelAsset', 'saveToStorage'].filter(function (name) { return typeof scene[name] === 'function'; }),
      officialRuntimeApi: ['start', 'pause', 'resume', 'stop', 'reload', 'getObject'].filter(function (name) { return global.CodeHotRuntime && typeof global.CodeHotRuntime[name] === 'function'; }),
      identity: 'object.id'
    };
  }
  function findObject(snapshot, id) { return snapshot.scene.objects.find(function (object) { return object.id === id; }) || null; }
  function mutation(plan) { return !!(plan && ['create', 'delete', 'rename', 'transform', 'visibility', 'select', 'animation', 'animation_stop', 'camera', 'camera_follow', 'behavior', 'script'].indexOf(plan.intent) !== -1); }
  function verify(plan, before, after, result) {
    var check = { ok: true, reason: 'read-only or no deterministic assertion', targetId: plan && plan.target ? plan.target.id : null };
    if (!mutation(plan)) return check;
    if (!result || /^(?:⚠️|خطای|Internal error)/.test(String(result))) return { ok: false, reason: 'agent reported failure', targetId: check.targetId };
    var params = plan.params || {};
    var target = params.id ? findObject(after, params.id) : null;
    if (plan.intent === 'create') {
      check.ok = after.scene.objects.length === before.scene.objects.length + 1;
      if (params.name) check.ok = check.ok && !!after.scene.objects.find(function (object) { return object.name === params.name; });
      check.reason = check.ok ? 'created object is present' : 'created object was not found after execution';
    } else if (plan.intent === 'delete') {
      check.ok = !target;
      check.reason = check.ok ? 'object identity is absent' : 'deleted object still exists';
    } else if (plan.intent === 'rename') {
      check.ok = !!target && target.name === params.newName;
      check.reason = check.ok ? 'identity retained and label changed' : 'renamed object does not match requested label';
    } else if (plan.intent === 'transform') {
      var change = params.change || {};
      check.ok = !!target;
      ['position', 'rotation', 'scale'].forEach(function (key) {
        if (change[key]) Object.keys(change[key]).forEach(function (axis) { check.ok = check.ok && same(target[key] && target[key][axis], change[key][axis]); });
      });
      check.reason = check.ok ? 'live state matches requested transform' : 'live state does not match requested transform';
    } else if (plan.intent === 'visibility') {
      check.ok = !!target && target.visible === !!params.visible;
      check.reason = check.ok ? 'visibility matches live state' : 'visibility did not persist';
    } else if (plan.intent === 'script' || plan.intent === 'behavior') {
      check.ok = !!target && target.hasScript;
      check.reason = check.ok ? 'script binding is present for the same object id' : 'script binding is missing';
    } else if (plan.intent === 'animation' || plan.intent === 'animation_stop') {
      check.ok = !!target;
      check.reason = check.ok ? 'animation target identity remains present' : 'animation target disappeared';
    }
    return check;
  }
  function history() { try { return safeArray(JSON.parse(global.localStorage.getItem(HISTORY_KEY) || '[]')); } catch (e) { return []; } }
  function saveHistory(entry) { try { global.localStorage.setItem(HISTORY_KEY, JSON.stringify(history().concat(entry).slice(-HISTORY_LIMIT))); } catch (e) {} }
  function refresh() { try { if (global.CodeHotEventBus && typeof global.CodeHotEventBus.emit === 'function') global.CodeHotEventBus.emit('ui:refresh'); } catch (e) {} }
  function recover() {
    try {
      if (global.CodeHotCommandManager && typeof global.CodeHotCommandManager.undo === 'function') { global.CodeHotCommandManager.undo(); refresh(); return true; }
    } catch (e) {}
    return false;
  }

  var protocol = {
    version: '13.0.0',
    query: query,
    capabilities: capabilities,
    history: history,
    clearHistory: function () { try { global.localStorage.removeItem(HISTORY_KEY); } catch (e) {} },
    resolveTarget: function (text) {
      var snapshot = query();
      try {
        if (global.AIContext && typeof global.AIContext.resolveTarget === 'function') return global.AIContext.resolveTarget(text, { objects: snapshot.scene.objects, selected: snapshot.selection, selectedId: snapshot.scene.selectedId, lastTargets: [] });
      } catch (e) {}
      return null;
    },
    async execute(text) { return agent.processRequest(text); }
  };

  agent.processRequest = async function (text) {
    var before = query();
    var plan = null;
    try { plan = typeof originalPlan === 'function' ? originalPlan.call(agent, String(text), (global.AIContext && global.AIContext.getSnapshot ? global.AIContext.getSnapshot() : before)) : null; } catch (e) {}
    var response = await originalProcess.call(agent, text);
    var after = query();
    var verification = verify(plan, before, after, response);
    var recovered = false;
    if (!verification.ok && mutation(plan) && !/^(?:⚠️|خطای|Internal error)/.test(String(response))) recovered = recover();
    saveHistory({ id: 'agent_' + Date.now().toString(36), time: Date.now(), request: String(text), plan: plan ? { intent: plan.intent, tool: plan.tool, targetId: plan.target && plan.target.id || null, params: copy(plan.params) } : null, before: before, after: query(), response: String(response), verification: verification, recovered: recovered });
    if (!verification.ok && !/^(?:⚠️|خطای|Internal error)/.test(String(response))) return String(response) + '\n⚠️ Verify: ' + verification.reason + (recovered ? ' ' + 'تغییر نامعتبر برگشت داده شد.' : '');
    return response;
  };
  protocol.execute = function (text) { return agent.processRequest(text); };
  global.CodeHotAgentProtocol = protocol;
  global.CodeHotQuery = { snapshot: query, capabilities: capabilities, resolveTarget: protocol.resolveTarget };
  global.CodeHotAgentHistory = { list: history, clear: protocol.clearHistory };
})(typeof window !== 'undefined' ? window : null);
