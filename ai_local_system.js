    // ── Local AI Intent Parser ──────────────────────────────────────────
    // Handles edit-time state changes locally without external API.
    // Farsi + English natural language → direct state changes.

    class AIIntentParser {
      static INTENTS = {
        MOVE: 'move', ROTATE: 'rotate', SCALE: 'scale',
        RENAME: 'rename', CREATE: 'create', DELETE: 'delete',
        TOGGLE_VISIBLE: 'toggle_visible', SCRIPT: 'script',
        ANIMATION: 'animation', INSPECT: 'inspect', UNKNOWN: 'unknown'
      };

      static extractNumber(text) {
        const num = text.match(/-?\d+(?:\.\d+)?/);
        return num ? parseFloat(num[0]) : null;
      }

      static extractObjectRef(text, sceneObjects) {
        if (!sceneObjects || !sceneObjects.length) return null;
        const lower = text.toLowerCase().trim();
        for (const obj of sceneObjects) {
          if (lower.includes((obj.name || '').toLowerCase())) return obj;
        }
        const faWords = {
          '\u0645\u06a9\u0639\u0628': 'cube', '\u06a9\u0631\u0647': 'sphere',
          '\u0627\u0633\u062a\u0648\u0627\u0646\u0647': 'cylinder', '\u0645\u062e\u0631\u0648\u0637': 'cone',
          '\u0622\u0628\u062c\u06a9\u062a': null, '\u0634\u06cc\u0621': null,
          '\u0627\u06cc\u0646': null, '\u0627\u0648\u0646': null, '\u0645\u062f\u0644': null
        };
        for (const [fa, en] of Object.entries(faWords)) {
          if (lower.includes(fa)) {
            if (en) { const m = sceneObjects.find(o => (o.type||'').toLowerCase() === en); if (m) return m; }
            else {
              const selId = window.CodeHotScene && typeof window.CodeHotScene.getSelectedId === 'function' ? window.CodeHotScene.getSelectedId() : null;
              if (selId) { const s = sceneObjects.find(o => o.id === selId); if (s) return s; }
            }
          }
        }
        for (const obj of sceneObjects) {
          const n = (obj.name || '').toLowerCase();
          if (lower.includes(n.substring(0, 4)) && n.length >= 3) return obj;
        }
        const selId = window.CodeHotScene && typeof window.CodeHotScene.getSelectedId === 'function' ? window.CodeHotScene.getSelectedId() : null;
        return selId ? (sceneObjects.find(o => o.id === selId) || null) : null;
      }

      static recognize(text) {
        const raw = text.trim();
        const normalized = raw.replace(/[\u200c\u200d]/g, ' ').toLowerCase();
        const ctx = typeof ContextExtractor !== 'undefined' ? ContextExtractor.extractScene() : { objects: [] };
        const objs = Array.isArray(ctx.objects) ? ctx.objects : [];

        if (/(\u0686\u06cc\s*\u0647|\u0686\u06cc\u0647|\u0648\u0636\u0639\u06cc\u062a|details?|status|info)/.test(normalized))
          return { intent: this.INTENTS.INSPECT, target: this.extractObjectRef(normalized, objs), params: {} };

        const createMatch = normalized.match(/(\w+)\s+(?:\u0628\u0633\u0627\u0632|\u0627\u06cc\u062c\u0627\u062f|\u0633\u0627\u062e\u062a|create|add|\u0627\u0636\u0627\u0641\u0647\s*\u06a9\u0646)/i);
        if (createMatch) {
          const typeMap = { cube: 'cube', '\u0645\u06a9\u0639\u0628': 'cube', sphere: 'sphere', '\u06a9\u0631\u0647': 'sphere', cylinder: 'cylinder', '\u0627\u0633\u062a\u0648\u0627\u0646\u0647': 'cylinder', cone: 'cone', '\u0645\u062e\u0631\u0648\u0637': 'cone' };
          return { intent: this.INTENTS.CREATE, target: null, params: { type: typeMap[createMatch[1].trim().toLowerCase()] || 'cube' } };
        }

        if (/(\u062d\u0630\u0641|\u067e\u0627\u06a9|remove|delete)/i.test(normalized))
          return { intent: this.INTENTS.DELETE, target: this.extractObjectRef(normalized, objs), params: {} };

        if (/(\u062a\u063a\u06cc\u06cc\u0631\s*\u0627\u0633\u0645|rename|\u0627\u0633\u0645[\s\S]*\u0631\u0648[\s\S]*\u06a9\u0646)/i.test(normalized)) {
          const nameMatch = normalized.match(/(?:\u0628\u0647|to|\u0628\u06a9\u0646)\s+(\S+)/i);
          return { intent: this.INTENTS.RENAME, target: this.extractObjectRef(normalized, objs), params: { newName: nameMatch ? nameMatch[1] : null } };
        }

        if (/(\u0645\u062e\u0641\u06cc|\u067e\u0646\u0647\u0627\u0646|hide|show|\u0646\u0645\u0627\u06cc\u0627\u0646|visible)/i.test(normalized))
          return { intent: this.INTENTS.TOGGLE_VISIBLE, target: this.extractObjectRef(normalized, objs), params: {} };

        const animMatch = normalized.match(/(?:\u0627\u0646\u06cc\u0645\u06cc\u0634\u0646|animation|anim)\s*(?:\u0631\u0648\s*)?(?:\u0627\u062c\u0631\u0627|\u067e\u062e\u0634|play|start|run)\s*(?:"([^"]+)"|(\S+))?/i);
        if (animMatch)
          return { intent: this.INTENTS.ANIMATION, target: this.extractObjectRef(normalized, objs), params: { clipName: animMatch[1] || animMatch[2], action: 'play' } };

        if (/(\u0642\u0648\u0646\u062a\u06cc|\u0632\u0645\u0627\u0646\u06cc\s*\u06a9\u0647|when|runtime|\u0648\u0642\u062a\u06cc\s*\u0634\u0631\u0648\u0639|\u0634\u0631\u0648\u0639\s*\u0634\u062f)/.test(normalized))
          return { intent: this.INTENTS.SCRIPT, target: this.extractObjectRef(normalized, objs), params: { description: raw } };

        const hasMoveWord = /(\u0628\u0630\u0627\u0631|\u0628\u06af\u0630\u0627\u0631|\u0628\u0628\u0631|\u0628\u06a9\u0634|\u0642\u0631\u0627\u0631\u0647|move|set|place|put|\u0628\u0647|\u0631\u0648\u06cc)/i.test(normalized);
        const hasAxis = /[xyz][=:\s]*-?\d/.test(normalized);
        const hasDir = /(\u0628\u0627\u0644\u0627|\u067e\u0627\u06cc\u06cc\u0646|\u0686\u067e|\u0631\u0627\u0633\u062a|\u062c\u0644\u0648|\u0639\u0642\u0628|up|down|left|right|forward|back)/i.test(normalized);
        if (hasMoveWord && (hasAxis || hasDir)) {
          const target = this.extractObjectRef(normalized, objs);
          const params = { x: null, y: null, z: null };
          const xM = normalized.match(/x[=:\s]*(-?\d+(?:\.\d+)?)/);
          const yM = normalized.match(/y[=:\s]*(-?\d+(?:\.\d+)?)/);
          const zM = normalized.match(/z[=:\s]*(-?\d+(?:\.\d+)?)/);
          if (xM) params.x = parseFloat(xM[1]);
          if (yM) params.y = parseFloat(yM[1]);
          if (zM) params.z = parseFloat(zM[1]);
          if (hasDir && params.x === null && params.y === null && params.z === null) {
            const amt = this.extractNumber(normalized) || 5;
            const dirMatch = normalized.match(/(\u0628\u0627\u0644\u0627|\u067e\u0627\u06cc\u06cc\u0646|\u0686\u067e|\u0631\u0627\u0633\u062a|\u062c\u0644\u0648|\u0639\u0642\u0628|up|down|left|right|forward|back)/i);
            if (dirMatch) {
              const d = dirMatch[1].toLowerCase();
              if (/(\u0628\u0627\u0644\u0627|up)/.test(d)) params.y = (target ? target.position.y : 0) + amt;
              else if (/(\u067e\u0627\u06cc\u06cc\u0646|down)/.test(d)) params.y = (target ? target.position.y : 0) - amt;
              else if (/(\u0686\u067e|left)/.test(d)) params.x = (target ? target.position.x : 0) - amt;
              else if (/(\u0631\u0627\u0633\u062a|right)/.test(d)) params.x = (target ? target.position.x : 0) + amt;
              else if (/(\u062c\u0644\u0648|forward)/.test(d)) params.z = (target ? target.position.z : 0) - amt;
              else if (/(\u0639\u0642\u0628|back)/.test(d)) params.z = (target ? target.position.z : 0) + amt;
            }
          }
          return { intent: this.INTENTS.MOVE, target, params };
        }

        if (/(\u0628\u0686\u0631\u062e\u0648\u0646|\u0686\u0631\u062e\u0634|rotate|turn|spin)/i.test(normalized)) {
          const target = this.extractObjectRef(normalized, objs);
          const amt = this.extractNumber(normalized) || 45;
          return { intent: this.INTENTS.ROTATE, target, params: { x: null, y: amt, z: null } };
        }

        if (/(\u0628\u0632\u0631\u06af|\u06a9\u0648\u0686\u06a9|scale|resize|bigger|smaller|\u062f\u0648\u0628\u0647\u0631|\u0646\u0635\u0641)/i.test(normalized)) {
          const target = this.extractObjectRef(normalized, objs);
          let factor = this.extractNumber(normalized);
          if (/(\u0628\u0632\u0631\u06af|bigger|\u062f\u0648\u0628\u0647\u0631)/.test(normalized)) factor = factor || 2;
          else if (/(\u06a9\u0648\u0686\u06a9|smaller|\u0646\u0635\u0641)/.test(normalized)) factor = factor || 0.5;
          else factor = factor || 2;
          return { intent: this.INTENTS.SCALE, target, params: { factor } };
        }

        return { intent: this.INTENTS.UNKNOWN, target: null, params: { description: raw } };
      }
    }

    // ── Local AI State Executor ─────────────────────────────────────────

    class AIStateExecutor {
      static findSceneObject(id) { return SCENE_STATE.objects.find(o => o.id === id) || null; }
      static findMesh(id) {
        try {
          const mgr = window._sceneEditorManager || null;
          if (mgr && mgr.scene) return mgr.scene.children.find(c => c.userData && c.userData.id === id) || null;
        } catch(e) {}
        return null;
      }
      static commitUndo(desc) {
        try { const mgr = window._sceneEditorManager || null; if (mgr && typeof mgr.pushUndoState === 'function') mgr.pushUndoState(); } catch(e) {}
        try { window.CodeHotEventBus && window.CodeHotEventBus.emit('scene:objectModified', { description: desc }); } catch(e) {}
      }
      static commitToStorage() {
        try { const mgr = window._sceneEditorManager || null; if (mgr && typeof mgr.saveToStorage === 'function') mgr.saveToStorage(); if (mgr && typeof mgr.updateHierarchy === 'function') mgr.updateHierarchy(); } catch(e) {}
        try { if (typeof HierarchyManager !== 'undefined') HierarchyManager.loadFromScene(); } catch(e) {}
      }
      static execute(parsed) {
        if (!parsed || parsed.intent === 'unknown') return null;
        const h = {
          move: () => this.execMove(parsed), rotate: () => this.execRotate(parsed),
          scale: () => this.execScale(parsed), rename: () => this.execRename(parsed),
          create: () => this.execCreate(parsed), delete: () => this.execDelete(parsed),
          toggle_visible: () => this.execToggleVisible(parsed), animation: () => this.execAnimation(parsed),
          inspect: () => this.execInspect(parsed), script: () => this.execScriptHint(parsed)
        };
        const handler = h[parsed.intent];
        return handler ? handler() : null;
      }
      static execMove(p) {
        const t = p.target;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u0628\u0631\u0627\u06cc \u062c\u0627\u0628\u0647\u0621\u062c\u0627\u06cc\u06cc \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        const obj = this.findSceneObject(t.id);
        if (!obj) return { ok: false, message: t.name + ' \u062f\u0631 Scene \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        this.commitUndo('Move ' + t.name);
        const { x, y, z } = p.params;
        if (x !== null && x !== undefined) obj.position.x = x;
        if (y !== null && y !== undefined) obj.position.y = y;
        if (z !== null && z !== undefined) obj.position.z = z;
        const mesh = this.findMesh(t.id);
        if (mesh) mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
        this.commitToStorage();
        return { ok: true, message: '\u2705 ' + t.name + ' \u0628\u0647 X:' + obj.position.x.toFixed(1) + ' Y:' + obj.position.y.toFixed(1) + ' Z:' + obj.position.z.toFixed(1) + ' \u0645\u0646\u062a\u0642\u0644 \u0634\u062f.' };
      }
      static execRotate(p) {
        const t = p.target;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u0628\u0631\u0627\u06cc \u0686\u0631\u062e\u0634 \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        const obj = this.findSceneObject(t.id);
        if (!obj) return { ok: false, message: t.name + ' \u062f\u0631 Scene \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        this.commitUndo('Rotate ' + t.name);
        const { x, y, z } = p.params;
        if (x !== null && x !== undefined) obj.rotation.x += x;
        if (y !== null && y !== undefined) obj.rotation.y += y;
        if (z !== null && z !== undefined) obj.rotation.z += z;
        const mesh = this.findMesh(t.id);
        if (mesh) mesh.rotation.set(THREE.MathUtils.degToRad(obj.rotation.x), THREE.MathUtils.degToRad(obj.rotation.y), THREE.MathUtils.degToRad(obj.rotation.z));
        this.commitToStorage();
        return { ok: true, message: '\u2705 ' + t.name + ' \u0686\u0631\u062e\u0627\u0646\u062f\u0647 \u0634\u062f.' };
      }
      static execScale(p) {
        const t = p.target;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u0628\u0631\u0627\u06cc \u062a\u063a\u06cc\u06cc\u0631 \u0627\u0646\u062f\u0627\u0632\u0647 \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        const obj = this.findSceneObject(t.id);
        if (!obj) return { ok: false, message: t.name + ' \u062f\u0631 Scene \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        this.commitUndo('Scale ' + t.name);
        const f = p.params.factor || 2;
        obj.scale.x *= f; obj.scale.y *= f; obj.scale.z *= f;
        const mesh = this.findMesh(t.id);
        if (mesh) mesh.scale.set(obj.scale.x, obj.scale.y, obj.scale.z);
        this.commitToStorage();
        return { ok: true, message: '\u2705 ' + t.name + ' ' + (f > 1 ? '\u0628\u0632\u0631\u06af\u062a\u0631' : '\u06a9\u0648\u0686\u06a9\u062a\u0631') + ' \u0634\u062f (' + f + 'x).' };
      }
      static execRename(p) {
        const t = p.target; const newName = p.params.newName;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u0628\u0631\u0627\u06cc \u062a\u063a\u06cc\u06cc\u0631 \u0627\u0633\u0645 \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        if (!newName) return { ok: false, message: '\u0627\u0633\u0645 \u062c\u062f\u06cc\u062f \u0645\u0634\u062e\u0635 \u0646\u0634\u062f.' };
        const obj = this.findSceneObject(t.id);
        if (!obj) return { ok: false, message: t.name + ' \u062f\u0631 Scene \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        this.commitUndo('Rename ' + t.name);
        const oldName = obj.name; obj.name = newName;
        const mesh = this.findMesh(t.id);
        if (mesh && mesh.userData) mesh.userData.name = newName;
        this.commitToStorage();
        try { window.CodeHotEventBus && window.CodeHotEventBus.emit('scene:objectRenamed', { id: t.id, oldName, newName }); } catch(e) {}
        return { ok: true, message: '\u2705 "' + oldName + '" \u0628\u0647 "' + newName + '" \u062a\u063a\u06cc\u06cc\u0631 \u0646\u0627\u0645 \u062f\u0627\u062f\u0647 \u0634\u062f.' };
      }
      static execCreate(p) {
        try {
          const mgr = window._sceneEditorManager || null;
          if (mgr && typeof mgr.addObject === 'function') { mgr.addObject(p.params.type); return { ok: true, message: '\u2705 ' + p.params.type + ' \u062f\u0631 Scene \u0627\u06cc\u062c\u0627\u062f \u0634\u062f.' }; }
          return { ok: false, message: 'Scene Manager \u062f\u0631 \u062f\u0633\u062a\u0631\u0633 \u0646\u06cc\u0633\u062f.' };
        } catch(e) { return { ok: false, message: '\u062e\u0637\u0627: ' + (e.message || e) }; }
      }
      static execDelete(p) {
        const t = p.target;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u0628\u0631\u0627\u06cc \u062d\u0630\u0641 \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        const obj = this.findSceneObject(t.id);
        if (!obj) return { ok: false, message: t.name + ' \u062f\u0631 Scene \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        this.commitUndo('Delete ' + t.name);
        const mesh = this.findMesh(t.id);
        if (mesh) { const mgr = window._sceneEditorManager || null; if (mgr && mgr.scene) mgr.scene.remove(mesh); try { if (mesh.geometry) mesh.geometry.dispose(); if (mesh.material) mesh.material.dispose(); } catch(e) {} }
        SCENE_STATE.objects = SCENE_STATE.objects.filter(o => o.id !== t.id);
        if (SCENE_STATE.selectedId === t.id) SCENE_STATE.selectedId = null;
        this.commitToStorage();
        return { ok: true, message: '\u2705 ' + t.name + ' \u0627\u0632 Scene \u062d\u0630\u0641 \u0634\u062f.' };
      }
      static execToggleVisible(p) {
        const t = p.target;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        const obj = this.findSceneObject(t.id);
        if (!obj) return { ok: false, message: t.name + ' \u062f\u0631 Scene \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        this.commitUndo('Toggle ' + t.name);
        obj.visible = !obj.visible;
        const mesh = this.findMesh(t.id); if (mesh) mesh.visible = obj.visible;
        this.commitToStorage();
        return { ok: true, message: '\u2705 ' + t.name + ' ' + (obj.visible ? '\u0646\u0645\u0627\u06cc\u0627\u0646 \u0634\u062f' : '\u0645\u062e\u0641\u06cc \u0634\u062f') + '.' };
      }
      static execAnimation(p) {
        const t = p.target; const animName = p.params.clipName; const action = p.params.action;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        const rtState = window.CodeHotScene && typeof window.CodeHotScene.getRuntimeState === 'function' ? window.CodeHotScene.getRuntimeState() : null;
        if (!rtState || !rtState.isPlaying) {
          if (action === 'play') {
            const script = 'return {\n  start(ctx, self) { self.animation.play("' + (animName || 'Idle') + '"); },\n  update(ctx, self) {},\n  stop(ctx, self) { self.animation.stop(); }\n};';
            return { ok: true, message: '\ud83c\udfac \u0627\u0646\u06cc\u0645\u06cc\u0634\u0646 "' + (animName || 'Idle') + '" \u0628\u0627\u06cc\u062f \u062f\u0631 \u062d\u0627\u0644\u062a Play \u0627\u062c\u0631\u0627 \u0634\u0648\u062f. \u0633\u06a9\u0631\u06cc\u067e\u062a ' + t.name + ' \u0633\u0627\u062e\u062a\u0647 \u0634\u062f.', action: 'script', script, target: t };
          }
          return { ok: false, message: 'Runtime \u062f\u0631 \u062d\u0627\u0644\u062a Play \u0646\u06cc\u0633\u062f.' };
        }
        try {
          const rt = window._codeHotRuntime || window.CodeHotRuntime;
          if (rt && typeof rt.getObject === 'function') {
            const api = rt.getObject(t.id);
            if (api && api.animation) {
              if (action === 'play') { if (api.animation.play(animName)) return { ok: true, message: '\ud83c\udfac \u0627\u0646\u06cc\u0645\u06cc\u0634\u0646 "' + animName + '" \u0634\u0631\u0648\u0639 \u0634\u062f.' }; return { ok: false, message: '\u0627\u0646\u06cc\u0645\u06cc\u0634\u0646 "' + animName + '" \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' }; }
              else { api.animation.stop(); return { ok: true, message: '\u23f9\ufe0f \u0627\u0646\u06cc\u0645\u06cc\u0634\u0646 \u0645\u062a\u0648\u0642\u0641 \u0634\u062f.' }; }
            }
          }
          return { ok: false, message: 'Runtime API \u062f\u0631 \u062f\u0633\u062a\u0631\u0633 \u0646\u06cc\u0633\u062f.' };
        } catch(e) { return { ok: false, message: '\u062e\u0637\u0627: ' + (e.message || e) }; }
      }
      static execInspect(p) {
        const t = p.target;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        const obj = this.findSceneObject(t.id);
        if (!obj) return { ok: false, message: t.name + ' \u062f\u0631 Scene \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        let scriptInfo = '\u0646\u062f\u0627\u0631\u062f';
        try { const b = window.CodeHotScriptStore && typeof window.CodeHotScriptStore.getAll === 'function' ? window.CodeHotScriptStore.getAll(SCENE_STATE.objects) : {}; if (b && b[t.id] && b[t.id].code) scriptInfo = '\u062f\u0627\u0631\u062f'; } catch(e) {}
        return { ok: true, message: '\ud83d\udccb **' + t.name + '**\nType: ' + t.type + '\nPosition: X:' + obj.position.x.toFixed(1) + ' Y:' + obj.position.y.toFixed(1) + ' Z:' + obj.position.z.toFixed(1) + '\nRotation: X:' + obj.rotation.x.toFixed(1) + '\u00b0 Y:' + obj.rotation.y.toFixed(1) + '\u00b0 Z:' + obj.rotation.z.toFixed(1) + '\nScale: X:' + obj.scale.x.toFixed(1) + ' Y:' + obj.scale.y.toFixed(1) + ' Z:' + obj.scale.z.toFixed(1) + '\nVisible: ' + obj.visible + '\nScript: ' + scriptInfo };
      }
      static execScriptHint(p) {
        const t = p.target;
        if (!t) return { ok: false, message: '\u0622\u0628\u062c\u06a9\u062a\u06cc \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.' };
        return { ok: true, message: '\ud83d\udcdd \u062f\u0631\u062e\u0634\u062a Runtime \u0628\u0631\u0627\u06cc ' + t.name + ' \u0634\u0646\u0627\u062e\u062a\u0647 \u0634\u062f.', action: 'need_api', target: t, description: p.params.description };
      }
    }
